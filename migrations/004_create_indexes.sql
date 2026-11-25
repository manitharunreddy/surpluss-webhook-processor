-- Up Migration

CREATE INDEX idx_webhook_events_ready ON webhook_events (next_attempt_at, id)
WHERE
    status IN ('pending', 'retry_scheduled');

CREATE INDEX idx_webhook_events_processing ON webhook_events (claimed_at, id)
WHERE
    status = 'processing';

-- Index descriptions

COMMENT ON INDEX idx_webhook_events_ready IS 'Partial index used by workers to efficiently select pending and retry-scheduled events based on their next eligible processing time.';

COMMENT ON INDEX idx_webhook_events_processing IS 'Partial index used by workers to efficiently identify processing events for crash recovery inspection.';

-- Down Migration

DROP INDEX idx_webhook_events_processing;

DROP INDEX idx_webhook_events_ready;