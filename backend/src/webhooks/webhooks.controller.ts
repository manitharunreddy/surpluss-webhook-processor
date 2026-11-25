import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // Receive webhook
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  createEvent(@Body() dto: CreateWebhookDto) {
    return this.webhooksService.createEvent(dto);
  }

  // Get all webhook events
  @Get()
  getEvents() {
    return this.webhooksService.getEvents();
  }

  // Get individual webhook details
  @Get(':eventId')
  getEvent(@Param('eventId') eventId: string) {
    return this.webhooksService.getEvent(eventId);
  }

  // Get processing attempt history
  @Get(':eventId/attempts')
  getAttempts(@Param('eventId') eventId: string) {
    return this.webhooksService.getAttempts(eventId);
  }

  // Manually retry a permanently failed event
  @Post(':eventId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryEvent(@Param('eventId') eventId: string) {
    return this.webhooksService.retryEvent(eventId);
  }
}
