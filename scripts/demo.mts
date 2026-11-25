import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = process.env.API_URL || "http://localhost:3001";
const runId = `demo_${randomUUID()}`;

interface WebhookEvent {
  event_id: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
}

async function sendEvent(name: string, simulate: string) {
  const eventId = `${runId}_${name}`;

  const response = await fetch(`${API_URL}/webhooks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      eventId,
      type: "order.created",
      data: {
        orderId: `ORD-${eventId}`,
        simulate,
      },
    }),
  });

  if (response.status !== 202) {
    throw new Error(`${eventId}: HTTP ${response.status}`);
  }

  await response.text();

  return eventId;
}

async function waitForEvent(eventId: string): Promise<WebhookEvent> {
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${API_URL}/webhooks/${encodeURIComponent(eventId)}`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (!response.ok) {
      throw new Error(`Unable to retrieve ${eventId}`);
    }

    const event = (await response.json()) as WebhookEvent;

    if (event.status === "succeeded" || event.status === "permanently_failed") {
      return event;
    }

    await sleep(1000);
  }

  throw new Error(`Timeout waiting for ${eventId}`);
}

async function main() {
  console.log(`Demo run: ${runId}`);

  console.log("\nSubmitting 20 concurrent duplicate deliveries...");

  const duplicates = await Promise.all(
    Array.from({ length: 20 }, () => sendEvent("duplicate", "ok")),
  );

  console.log("All 20 duplicate deliveries accepted.");

  const eventIds = [
    duplicates[0],
    ...(await Promise.all([
      sendEvent("temporary_failure", "fail_then_succeed:2"),
      sendEvent("permanent_failure", "always_fail"),
      sendEvent("slow_1", "slow:10"),
      sendEvent("slow_2", "slow:10"),
    ])),
  ];

  console.log("\nWaiting for all events to finish...");

  const results = await Promise.all(eventIds.map(waitForEvent));

  console.table(
    results.map((event) => ({
      scenario: event.event_id.replace(`${runId}_`, ""),
      status: event.status,
      attempts: event.attempt_count,
      error: event.last_error || "-",
    })),
  );

  const expected = [
    { status: "succeeded", attempts: 1 },
    { status: "succeeded", attempts: 3 },
    { status: "permanently_failed", attempts: 5 },
    { status: "succeeded", attempts: 1 },
    { status: "succeeded", attempts: 1 },
  ];

  results.forEach((event, index) => {
    if (
      event.status !== expected[index].status ||
      event.attempt_count !== expected[index].attempts
    ) {
      throw new Error(`Unexpected result: ${event.event_id}`);
    }
  });

  console.log("\nPASS: All demonstration scenarios completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
