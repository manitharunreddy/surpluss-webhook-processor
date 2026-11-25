import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@Injectable()
export class WebhooksService {
  constructor(private readonly databaseService: DatabaseService) {}

  // Accept webhook and ignore duplicate deliveries
  async createEvent(
    dto: CreateWebhookDto,
  ): Promise<{ eventId: string; accepted: boolean }> {
    await this.databaseService.query(
      `
      INSERT INTO webhook_events (event_id, type, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (event_id) DO NOTHING
      `,
      [dto.eventId, dto.type, JSON.stringify(dto.data)],
    );

    return {
      eventId: dto.eventId,
      accepted: true,
    };
  }

  // Get all received webhook events
  async getEvents() {
    const result = await this.databaseService.query(
      `
      SELECT *
      FROM webhook_events
      ORDER BY created_at DESC, id DESC
      `,
    );

    return result.rows;
  }

  // Get individual webhook details
  async getEvent(eventId: string) {
    const result = await this.databaseService.query(
      `
      SELECT *
      FROM webhook_events
      WHERE event_id = $1
      `,
      [eventId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('Webhook event not found');
    }

    return result.rows[0];
  }

  // Get complete processing attempt history
  async getAttempts(eventId: string) {
    await this.getEvent(eventId);

    const result = await this.databaseService.query(
      `
      SELECT
        p.id,
        w.event_id,
        p.attempt_number,
        p.worker_id,
        p.started_at,
        p.finished_at,
        p.result,
        p.error
      FROM processing_attempts p
      JOIN webhook_events w
        ON w.id = p.webhook_event_id
      WHERE w.event_id = $1
      ORDER BY p.attempt_number DESC
      `,
      [eventId],
    );

    return result.rows;
  }

  // Manually retry a permanently failed event
  async retryEvent(eventId: string) {
    const result = await this.databaseService.query(
      `
      UPDATE webhook_events
      SET
        status = 'pending',
        cycle_attempt_count = 0,
        next_attempt_at = NOW(),
        claimed_by = NULL,
        claimed_at = NULL,
        last_error = NULL,
        updated_at = NOW()
      WHERE event_id = $1
        AND status = 'permanently_failed'
      RETURNING *
      `,
      [eventId],
    );

    if (result.rows.length === 0) {
      await this.getEvent(eventId);

      throw new ConflictException(
        'Only permanently failed events can be retried',
      );
    }

    return {
      message: 'Event queued for retry',
      event: result.rows[0],
    };
  }
}
