import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly pool: Pool;

  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly configService: ConfigService) {
    this.pool = new Pool({
      host: this.configService.getOrThrow<string>('DB_HOST'),

      port: Number(this.configService.getOrThrow<string>('DB_PORT')),

      user: this.configService.getOrThrow<string>('DB_USER'),

      password: this.configService.getOrThrow<string>('DB_PASSWORD'),

      database: this.configService.getOrThrow<string>('DB_NAME'),

      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,

      application_name: this.configService.getOrThrow<string>('WORKER_ID'),

      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    this.pool.on('error', (error) => {
      this.logger.error('Unexpected PostgreSQL pool error', error.stack);
    });
  }

  // Verify PostgreSQL connectivity
  async onModuleInit(): Promise<void> {
    const result = await this.query<{ connected: number }>(
      'SELECT 1 AS connected',
    );

    this.logger.log(
      `PostgreSQL connection established successfully ${JSON.stringify(result.rows)}`,
    );
  }

  // Execute a query using the connection pool
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  // Acquire a dedicated PostgreSQL connection
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  // Close the pool after the worker has stopped
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();

    this.logger.log('PostgreSQL connection pool closed');
  }
}
