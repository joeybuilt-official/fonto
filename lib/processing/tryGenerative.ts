// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Policy: which generative-step failures are terminal, and which must retry.
 *
 * This is a business rule, not plumbing, so it lives in one module with one
 * test rather than being re-decided at each call site.
 */
// Relative, not "@/": this module is unit-tested and the alias is not wired
// for vitest. `client` re-exports this exact class, so `instanceof` matches
// regardless of which path a call site imported it through.
import { CapabilityUnavailableError } from "../intelligence/ports";
import { describeError } from "../errors/describeError";

/** Outcome of a generative step that is allowed to be unavailable. */
export type Generative<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Run a generative (LLM/VLM) step, degrading instead of failing when the
 * capability is UNAVAILABLE — and only then.
 *
 * The distinction is the whole point. `CapabilityUnavailableError` means no
 * tier is configured or routable: retrying reproduces it exactly, so failing
 * the job buys nothing and costs the asset its cheap, already-computed signals.
 * That is how 6,704 rows that had a thumbnail AND a CLIP vector — viewable and
 * searchable — were stamped `failed` on 2026-09-04 over a missing caption.
 *
 * Every OTHER error still throws. A timeout, a socket reset, or a 5xx is
 * transient by nature and MUST keep its BullMQ retry; swallowing those would
 * silently downgrade recoverable assets to a permanent degraded state.
 */
export async function tryGenerative<T>(run: () => Promise<T>): Promise<Generative<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      return { ok: false, reason: describeError(err) };
    }
    throw err;
  }
}
