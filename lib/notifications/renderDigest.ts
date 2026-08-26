// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — pure rendering for the daily digest email.
//
// Takes raw activity_events rows + a userId-to-displayName lookup and
// produces the lines the transport layer sends. No side effects, no I/O —
// every input is passed in. This stays trivially testable + the digest
// worker is the only thing that has to know about transport stubs.

import type { DigestActivityLine } from "./digestEmail";
import type { schema } from "@/lib/db";

type ActivityEventRow = typeof schema.activityEvents.$inferSelect;

export interface RenderInput {
  events: ActivityEventRow[];
  // Caller resolves these once + passes them in (the digest job already
  // has each map populated for its iteration scope).
  actorDisplayName: Map<string, string>;
  assetFilename: Map<string, string>;
  // Used to build per-asset deep links. Trailing slash is normalised off
  // by the caller. e.g. "https://myfonto.com".
  webBaseUrl: string;
}

export function renderDigestLines(input: RenderInput): DigestActivityLine[] {
  const lines: DigestActivityLine[] = [];
  for (const ev of input.events) {
    const actor = ev.actorUserId
      ? input.actorDisplayName.get(ev.actorUserId) ?? ev.actorUserId
      : "Someone";
    const payload = (ev.payload ?? {}) as Record<string, unknown>;

    switch (ev.kind) {
      case "comment.posted": {
        const assetId = typeof payload.assetId === "string" ? payload.assetId : null;
        const excerpt = typeof payload.excerpt === "string" ? payload.excerpt : "";
        const filename = assetId ? input.assetFilename.get(assetId) ?? "an asset" : "an asset";
        lines.push({
          text: `${actor} commented on "${filename}": ${excerpt}`,
          link: assetId ? `${input.webBaseUrl}/app/library?lb=${assetId}` : undefined,
          occurredAt: ev.createdAt,
        });
        break;
      }
      case "comment.deleted": {
        const assetId = typeof payload.assetId === "string" ? payload.assetId : null;
        const filename = assetId ? input.assetFilename.get(assetId) ?? "an asset" : "an asset";
        lines.push({
          text: `${actor} deleted a comment on "${filename}"`,
          link: assetId ? `${input.webBaseUrl}/app/library?lb=${assetId}` : undefined,
          occurredAt: ev.createdAt,
        });
        break;
      }
      case "asset.uploaded": {
        const assetId = ev.targetId;
        const filename = assetId ? input.assetFilename.get(assetId) ?? "a new asset" : "a new asset";
        lines.push({
          text: `${actor} uploaded "${filename}"`,
          link: assetId ? `${input.webBaseUrl}/app/library?lb=${assetId}` : undefined,
          occurredAt: ev.createdAt,
        });
        break;
      }
      case "asset.shared": {
        const assetId = ev.targetId;
        const filename = assetId ? input.assetFilename.get(assetId) ?? "an asset" : "an asset";
        lines.push({
          text: `${actor} shared "${filename}" with the workspace`,
          link: assetId ? `${input.webBaseUrl}/app/library?lb=${assetId}` : undefined,
          occurredAt: ev.createdAt,
        });
        break;
      }
      default: {
        // Unknown kind — surface the raw kind name so devs see new event
        // types arrive in the digest before the renderer learns them.
        lines.push({
          text: `${actor} did "${ev.kind}"`,
          occurredAt: ev.createdAt,
        });
      }
    }
  }
  return lines;
}

export function renderDigestPlaintext(opts: {
  recipientName: string;
  workspaceName: string;
  since: Date;
  until: Date;
  lines: DigestActivityLine[];
  preferencesUrl: string;
}): string {
  const header = `Hi ${opts.recipientName},\n\nHere's what happened in ${opts.workspaceName} since ${opts.since.toUTCString()}:`;
  const body = opts.lines
    .map((l) => `  • ${l.text}${l.link ? ` (${l.link})` : ""}`)
    .join("\n");
  const footer = `\nManage notification preferences: ${opts.preferencesUrl}`;
  return `${header}\n\n${body}\n${footer}`;
}
