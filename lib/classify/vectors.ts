// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.6 — pre-computed text embeddings for the zero-shot taxonomy.
//
// At process boot (lazily, on first classify request) we embed every
// taxonomy prompt via `embedText()` and cache the resulting vectors in
// memory. We also persist the cache to disk so successive boots skip the
// embed round-trips. The cache file embeds the `modelId` so model changes
// invalidate the cache automatically.
//
// If the vision service is unreachable, the loader logs a warning and
// returns `null`. The caller (`classifyAsset` in ./classify.ts) treats
// this as "CLIP unavailable" and falls through to the LLM classifier —
// see Phase 4.6 plan, fallback section.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { allPrompts, TAXONOMY_PROMPT_COUNT } from "./taxonomy";
import { intelligence, CapabilityUnavailableError } from "@/lib/intelligence/client";

export interface TaxonomyVector {
  /** `top:<key>` or `sub:<topKey>:<subKey>` */
  id: string;
  vec: number[];
}

export interface TaxonomyCache {
  modelId: string;
  embeddedAt: string;
  vectors: TaxonomyVector[];
}

function defaultCachePath(): string {
  if (process.env.CLASSIFY_VECTOR_CACHE_PATH) {
    return process.env.CLASSIFY_VECTOR_CACHE_PATH;
  }
  return path.join(os.homedir(), ".fonto", "classify-vectors.json");
}

let memoryCache: TaxonomyCache | null = null;
let inflight: Promise<TaxonomyCache | null> | null = null;

async function readDiskCache(file: string, modelId: string): Promise<TaxonomyCache | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as TaxonomyCache;
    if (parsed.modelId !== modelId) {
      console.info("[fonto-classify] taxonomy cache modelId mismatch, will re-embed");
      return null;
    }
    if (!Array.isArray(parsed.vectors) || parsed.vectors.length !== TAXONOMY_PROMPT_COUNT) {
      console.info("[fonto-classify] taxonomy cache size mismatch, will re-embed");
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCache(file: string, cache: TaxonomyCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(cache), "utf8");
  } catch (err) {
    console.warn("[fonto-classify] failed to persist taxonomy cache:", err);
  }
}

/**
 * Build or load the taxonomy vector cache. Returns `null` if the vision
 * service is unreachable AND no on-disk cache exists; callers treat that
 * as "CLIP unavailable, fall back to LLM".
 */
export async function loadTaxonomyVectors(): Promise<TaxonomyCache | null> {
  if (memoryCache) return memoryCache;
  if (inflight) return inflight;

  inflight = (async (): Promise<TaxonomyCache | null> => {
    const cacheFile = defaultCachePath();
    const prompts = allPrompts();

    // Probe with the first prompt: one call yields both the live modelId
    // (which gates the disk cache) and the first vector. Capability
    // unavailable → the same stale-disk-or-LLM path the pre-Jex code took
    // when the vision module was missing/misconfigured.
    let first: { vector: number[]; modelId: string };
    try {
      const r = await intelligence.embedText(prompts[0].prompt);
      first = { vector: [...r.vector], modelId: r.modelId };
    } catch (err) {
      if (err instanceof CapabilityUnavailableError) {
        // Try the disk cache anyway — better stale than nothing.
        const probe = await fs.readFile(cacheFile, "utf8").catch(() => null);
        if (probe) {
          try {
            const parsed = JSON.parse(probe) as TaxonomyCache;
            console.warn(
              "[fonto-classify] vision service unavailable; using stale on-disk cache (modelId=%s)",
              parsed.modelId,
            );
            memoryCache = parsed;
            return parsed;
          } catch {
            /* fall through */
          }
        }
        console.warn(
          "[fonto-classify] vision service unavailable and no cache present — falling back to LLM classifier",
        );
        return null;
      }
      console.warn("[fonto-classify] embedText failed for", prompts[0].id, err);
      return null;
    }

    const disk = await readDiskCache(cacheFile, first.modelId);
    if (disk) {
      memoryCache = disk;
      return disk;
    }

    // Cold start: embed the remaining prompts (the probe already covered
    // prompts[0]).
    const vectors: TaxonomyVector[] = [{ id: prompts[0].id, vec: first.vector }];
    for (const p of prompts.slice(1)) {
      try {
        const { vector } = await intelligence.embedText(p.prompt);
        vectors.push({ id: p.id, vec: [...vector] });
      } catch (err) {
        console.warn("[fonto-classify] embedText failed for", p.id, err);
        return null;
      }
    }

    const fresh: TaxonomyCache = {
      modelId: first.modelId,
      embeddedAt: new Date().toISOString(),
      vectors,
    };
    await writeDiskCache(cacheFile, fresh);
    memoryCache = fresh;
    return fresh;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test/utility — drop the in-memory cache. Disk cache untouched. */
export function _resetTaxonomyCacheForTests(): void {
  memoryCache = null;
  inflight = null;
}
