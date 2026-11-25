import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
async function bootstrap() {
 const app = await NestFactory.createApplicationContext(AppModule);

  app.enableShutdownHooks();

  const logger = new Logger('WorkerBootstrap');

  logger.log('Worker application initialized successfully');
}
bootstrap();
