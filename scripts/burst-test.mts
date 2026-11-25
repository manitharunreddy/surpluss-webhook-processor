import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = process.env.API_URL || "http://localhost:3001";
const TOTAL_EVENTS = 500;
const CONCURRENCY = 50;
const TIMEOUT_MS = 120_000;

const runId = `burst_${randomUUID()}`;

interface WebhookEvent {
  event_id: string;
  status: string;
  attempt_count: number;
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const latencies: number[] = [];

  let accepted = 0;
  let rejected = 0;

  console.log(`Burst test ID: ${runId}`);
  console.log(`Submitting ${TOTAL_EVENTS} events...`);

  async function sendEvent(index: number): Promise<void> {
    const start = performance.now();

    try {
      const response = await fetch(`${API_URL}/webhooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          eventId: `${runId}_${index}`,
          type: "order.created",
          data: {
            orderId: `ORD-${runId}-${index}`,
            simulate: "ok",
          },
        }),
      });

      await response.text();

      if (response.status === 202) {
        accepted++;
        latencies.push(performance.now() - start);
      } else {
        rejected++;
        console.error(`Event ${index}: HTTP ${response.status}`);
      }
    } catch (error) {
      rejected++;
      console.error(`Event ${index}:`, error);
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, workerIndex) => {
      for (
        let index = workerIndex;
        index < TOTAL_EVENTS;
        index += CONCURRENCY
      ) {
        await sendEvent(index);
      }
    }),
  );

  const ingestionDuration = performance.now() - startedAt;

  latencies.sort((a, b) => a - b);

  const averageLatency = latencies.length
    ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
    : 0;

  const p95Latency = latencies.length
    ? latencies[Math.ceil(latencies.length * 0.95) - 1]
    : 0;

  console.log("\nIngestion results:");

  console.table({
    submitted: TOTAL_EVENTS,
    accepted,
    rejected,
    ingestionTimeMs: ingestionDuration.toFixed(2),
    averageLatencyMs: averageLatency.toFixed(2),
    p95LatencyMs: p95Latency.toFixed(2),
  });

  console.log("\nWaiting for background processing...");

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${API_URL}/webhooks`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Status API returned ${response.status}`);
    }

    const events = (await response.json()) as WebhookEvent[];

    const burstEvents = events.filter((event) =>
      event.event_id.startsWith(`${runId}_`),
    );

    const succeeded = burstEvents.filter(
      (event) => event.status === "succeeded",
    ).length;

    const failed = burstEvents.filter(
      (event) => event.status === "permanently_failed",
    ).length;

    const remaining = TOTAL_EVENTS - succeeded - failed;

    console.log(
      `Succeeded: ${succeeded} | Failed: ${failed} | Remaining: ${remaining}`,
    );

    if (succeeded + failed === TOTAL_EVENTS) {
      console.log("\nFinal results:");

      console.table({
        submitted: TOTAL_EVENTS,
        accepted,
        succeeded,
        failed,
        totalDurationMs: (performance.now() - startedAt).toFixed(2),
      });

      if (
        accepted === TOTAL_EVENTS &&
        succeeded === TOTAL_EVENTS &&
        rejected === 0
      ) {
        console.log("PASS: All 500 events processed successfully.");
        return;
      }

      throw new Error("Burst test failed.");
    }

    await sleep(1000);
  }

  throw new Error("Burst test timed out.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
