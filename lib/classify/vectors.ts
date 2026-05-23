// SPDX-License-Identifier: AGPL-3.0-only
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

// TODO(4.2): Phase 4.2 lands `embedText(text: string)` and an exported
// `EMBEDDING_MODEL_ID` constant in `lib/plexo-vision.ts`. Until then we
// stub them at module scope so this file type-checks; the stub throws,
// which causes `loadTaxonomyVectors` to fall back to "CLIP unavailable"
// mode without breaking the rest of the worker.
type EmbedText = (text: string) => Promise<number[]>;
type PlexoVisionModule = {
  embedText: EmbedText;
  EMBEDDING_MODEL_ID: string;
};

async function loadPlexoVision(): Promise<PlexoVisionModule | null> {
  try {
    // Dynamic import so the worker boots even when 4.2 hasn't landed.
    // The string-built specifier sidesteps TS's static resolution so the
    // file type-checks pre-4.2; at runtime the import either resolves to
    // the real module or throws and we return null.
    const specifier = "@/lib/plexo-vision";
    const mod = (await import(/* webpackIgnore: true */ specifier)) as Partial<PlexoVisionModule>;
    if (typeof mod.embedText !== "function" || typeof mod.EMBEDDING_MODEL_ID !== "string") {
      return null;
    }
    return { embedText: mod.embedText, EMBEDDING_MODEL_ID: mod.EMBEDDING_MODEL_ID };
  } catch {
    return null;
  }
}

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
    const vision = await loadPlexoVision();
    const cacheFile = defaultCachePath();

    if (!vision) {
      // 4.2 hasn't landed (or vision service is misconfigured). Try the
      // disk cache anyway — better stale than nothing.
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

    const disk = await readDiskCache(cacheFile, vision.EMBEDDING_MODEL_ID);
    if (disk) {
      memoryCache = disk;
      return disk;
    }

    // Cold start: embed every prompt.
    const prompts = allPrompts();
    const vectors: TaxonomyVector[] = [];
    for (const p of prompts) {
      try {
        const vec = await vision.embedText(p.prompt);
        vectors.push({ id: p.id, vec });
      } catch (err) {
        console.warn("[fonto-classify] embedText failed for", p.id, err);
        return null;
      }
    }

    const fresh: TaxonomyCache = {
      modelId: vision.EMBEDDING_MODEL_ID,
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
