import { Module } from '@nestjs/common';
import { ProcessingService } from './processing.service';
import { ProcessingRepository } from './processing.repository';
import { RecoveryRepository } from './recovery.repository';
import { BusinessService } from './business.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [
    ProcessingService,
    ProcessingRepository,
    RecoveryRepository,
    BusinessService,
  ],
})
export class ProcessingModule {}
