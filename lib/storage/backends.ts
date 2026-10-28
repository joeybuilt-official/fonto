// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Backend singletons, extracted from the storage facade so `read.ts` can reach them without importing
// the barrel that re-exports `read.ts` itself. That barrel import was the repo's one dependency cycle
// (`index -> read -> index`); `pnpm arch` now fails on any cycle, so the wiring lives here and both
// sides point at it instead of at each other.

import { R2Backend } from "./r2-backend";
import { LocalFsBackend } from "./local-fs-backend";
import type { StorageBackend } from "./interface";

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
