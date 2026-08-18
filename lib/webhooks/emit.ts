// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Webhook fan-out: turn a single in-app event into one delivery row +
// enqueued BullMQ job per subscribed endpoint. Best-effort by design — a
// failure to enqueue (e.g. Redis unavailable) is logged but never throws,
// because webhooks are a side channel: dropping one must not roll back the
// user-visible action that triggered it.

import { createHmac, randomUUID } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { webhookDeliveryQueue, JobNames } from "@/lib/queue";
import { WebhookPayloadSchemas, type WebhookEventType, type WebhookPayloads } from "./events";

/**
 * Fan out an event to every enabled subscriber. Inserts a
 * `webhook_deliveries` row per match and enqueues a delivery job. Never
 * throws — failures are logged.
 */
export async function emitWebhook<T extends WebhookEventType>(
  workspaceId: string,
  eventType: T,
  data: WebhookPayloads[T]
): Promise<void> {
  try {
    // Validate the payload shape at the producer side so a malformed event
    // is caught at the call site (during development), not silently
    // delivered to subscribers.
    const schemaForType = WebhookPayloadSchemas[eventType];
    const parsed = schemaForType.safeParse(data);
    if (!parsed.success) {
      console.warn(
        "[fonto-webhooks] payload failed validation for",
        eventType,
        parsed.error.flatten()
      );
      return;
    }

    const endpoints = await db
      .select({
        id: schema.webhookEndpoints.id,
        enabledEvents: schema.webhookEndpoints.enabledEvents,
      })
      .from(schema.webhookEndpoints)
      .where(
        and(
          eq(schema.webhookEndpoints.workspaceId, workspaceId),
          isNull(schema.webhookEndpoints.disabledAt),
          sql`${eventType} = ANY(${schema.webhookEndpoints.enabledEvents})`
        )
      );

    if (endpoints.length === 0) return;

    const envelopeId = randomUUID();
    const envelope = {
      id: envelopeId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data: parsed.data,
    };

    for (const endpoint of endpoints) {
      try {
        const [delivery] = await db
          .insert(schema.webhookDeliveries)
          .values({
            endpointId: endpoint.id,
            eventType,
            payload: envelope,
            state: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
          })
          .returning({ id: schema.webhookDeliveries.id });
        await webhookDeliveryQueue().add(JobNames.DeliverWebhook, {
          deliveryId: delivery.id,
          attempt: 1,
        });
      } catch (err) {
        console.warn(
          "[fonto-webhooks] failed to enqueue delivery for endpoint",
          endpoint.id,
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    console.warn(
      "[fonto-webhooks] emitWebhook failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Stripe-style signature: `t=<unix>,v1=<hex_hmac>` where the HMAC is
 * SHA-256(`${timestamp}.${body}`) keyed by the endpoint's signing secret.
 * The verifier reconstructs the same string and compares with a constant-time
 * equality check (see README for a snippet).
 */
export function signWebhookPayload(
  body: string,
  signingSecret: string,
  timestamp?: number
): { timestamp: number; signature: string; header: string } {
  const ts = typeof timestamp === "number" ? timestamp : Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${body}`;
  const sig = createHmac("sha256", signingSecret).update(signedPayload).digest("hex");
  return {
    timestamp: ts,
    signature: sig,
    header: `t=${ts},v1=${sig}`,
  };
}
