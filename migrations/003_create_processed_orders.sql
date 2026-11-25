-- Up Migration

CREATE TABLE processed_orders (
    event_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_processed_order_webhook
        FOREIGN KEY (event_id)
        REFERENCES webhook_events(event_id)
);


-- Column descriptions

COMMENT ON COLUMN processed_orders.event_id IS
'Unique external webhook event identifier referencing webhook_events.event_id. The primary key prevents duplicate business operations for the same webhook event.';

COMMENT ON COLUMN processed_orders.order_id IS
'Business order identifier extracted from the webhook data. Example: ORD-1001.';

COMMENT ON COLUMN processed_orders.processed_at IS
'Timestamp at which the order processing record was created successfully.';


-- Down Migration

DROP TABLE processed_orders;