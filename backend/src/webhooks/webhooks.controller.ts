import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  getEvents() {
    return this.webhooksService.getEvents();
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  createEvent(@Body() dto: CreateWebhookDto) {
    return this.webhooksService.createEvent(dto);
  }
}
