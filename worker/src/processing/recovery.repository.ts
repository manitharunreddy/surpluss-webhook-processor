import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { WebhookEvent } from './types/webhook-event.types';

@Injectable()
export class RecoveryRepository {
  async recoverInterruptedEvents(
    client: PoolClient,
    maxAttempts: number,
    calculateRetryDelay: (attempt: number) => number,
  ): Promise<number> {
    let recoveredCount = 0;
    let lastId = '0';

    while (true) {
      // Scan processing events in batches.
      const candidates = await client.query<{ id: string }>(
        `
        SELECT id
        FROM webhook_events
        WHERE status = 'processing'
          AND id > $1::bigint
        ORDER BY id
        LIMIT 100
        `,
        [lastId],
      );

      if (candidates.rows.length === 0) {
        break;
      }

      for (const candidate of candidates.rows) {
        lastId = candidate.id;

        const recovered = await this.recoverEvent(
          client,
          candidate.id,
          maxAttempts,
          calculateRetryDelay,
        );

        if (recovered) {
          recoveredCount++;
        }
      }
    }

    return recoveredCount;
  }

  private async recoverEvent(
    client: PoolClient,
    eventId: string,
    maxAttempts: number,
    calculateRetryDelay: (attempt: number) => number,
  ): Promise<boolean> {
    // Check whether another worker still owns this event.
    const lock = await client.query<{ acquired: boolean }>(
      `
      SELECT pg_try_advisory_lock($1::bigint) AS acquired
      `,
      [eventId],
    );

    if (!lock.rows[0].acquired) {
      return false;
    }

    try {
      await client.query('BEGIN');

      // Recheck status after acquiring exclusive ownership.
      const result = await client.query<WebhookEvent>(
        `
        SELECT *
        FROM webhook_events
        WHERE id = $1
          AND status = 'processing'
        FOR UPDATE
        `,
        [eventId],
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return false;
      }

      const event = result.rows[0];

      const errorMessage = `Processing interrupted: worker ${event.claimed_by} lost ownership`;

      const exhausted = event.cycle_attempt_count >= maxAttempts;

      const status = exhausted ? 'permanently_failed' : 'retry_scheduled';

      const retryDelayMs = calculateRetryDelay(event.cycle_attempt_count);

      // Mark the previous attempt as interrupted.
      const attempt = await client.query(
        `
        UPDATE processing_attempts
        SET
          result = 'interrupted',
          finished_at = NOW(),
          error = $3
        WHERE webhook_event_id = $1
          AND attempt_number = $2
          AND result = 'running'
        `,
        [event.id, event.attempt_count, errorMessage],
      );

      if (attempt.rowCount !== 1) {
        throw new Error(
          `Running attempt not found for event ${event.event_id}`,
        );
      }

      // Schedule another attempt or mark permanently failed.
      await client.query(
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
        `,
        [event.id, status, errorMessage, retryDelayMs],
      );

      await client.query('COMMIT');

      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      const unlocked = await client.query<{
        released: boolean;
      }>(
        `
        SELECT pg_advisory_unlock($1::bigint) AS released
        `,
        [eventId],
      );

      if (!unlocked.rows[0].released) {
        throw new Error(`Failed to release recovery lock for event ${eventId}`);
      }
    }
  }
}
