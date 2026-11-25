import { Pool, PoolClient } from 'pg';
import { ProcessingRepository } from '../src/processing/processing.repository';
import { RecoveryRepository } from '../src/processing/recovery.repository';

describe('Worker Processing Integration Tests', () => {
  let pool: Pool;

  const repository = new ProcessingRepository();
  const recoveryRepository = new RecoveryRepository();

  const MAX_ATTEMPTS = 5;

  async function verifyTestDatabase(): Promise<void> {
    const result = await pool.query('SELECT current_database() AS database');

    if (result.rows[0].database !== 'surpluss_webhooks_test') {
      throw new Error('Tests must use the dedicated test database');
    }
  }

  async function createEvent(eventId: string): Promise<void> {
    await pool.query(
      `INSERT INTO webhook_events (event_id, type, data)
       VALUES ($1, $2, $3::jsonb)`,
      [
        eventId,
        'order.created',
        JSON.stringify({
          orderId: `ORD-${eventId}`,
          simulate: 'ok',
        }),
      ],
    );
  }

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 5,
    });

    await verifyTestDatabase();
  });

  beforeEach(async () => {
    await verifyTestDatabase();

    await pool.query(`
      TRUNCATE
        processing_attempts,
        processed_orders,
        webhook_events
      RESTART IDENTITY
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should allow only one worker to claim the same event', async () => {
    await createEvent('evt_concurrent');

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      const results = await Promise.all([
        repository.claimNextEvent(client1, 'worker-1', MAX_ATTEMPTS),
        repository.claimNextEvent(client2, 'worker-2', MAX_ATTEMPTS),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);

      const attempts = await pool.query('SELECT * FROM processing_attempts');

      expect(attempts.rowCount).toBe(1);
      expect(attempts.rows[0].attempt_number).toBe(1);
    } finally {
      client1.release(true);
      client2.release(true);
    }
  });

  it('should allow two workers to claim different events', async () => {
    await createEvent('evt_parallel_1');
    await createEvent('evt_parallel_2');

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      const [event1, event2] = await Promise.all([
        repository.claimNextEvent(client1, 'worker-1', MAX_ATTEMPTS),
        repository.claimNextEvent(client2, 'worker-2', MAX_ATTEMPTS),
      ]);

      expect(event1).not.toBeNull();
      expect(event2).not.toBeNull();
      expect(event1?.id).not.toBe(event2?.id);
    } finally {
      client1.release(true);
      client2.release(true);
    }
  });

  it('should commit the business action and successful attempt', async () => {
    await createEvent('evt_success');

    const client = await pool.connect();

    try {
      const event = await repository.claimNextEvent(
        client,
        'worker-1',
        MAX_ATTEMPTS,
      );

      expect(event).not.toBeNull();

      await repository.completeEvent(client, event!, 'ORD-SUCCESS');

      const orders = await pool.query('SELECT * FROM processed_orders');

      expect(orders.rowCount).toBe(1);
      expect(orders.rows[0].event_id).toBe('evt_success');

      const events = await pool.query('SELECT * FROM webhook_events');

      expect(events.rows[0].status).toBe('succeeded');

      const attempts = await pool.query('SELECT * FROM processing_attempts');

      expect(attempts.rows[0].result).toBe('succeeded');
      expect(attempts.rows[0].finished_at).not.toBeNull();

      // A completed event must not be claimed again.
      const nextEvent = await repository.claimNextEvent(
        client,
        'worker-1',
        MAX_ATTEMPTS,
      );

      expect(nextEvent).toBeNull();
    } finally {
      client.release(true);
    }
  });

  it('should schedule retries and stop after the maximum attempts', async () => {
    await createEvent('evt_failure');

    const client = await pool.connect();

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const event = await repository.claimNextEvent(
          client,
          'worker-1',
          MAX_ATTEMPTS,
        );

        expect(event).not.toBeNull();
        expect(event!.attempt_count).toBe(attempt);

        await repository.failEvent(
          client,
          event!,
          'Simulated failure',
          MAX_ATTEMPTS,
          1000,
        );

        await repository.releaseEventLock(client, event!.id);

        const result = await pool.query(
          'SELECT * FROM webhook_events WHERE id = $1',
          [event!.id],
        );

        const expectedStatus =
          attempt === MAX_ATTEMPTS ? 'permanently_failed' : 'retry_scheduled';

        expect(result.rows[0].status).toBe(expectedStatus);

        if (attempt < MAX_ATTEMPTS) {
          expect(
            new Date(result.rows[0].next_attempt_at).getTime(),
          ).toBeGreaterThan(new Date(result.rows[0].updated_at).getTime());

          // Advance the scheduled retry for faster testing.
          await pool.query(
            `UPDATE webhook_events
             SET next_attempt_at = NOW()
             WHERE id = $1`,
            [event!.id],
          );
        }
      }

      const nextEvent = await repository.claimNextEvent(
        client,
        'worker-1',
        MAX_ATTEMPTS,
      );

      expect(nextEvent).toBeNull();

      const attempts = await pool.query('SELECT * FROM processing_attempts');

      expect(attempts.rowCount).toBe(MAX_ATTEMPTS);

      const orders = await pool.query('SELECT * FROM processed_orders');

      expect(orders.rowCount).toBe(0);
    } finally {
      client.release(true);
    }
  });

  it('should recover a crashed worker without interrupting an active worker', async () => {
    await createEvent('evt_crash');

    let client1: PoolClient | null = await pool.connect();
    const client2 = await pool.connect();

    try {
      const event = await repository.claimNextEvent(
        client1,
        'worker-1',
        MAX_ATTEMPTS,
      );

      expect(event).not.toBeNull();

      // Worker-1 still owns the advisory lock.
      const activeRecovery = await recoveryRepository.recoverInterruptedEvents(
        client2,
        MAX_ATTEMPTS,
        () => 100,
      );

      expect(activeRecovery).toBe(0);

      // Destroy the connection to simulate worker failure.
      client1.release(true);
      client1 = null;

      let recovered = 0;

      for (let i = 0; i < 20; i++) {
        recovered = await recoveryRepository.recoverInterruptedEvents(
          client2,
          MAX_ATTEMPTS,
          () => 100,
        );

        if (recovered === 1) break;

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(recovered).toBe(1);

      await pool.query(
        `UPDATE webhook_events
         SET next_attempt_at = NOW()
         WHERE event_id = $1`,
        ['evt_crash'],
      );

      const recoveredEvent = await repository.claimNextEvent(
        client2,
        'worker-2',
        MAX_ATTEMPTS,
      );

      expect(recoveredEvent).not.toBeNull();
      expect(recoveredEvent!.attempt_count).toBe(2);

      await repository.completeEvent(client2, recoveredEvent!, 'ORD-CRASH');

      const attempts = await pool.query(`
        SELECT *
        FROM processing_attempts
        ORDER BY attempt_number
      `);

      expect(attempts.rowCount).toBe(2);
      expect(attempts.rows[0].result).toBe('interrupted');
      expect(attempts.rows[1].result).toBe('succeeded');
      expect(attempts.rows[1].worker_id).toBe('worker-2');

      const orders = await pool.query('SELECT * FROM processed_orders');

      expect(orders.rowCount).toBe(1);
    } finally {
      client1?.release(true);
      client2.release(true);
    }
  });
});
