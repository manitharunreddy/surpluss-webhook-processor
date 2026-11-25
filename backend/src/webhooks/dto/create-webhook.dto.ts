import { IsString, IsNotEmpty, IsObject } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;
}
