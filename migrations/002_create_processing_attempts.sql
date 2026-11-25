-- Up Migration
CREATE TABLE processing_attempts (
    id BIGSERIAL PRIMARY KEY,
    webhook_event_id BIGINT NOT NULL,
    attempt_number INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    result TEXT NOT NULL DEFAULT 'running',
    error TEXT,
    CONSTRAINT fk_processing_attempt_webhook FOREIGN KEY (webhook_event_id) REFERENCES webhook_events (id),
    CONSTRAINT uq_webhook_attempt UNIQUE (
        webhook_event_id,
        attempt_number
    ),
    CONSTRAINT chk_attempt_number CHECK (attempt_number > 0),
    CONSTRAINT chk_attempt_result CHECK (
        result IN (
            'running',
            'succeeded',
            'failed',
            'interrupted'
        )
    ),
    CONSTRAINT chk_attempt_completion CHECK (
        (
            result = 'running'
            AND finished_at IS NULL
        )
        OR (
            result <> 'running'
            AND finished_at IS NOT NULL
        )
    )
);

-- Column descriptions

COMMENT ON COLUMN processing_attempts.id IS 'Internal unique identifier for each processing attempt.';

COMMENT ON COLUMN processing_attempts.webhook_event_id IS 'Internal webhook identifier referencing webhook_events.id.';

COMMENT ON COLUMN processing_attempts.attempt_number IS 'Sequential lifetime attempt number for the webhook event. Continues increasing across manual retry cycles.';

COMMENT ON COLUMN processing_attempts.worker_id IS 'Identifier of the worker responsible for this processing attempt. Example: worker-1 or worker-2.';

COMMENT ON COLUMN processing_attempts.started_at IS 'Timestamp at which the worker started the processing attempt.';

COMMENT ON COLUMN processing_attempts.finished_at IS 'Timestamp at which the attempt completed or was detected as interrupted. NULL while the attempt is running.';

COMMENT ON COLUMN processing_attempts.result IS 'Result of the individual processing attempt.

running     : Attempt started and is currently in progress.
succeeded   : Attempt completed successfully.
failed      : Attempt encountered a processing error.
interrupted : Attempt was abandoned due to worker crash or connection loss.';

COMMENT ON COLUMN processing_attempts.error IS 'Error message or interruption reason associated with the processing attempt. NULL when no error is recorded.';
-- Down Migration

DROP TABLE processing_attempts;