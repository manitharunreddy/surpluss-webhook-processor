import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@Injectable()
export class WebhooksService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getEvents(): Promise<{ message: string }> {
    const result = await this.databaseService.query<{
      connected: number;
    }>('SELECT 1 AS connected');

    return {
      message: `Database connection status: ${result.rows[0].connected}`,
    };
  }

  async createEvent(
    dto: CreateWebhookDto,
  ): Promise<{ eventId: string; accepted: boolean }> {
    await this.databaseService.query(
      `
        INSERT INTO webhook_events (
          event_id,
          type,
          data
        )
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
}
