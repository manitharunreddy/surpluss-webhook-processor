import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { WebhookEvent } from './types/webhook-event.types';

@Injectable()
export class ProcessingRepository {
  // Claim the next available event
  async claimNextEvent(
    client: PoolClient,
    workerId: string,
    maxAttempts: number,
  ): Promise<WebhookEvent | null> {
    let lockedEventId: string | null = null;

    try {
      await client.query('BEGIN');

      const result = await client.query<WebhookEvent>(
        `
        SELECT *
        FROM webhook_events
        WHERE status IN ('pending', 'retry_scheduled')
          AND next_attempt_at <= NOW()
          AND cycle_attempt_count < $1
        ORDER BY next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
        [maxAttempts],
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const event = result.rows[0];

      const lockResult = await client.query<{ acquired: boolean }>(
        `
        SELECT pg_try_advisory_lock($1::bigint) AS acquired
        `,
        [event.id],
      );

      if (!lockResult.rows[0].acquired) {
        await client.query('ROLLBACK');
        return null;
      }

      lockedEventId = event.id;

      const claimedResult = await client.query<WebhookEvent>(
        `
        UPDATE webhook_events
        SET
          status = 'processing',
          attempt_count = attempt_count + 1,
          cycle_attempt_count = cycle_attempt_count + 1,
          claimed_by = $2,
          claimed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [event.id, workerId],
      );

      const claimedEvent = claimedResult.rows[0];

      await client.query(
        `
        INSERT INTO processing_attempts (
          webhook_event_id,
          attempt_number,
          worker_id
        )
        VALUES ($1, $2, $3)
        `,
        [claimedEvent.id, claimedEvent.attempt_count, workerId],
      );

      await client.query('COMMIT');

      return claimedEvent;
    } catch (error) {
      await client.query('ROLLBACK');

      if (lockedEventId !== null) {
        await this.releaseEventLock(client, lockedEventId);
      }

      throw error;
    }
  }

  // Complete the business action and mark the event as succeeded
  async completeEvent(
    client: PoolClient,
    event: WebhookEvent,
    orderId: string,
  ): Promise<void> {
    try {
      await client.query('BEGIN');

      // Verify that this attempt still owns the event.
      const updated = await client.query(
        `
        UPDATE webhook_events
        SET
          status = 'succeeded',
          claimed_by = NULL,
          claimed_at = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND attempt_count = $2
          AND claimed_by = $3
        `,
        [event.id, event.attempt_count, event.claimed_by],
      );

      if (updated.rowCount !== 1) {
        throw new Error('Event ownership verification failed');
      }

      // Actual business action
      await client.query(
        `
        INSERT INTO processed_orders (
          event_id,
          order_id
        )
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO NOTHING
        `,
        [event.event_id, orderId],
      );

      // Complete the attempt history
      const attempt = await client.query(
        `
        UPDATE processing_attempts
        SET
          result = 'succeeded',
          finished_at = NOW(),
          error = NULL
        WHERE webhook_event_id = $1
          AND attempt_number = $2
          AND result = 'running'
        `,
        [event.id, event.attempt_count],
      );

      if (attempt.rowCount !== 1) {
        throw new Error('Running attempt not found');
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  // Record failure and schedule a retry if attempts remain
  async failEvent(
    client: PoolClient,
    event: WebhookEvent,
    errorMessage: string,
    maxAttempts: number,
    retryDelayMs: number,
  ): Promise<void> {
    const exhausted = event.cycle_attempt_count >= maxAttempts;

    const status = exhausted ? 'permanently_failed' : 'retry_scheduled';

    try {
      await client.query('BEGIN');

      const updated = await client.query(
        `
        UPDATE webhook_events
        SET
          status = $2,
          last_error = $3,
          next_attempt_at = CASE
            WHEN $2 = 'retry_scheduled'
            THEN NOW() + ($4::bigint * INTERVAL '1 millisecond')
            ELSE next_attempt_at
          END,
          claimed_by = NULL,
          claimed_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND attempt_count = $5
          AND claimed_by = $6
        `,
        [
          event.id,
          status,
          errorMessage,
          retryDelayMs,
          event.attempt_count,
          event.claimed_by,
        ],
      );

      if (updated.rowCount !== 1) {
        throw new Error('Event ownership verification failed');
      }

      const attempt = await client.query(
        `
        UPDATE processing_attempts
        SET
          result = 'failed',
          finished_at = NOW(),
          error = $3
        WHERE webhook_event_id = $1
          AND attempt_number = $2
          AND result = 'running'
        `,
        [event.id, event.attempt_count, errorMessage],
      );

      if (attempt.rowCount !== 1) {
        throw new Error('Running attempt not found');
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  // Release the session-level advisory lock
  async releaseEventLock(client: PoolClient, eventId: string): Promise<void> {
    const result = await client.query<{ released: boolean }>(
      `
      SELECT pg_advisory_unlock($1::bigint) AS released
      `,
      [eventId],
    );

    if (!result.rows[0].released) {
      throw new Error(`Advisory lock not held for event ${eventId}`);
    }
  }
}
