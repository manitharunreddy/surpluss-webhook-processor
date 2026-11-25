export type WebhookStatus =
  | 'pending'
  | 'processing'
  | 'retry_scheduled'
  | 'succeeded'
  | 'permanently_failed';

export type AttemptResult = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface WebhookEvent {
  id: string;
  event_id: string;
  type: string;
  data: Record<string, unknown>;
  status: WebhookStatus;
  attempt_count: number;
  cycle_attempt_count: number;
  next_attempt_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProcessingAttempt {
  id: string;
  webhook_event_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: Date;
  finished_at: Date | null;
  result: AttemptResult;
  error: string | null;
}
