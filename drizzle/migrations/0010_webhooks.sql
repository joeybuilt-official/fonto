-- SPDX-License-Identifier: AGPL-3.0-only
-- Phase 2.4: outbound webhooks (Stripe-style HMAC).
--
-- Two additive tables. `webhook_endpoints` holds the user-managed
-- subscription rows (URL + signing secret + event subscription list).
-- `webhook_deliveries` is the per-attempt log + the work queue the BullMQ
-- `webhook-delivery` worker drains.
--
-- Both tables are additive — no existing schema changes — so this migration
-- is safe to apply on any environment running migrations 0001..0009.

CREATE TABLE IF NOT EXISTS fonto.webhook_endpoints (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL,
    url             text NOT NULL,
    signing_secret  text NOT NULL,
    enabled_events  text[] NOT NULL DEFAULT '{}'::text[],
    description     text,
    disabled_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_workspace_disabled_idx
    ON fonto.webhook_endpoints (workspace_id, disabled_at);

CREATE TABLE IF NOT EXISTS fonto.webhook_deliveries (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id           uuid NOT NULL,
    event_type            text NOT NULL,
    payload               jsonb NOT NULL,
    attempts              integer NOT NULL DEFAULT 0,
    last_attempt_at       timestamptz,
    next_attempt_at       timestamptz,
    state                 text NOT NULL DEFAULT 'pending',
    last_response_status  integer,
    last_response_body    text,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_state_idx
    ON fonto.webhook_deliveries (endpoint_id, state);
CREATE INDEX IF NOT EXISTS webhook_deliveries_next_attempt_idx
    ON fonto.webhook_deliveries (next_attempt_at);
