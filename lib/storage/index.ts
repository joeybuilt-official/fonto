// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Storage facade entry point. Phase 1 wires a single R2 backend; the
// per-workspace / per-asset policy resolver (Phase B2+) will return a
// policy-appropriate backend from here without touching call sites.

import type { StorageBackend } from "./interface";
import { r2 } from "./backends";

export * from "./interface";
export * from "./policy";
export * from "./read";
export { r2, localFs } from "./backends";

/**
 * Resolve the storage backend for a key. Phase 1: always R2. Later phases pass
 * the effective workspace/asset policy here to pick R2 vs local.
 */
export function storage(): StorageBackend {
  return r2();
}
