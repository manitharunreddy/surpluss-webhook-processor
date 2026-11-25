-- Up Migration
CREATE TABLE webhook_events (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    data JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    cycle_attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_by TEXT,
    claimed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_webhook_status CHECK (
        status IN (
            'pending',
            'processing',
            'retry_scheduled',
            'succeeded',
            'permanently_failed'
        )
    ),
    CONSTRAINT chk_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT chk_cycle_attempt_count CHECK (
        cycle_attempt_count >= 0
        AND cycle_attempt_count <= attempt_count
    )
);

-- Column descriptions

COMMENT ON COLUMN webhook_events.id IS 'Internal unique identifier used for database relationships and PostgreSQL advisory locks.';

COMMENT ON COLUMN webhook_events.event_id IS 'Unique external webhook event identifier. Prevents duplicate event storage and ensures the first received payload is preserved by the ingestion logic.';

COMMENT ON COLUMN webhook_events.type IS 'Type of webhook event. Example: order.created.';

COMMENT ON COLUMN webhook_events.data IS 'Original webhook data stored in JSONB format, including business information and simulation settings.';

COMMENT ON COLUMN webhook_events.status IS 'Current processing status of the webhook event.

pending            : Event received and waiting for processing.
processing         : Event claimed by a worker for processing.
retry_scheduled    : Previous attempt failed; waiting for the next retry.
succeeded          : Business operation completed successfully.
permanently_failed : Maximum attempts exhausted; manual retry required.';

COMMENT ON COLUMN webhook_events.attempt_count IS 'Total lifetime processing attempts, including failed, successful and interrupted attempts. Never reset during manual retries.';

COMMENT ON COLUMN webhook_events.cycle_attempt_count IS 'Number of processing attempts within the current retry cycle. Reset to zero during manual retry to provide a fresh retry budget.';

COMMENT ON COLUMN webhook_events.next_attempt_at IS 'Earliest timestamp at which a pending or retry-scheduled event becomes eligible for processing. Updated based on the retry backoff strategy.';

COMMENT ON COLUMN webhook_events.claimed_by IS 'Identifier of the worker currently assigned to process the event. Example: worker-1 or worker-2. NULL when no worker is assigned.';

COMMENT ON COLUMN webhook_events.claimed_at IS 'Timestamp at which the worker claimed the event. Used for monitoring and crash recovery inspection. NULL when the event is unclaimed.';

COMMENT ON COLUMN webhook_events.last_error IS 'Most recently recorded processing error. Complete attempt and error history is maintained in the processing_attempts table.';

COMMENT ON COLUMN webhook_events.created_at IS 'Timestamp at which the webhook event was first received and persisted in the database.';

COMMENT ON COLUMN webhook_events.updated_at IS 'Timestamp of the most recent modification to the event. Must be explicitly updated by application SQL statements.';

-- Down Migration

DROP TABLE webhook_events;