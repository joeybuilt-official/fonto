// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Vision-service client placeholder.
//
// Phase 4.2 will replace this stub with a real client that POSTs the image
// buffer (or its R2 key) to a CLIP-embedding endpoint and returns a 512-d
// float vector. Until 4.2 lands, every call returns `null` so all downstream
// dedup/search paths cleanly degrade to no-op.
//
// TODO(phase-4.2): wire up real HTTP client.

export interface EmbedImageOptions {
  /** Hard budget in milliseconds. Implementations should abort if exceeded. */
  timeoutMs?: number;
}

/**
 * Compute a CLIP image embedding for the given buffer. Returns `null` if the
 * embedding cannot be produced (service unconfigured, timed out, errored, or
 * — in this stub — always).
 *
 * The eventual real implementation will be a network call to a vision
 * sidecar; callers MUST treat it as fallible and tolerate `null`.
 */
export async function embedImage(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _buffer: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mimeType: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts?: EmbedImageOptions
): Promise<number[] | null> {
  // Phase 4.2 stub — no embedding service wired yet.
  return null;
}

/**
 * True iff a vision service is configured. Phase 4.5+ call sites short-circuit
 * inline embedding when this returns false to avoid pointless work.
 */
export function visionServiceConfigured(): boolean {
  return Boolean(process.env.PLEXO_VISION_URL);
}
