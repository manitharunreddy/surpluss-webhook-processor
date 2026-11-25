import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebhookEvent } from './types/webhook-event.types';

@Injectable()
export class BusinessService {
  async execute(event: WebhookEvent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();

    const orderId = event.data.orderId;
    const simulation = event.data.simulate ?? 'ok';

    // Validate order ID
    if (typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new Error('Invalid or missing orderId');
    }

    if (typeof simulation !== 'string') {
      throw new Error('Invalid simulation value');
    }

    // Successful processing
    if (simulation === 'ok') {
      return orderId;
    }

    // Always fail
    if (simulation === 'always_fail') {
      throw new Error('Simulated permanent processing failure');
    }

    // Fail the first N attempts
    const failMatch = /^fail_then_succeed:(\d+)$/.exec(simulation);

    if (failMatch) {
      const failureCount = Number(failMatch[1]);

      if (!Number.isSafeInteger(failureCount)) {
        throw new Error('Invalid simulation failure count');
      }

      if (event.attempt_count <= failureCount) {
        throw new Error(
          `Simulated failure: attempt ${event.attempt_count} of ${failureCount}`,
        );
      }

      return orderId;
    }

    // Simulate slow processing
    const slowMatch = /^slow:(\d+)$/.exec(simulation);

    if (slowMatch) {
      const seconds = Number(slowMatch[1]);

      if (!Number.isSafeInteger(seconds)) {
        throw new Error('Invalid simulation duration');
      }

      // Split long durations to avoid Node.js timer overflow.
      let remainingSeconds = seconds;

      while (remainingSeconds > 0) {
        const chunk = Math.min(remainingSeconds, 3600);

        await sleep(chunk * 1000, undefined, { signal });

        remainingSeconds -= chunk;
      }

      signal.throwIfAborted();

      return orderId;
    }

    throw new Error(`Unsupported simulation: ${simulation}`);
  }
}
