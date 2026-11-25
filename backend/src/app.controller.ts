import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get() // default route for "/" GET
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health') // health check route for "/health" GET
  getHealthCheck(): { status: string; timestamp: string } {
    return this.appService.getHealthCheck();
  }
}
