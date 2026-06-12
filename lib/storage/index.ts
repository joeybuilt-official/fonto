// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Storage facade entry point. Phase 1 wires a single R2 backend; the
// per-workspace / per-asset policy resolver (Phase B2+) will return a
// policy-appropriate backend from here without touching call sites.

import { R2Backend } from "./r2-backend";
import { LocalFsBackend } from "./local-fs-backend";
import type { StorageBackend } from "./interface";

export * from "./interface";
export * from "./policy";

let _r2: StorageBackend | null = null;
let _local: StorageBackend | null = null;

/** The R2 backend singleton. */
export function r2(): StorageBackend {
  if (!_r2) _r2 = new R2Backend();
  return _r2;
}

/** The local-filesystem backend singleton (LOCAL_STORAGE_ROOT). */
export function localFs(): StorageBackend {
  if (!_local) _local = new LocalFsBackend();
  return _local;
}

/**
 * Resolve the storage backend for a key. Phase 1: always R2. Later phases pass
 * the effective workspace/asset policy here to pick R2 vs local.
 */
export function storage(): StorageBackend {
  return r2();
}
