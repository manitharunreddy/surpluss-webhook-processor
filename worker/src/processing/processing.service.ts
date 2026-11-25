import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { ProcessingRepository } from './processing.repository';
import { RecoveryRepository } from './recovery.repository';
import { BusinessService } from './business.service';
import { WebhookEvent } from './types/webhook-event.types';
import { setTimeout as sleep } from 'node:timers/promises';

@Injectable()
export class ProcessingService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ProcessingService.name);

  // Worker configuration
  private readonly workerId: string;
  private readonly pollIntervalMs: number;

  // Retry configuration
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  // Recovery configuration
  private readonly recoveryIntervalMs = 5000;
  private nextRecoveryAt = 0;

  // Worker lifecycle
  private running = false;
  private pollingTask: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly processingRepository: ProcessingRepository,
    private readonly recoveryRepository: RecoveryRepository,
    private readonly businessService: BusinessService,
  ) {
    this.workerId = this.configService.getOrThrow<string>('WORKER_ID');

    this.pollIntervalMs = this.getPositiveInteger('WORKER_POLL_INTERVAL_MS');

    this.maxAttempts = this.getPositiveInteger('MAX_ATTEMPTS');

    this.retryBaseDelayMs = this.getPositiveInteger('RETRY_BASE_DELAY_MS');

    this.retryMaxDelayMs = this.getPositiveInteger('RETRY_MAX_DELAY_MS');

    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error(
        'RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_BASE_DELAY_MS',
      );
    }
  }

  // Validate numeric configuration
  private getPositiveInteger(key: string): number {
    const value = Number(this.configService.getOrThrow<string>(key));

    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }

    return value;
  }

  // Calculate exponential retry delay
  private calculateRetryDelay(cycleAttemptCount: number): number {
    return Math.min(
      this.retryBaseDelayMs * Math.pow(2, cycleAttemptCount - 1),
      this.retryMaxDelayMs,
    );
  }

  // Start worker
  onApplicationBootstrap(): void {
    this.running = true;

    this.logger.log(`${this.workerId} started polling`);

    this.pollingTask = this.poll();
  }

  // Continuous polling loop
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        // Periodically recover interrupted events
        if (Date.now() >= this.nextRecoveryAt) {
          this.nextRecoveryAt = Date.now() + this.recoveryIntervalMs;

          await this.recoverInterruptedEvents();
        }

        if (!this.running) {
          break;
        }

        // Claim and process the next available event
        const processed = await this.processNextEvent();

        if (processed) {
          continue;
        }
      } catch (error) {
        this.logger.error(
          'Worker polling error',
          error instanceof Error ? error.stack : String(error),
        );
      }

      if (this.running) {
        await sleep(this.pollIntervalMs, undefined, {
          signal: this.shutdownController.signal,
        }).catch((error: unknown) => {
          if (!this.shutdownController.signal.aborted) {
            throw error;
          }
        });
      }
    }
  }

  // Recover events abandoned by crashed workers
  private async recoverInterruptedEvents(): Promise<void> {
    const client = await this.databaseService.getClient();

    let discardClient = false;

    const handleConnectionError = (error: Error): void => {
      discardClient = true;

      this.logger.error('Recovery database connection lost', error.stack);
    };

    client.on('error', handleConnectionError);

    try {
      const recoveredCount =
        await this.recoveryRepository.recoverInterruptedEvents(
          client,
          this.maxAttempts,
          (attempt) => this.calculateRetryDelay(attempt),
        );

      if (recoveredCount > 0) {
        this.logger.warn(
          `${this.workerId} recovered ${recoveredCount} interrupted event(s)`,
        );
      }
    } catch (error) {
      discardClient = true;

      throw error;
    } finally {
      client.removeListener('error', handleConnectionError);

      client.release(discardClient);
    }
  }

  // Claim and process an available event
  private async processNextEvent(): Promise<boolean> {
    const client = await this.databaseService.getClient();

    let event: WebhookEvent | null = null;
    let discardClient = false;

    const processingController = new AbortController();

    // Cancel processing if the database connection is lost
    const handleConnectionError = (error: Error): void => {
      discardClient = true;

      processingController.abort(error);

      this.logger.error('Worker database connection lost', error.stack);
    };

    client.on('error', handleConnectionError);

    try {
      event = await this.processingRepository.claimNextEvent(
        client,
        this.workerId,
        this.maxAttempts,
      );

      if (!event) {
        return false;
      }

      this.logger.log(
        `Claimed event ${event.event_id}, attempt ${event.attempt_count}`,
      );

      let orderId: string;

      // Execute business simulation
      try {
        orderId = await this.businessService.execute(
          event,
          processingController.signal,
        );
      } catch (error) {
        if (discardClient || processingController.signal.aborted) {
          throw error;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        const retryDelayMs = this.calculateRetryDelay(
          event.cycle_attempt_count,
        );

        await this.processingRepository.failEvent(
          client,
          event,
          errorMessage,
          this.maxAttempts,
          retryDelayMs,
        );

        if (event.cycle_attempt_count >= this.maxAttempts) {
          this.logger.warn(
            `Event ${event.event_id} permanently failed after ${event.cycle_attempt_count} cycle attempts: ${errorMessage}`,
          );
        } else {
          this.logger.warn(
            `Event ${event.event_id} failed. Retry scheduled in ${retryDelayMs}ms: ${errorMessage}`,
          );
        }

        return true;
      }

      processingController.signal.throwIfAborted();

      // Atomically persist business action and success status
      await this.processingRepository.completeEvent(client, event, orderId);

      this.logger.log(
        `Event ${event.event_id} succeeded on attempt ${event.attempt_count}`,
      );

      return true;
    } catch (error) {
      discardClient = true;

      throw error;
    } finally {
      try {
        if (event && !discardClient) {
          await this.processingRepository.releaseEventLock(client, event.id);
        }
      } catch (error) {
        discardClient = true;

        this.logger.error(
          'Failed to release advisory lock',
          error instanceof Error ? error.stack : String(error),
        );
      } finally {
        client.removeListener('error', handleConnectionError);

        client.release(discardClient);
      }
    }
  }

  // Graceful shutdown
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;

    this.shutdownController.abort();

    this.logger.log(`${this.workerId} stopping`);

    await this.pollingTask;

    this.logger.log(`${this.workerId} stopped`);
  }
}
