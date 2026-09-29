// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Webhook event taxonomy. Each enumerated event has a Zod schema that
// describes the body shape Fonto delivers to subscriber endpoints. The shape
// is part of the public contract — clients pin against it, so we evolve
// these conservatively. The retired sibling event bus shared some names
// (e.g. `asset.uploaded`) but is internal-only and changes more freely.

import { z } from "zod";

/** All event types the webhooks system can deliver. */
export const WebhookEventTypes = [
  "asset.uploaded",
  "asset.processed",
  "asset.deleted",
  "tag.created",
  "collection.created",
  "collection.shared",
  // Internal — emitted by POST /webhooks/:id/test. Not subscribable from the
  // UI; the test route bypasses `enabledEvents` filtering.
  "ping",
] as const;

export type WebhookEventType = (typeof WebhookEventTypes)[number];

/** Event types the UI surfaces as subscribable (excludes `ping`). */
export const SubscribableEventTypes: readonly WebhookEventType[] = WebhookEventTypes.filter(
  (t) => t !== "ping"
);

// ── Payload schemas ──────────────────────────────────────────────────────────

const AssetUploadedPayload = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  source: z.string().nullable(),
  uploadedAt: z.string(),
});

const AssetProcessedPayload = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  classification: z.string().nullable(),
  description: z.string().nullable(),
  processedAt: z.string(),
});

const AssetDeletedPayload = z.object({
  assetId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  filename: z.string(),
  deletedAt: z.string(),
  // "soft" — moved to trash. "purged" — permanently removed.
  mode: z.enum(["soft", "purged"]),
});

const TagCreatedPayload = z.object({
  tagId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  aiSuggested: z.boolean(),
  createdAt: z.string(),
});

const CollectionCreatedPayload = z.object({
  collectionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
});

const CollectionSharedPayload = z.object({
  collectionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  shareToken: z.string(),
  shareUrl: z.string().url(),
  expiresAt: z.string().nullable(),
  sharedAt: z.string(),
});

const PingPayload = z.object({
  message: z.string(),
  ts: z.string(),
});

/** Lookup table: event type -> Zod schema for its `data` field. */
export const WebhookPayloadSchemas = {
  "asset.uploaded": AssetUploadedPayload,
  "asset.processed": AssetProcessedPayload,
  "asset.deleted": AssetDeletedPayload,
  "tag.created": TagCreatedPayload,
  "collection.created": CollectionCreatedPayload,
  "collection.shared": CollectionSharedPayload,
  ping: PingPayload,
} as const satisfies Record<WebhookEventType, z.ZodTypeAny>;

export type WebhookPayloads = {
  [K in WebhookEventType]: z.infer<(typeof WebhookPayloadSchemas)[K]>;
};

/**
 * The outer envelope every webhook POST body wraps its `data` in. Stable
 * across all event types so subscribers can dispatch on `type` and validate
 * `data` against the matching payload schema.
 */
export const WebhookEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(WebhookEventTypes),
  createdAt: z.string(),
  data: z.unknown(),
});

export type WebhookEnvelope<T extends WebhookEventType = WebhookEventType> = {
  id: string;
  type: T;
  createdAt: string;
  data: WebhookPayloads[T];
};

/** Type guard: is this string a known event type? */
export function isWebhookEventType(s: string): s is WebhookEventType {
  return (WebhookEventTypes as readonly string[]).includes(s);
}
