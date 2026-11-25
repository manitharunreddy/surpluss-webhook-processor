import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
describe('Webhooks (e2e)', () => {
  let app: INestApplication;
  let databaseService: DatabaseService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.init();

    databaseService = app.get(DatabaseService);

    const result = await databaseService.query<{
      database_name: string;
    }>('SELECT current_database() AS database_name');

    if (result.rows[0].database_name !== 'surpluss_webhooks_test') {
      throw new Error('Tests must use the dedicated test database');
    }
  });

  beforeEach(async () => {
    const result = await databaseService.query<{
      database_name: string;
    }>('SELECT current_database() AS database_name');

    if (result.rows[0].database_name !== 'surpluss_webhooks_test') {
      throw new Error('Cleanup is only allowed in the test database');
    }

    await databaseService.query(`
    TRUNCATE TABLE
      processing_attempts,
      processed_orders,
      webhook_events
    RESTART IDENTITY
  `);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should connect to the test database', async () => {
    const result = await databaseService.query<{
      database_name: string;
    }>('SELECT current_database() AS database_name');

    expect(result.rows[0].database_name).toBe('surpluss_webhooks_test');
  });

  it('should accept and persist a valid webhook event', async () => {
    const payload = {
      eventId: `evt_test_${randomUUID()}`,
      type: 'order.created',
      data: {
        orderId: 'ORD-TEST-001',
        customerId: 'CUS-42',
        simulate: 'ok',
      },
    };

    // Send HTTP request
    const response = await request(app.getHttpServer())
      .post('/webhooks')
      .send(payload)
      .expect(202);

    // Verify HTTP response
    expect(response.body).toEqual({
      eventId: payload.eventId,
      accepted: true,
    });

    // Retrieve the persisted event
    const result = await databaseService.query(
      `SELECT event_id, type, data, status, attempt_count
     FROM webhook_events
     WHERE event_id = $1`,
      [payload.eventId],
    );

    // Verify database record
    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]).toEqual({
      event_id: payload.eventId,
      type: payload.type,
      data: payload.data,
      status: 'pending',
      attempt_count: 0,
    });
  });

  it('should accept duplicate deliveries without creating duplicate records', async () => {
    const payload = {
      eventId: `evt_test_${randomUUID()}`,
      type: 'order.created',
      data: {
        orderId: 'ORD-DUPLICATE-001',
        customerId: 'CUS-42',
        simulate: 'ok',
      },
    };

    // Send the same webhook five times sequentially
    for (let i = 0; i < 5; i++) {
      const response = await request(app.getHttpServer())
        .post('/webhooks')
        .send(payload)
        .expect(202);

      expect(response.body).toEqual({
        eventId: payload.eventId,
        accepted: true,
      });
    }

    // Retrieve records matching the event ID
    const result = await databaseService.query(
      `SELECT event_id, type, data, status, attempt_count
     FROM webhook_events
     WHERE event_id = $1`,
      [payload.eventId],
    );

    // Verify that only one record exists
    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]).toEqual({
      event_id: payload.eventId,
      type: payload.type,
      data: payload.data,
      status: 'pending',
      attempt_count: 0,
    });
  });
  it('should preserve the original payload when a duplicate contains different data', async () => {
    const eventId = `evt_test_${randomUUID()}`;

    const originalPayload = {
      eventId,
      type: 'order.created',
      data: {
        orderId: 'ORD-ORIGINAL-001',
        customerId: 'CUS-42',
        simulate: 'ok',
      },
    };

    const modifiedPayload = {
      eventId,
      type: 'order.updated',
      data: {
        orderId: 'ORD-MODIFIED-001',
        customerId: 'CUS-99',
        simulate: 'always_fail',
      },
    };

    // Send the original webhook
    await request(app.getHttpServer())
      .post('/webhooks')
      .send(originalPayload)
      .expect(202);

    // Send the modified duplicate webhook
    const response = await request(app.getHttpServer())
      .post('/webhooks')
      .send(modifiedPayload)
      .expect(202);

    expect(response.body).toEqual({
      eventId,
      accepted: true,
    });

    // Retrieve the persisted event
    const result = await databaseService.query(
      `SELECT event_id, type, data, status, attempt_count
     FROM webhook_events
     WHERE event_id = $1`,
      [eventId],
    );

    // Verify that only the original payload is preserved
    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]).toEqual({
      event_id: originalPayload.eventId,
      type: originalPayload.type,
      data: originalPayload.data,
      status: 'pending',
      attempt_count: 0,
    });
  });

  it('should handle concurrent duplicate deliveries without creating duplicate records', async () => {
    const payload = {
      eventId: `evt_test_${randomUUID()}`,
      type: 'order.created',
      data: {
        orderId: 'ORD-CONCURRENT-001',
        customerId: 'CUS-42',
        simulate: 'ok',
      },
    };

    const totalRequests = 20;

    // Send 20 concurrent requests with the same payload
    const responses = await Promise.all(
      Array.from({ length: totalRequests }, () =>
        request(app.getHttpServer())
          .post('/webhooks')
          .send(payload)
          .expect(202),
      ),
    );

    // Verify all requests completed successfully
    expect(responses).toHaveLength(totalRequests);

    // Verify every response
    for (const response of responses) {
      expect(response.body).toEqual({
        eventId: payload.eventId,
        accepted: true,
      });
    }

    // Retrieve records matching the event ID
    const result = await databaseService.query(
      `SELECT event_id, type, data, status, attempt_count
     FROM webhook_events
     WHERE event_id = $1`,
      [payload.eventId],
    );

    // Verify exactly one record exists
    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]).toEqual({
      event_id: payload.eventId,
      type: payload.type,
      data: payload.data,
      status: 'pending',
      attempt_count: 0,
    });
  });

  it('should reject invalid webhook requests without persisting them', async () => {
    const invalidPayloads = [
      // Missing eventId
      {
        type: 'order.created',
        data: {},
      },

      // Invalid eventId type
      {
        eventId: 12345,
        type: 'order.created',
        data: {},
      },

      // Empty eventId
      {
        eventId: '',
        type: 'order.created',
        data: {},
      },

      // Missing type
      {
        eventId: `evt_test_${randomUUID()}`,
        data: {},
      },

      // Empty type
      {
        eventId: `evt_test_${randomUUID()}`,
        type: '',
        data: {},
      },

      // Invalid data type
      {
        eventId: `evt_test_${randomUUID()}`,
        type: 'order.created',
        data: 'invalid-data',
      },

      // Missing data
      {
        eventId: `evt_test_${randomUUID()}`,
        type: 'order.created',
      },
    ];

    // Count records before sending invalid requests
    const before = await databaseService.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM webhook_events',
    );

    // Verify every invalid request is rejected
    for (const payload of invalidPayloads) {
      await request(app.getHttpServer())
        .post('/webhooks')
        .send(payload)
        .expect(400);
    }

    // Count records after sending invalid requests
    const after = await databaseService.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM webhook_events',
    );

    // Verify no invalid records were inserted
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
