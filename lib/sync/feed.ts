// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.3 — shared response shape + helpers for the delta-sync feed.
//
// Each `/sync/{kind}` endpoint reads rows with `seq > cursor` ordered by
// seq ASC, mapping each to one of:
//   { op: 'delete', id, seq }                       — tombstone
//   { op: 'upsert', <entity>: {...}, seq }          — current row state
//
// "Tombstone" for assets means `deleted_at IS NOT NULL OR purged_at IS
// NOT NULL`. Tags/collections don't have lifecycle columns, so for those
// kinds a row is "deleted" only when the underlying table row is gone —
// which means at the `sync/{tags,collections}` layer we'd never see it
// to emit. (Hard-delete of tags/collections is rare and the client will
// reconcile by absence after a full refresh; in a future revision we
// can soft-delete them too.)

export type SyncOp = "upsert" | "delete";

export interface SyncDeleteEntry {
  op: "delete";
  id: string;
  seq: string;
}

export interface SyncUpsertEntry<T> {
  op: "upsert";
  seq: string;
  // The serialized entity. Key name varies by endpoint
  // (asset/tag/collection); concrete routes set this.
  [key: string]: unknown;
  entity?: T;
}

export interface SyncPage<T> {
  entries: Array<SyncDeleteEntry | SyncUpsertEntry<T>>;
  /** Highest seq returned. Client persists this and sends it back next call. */
  nextCursor: string;
  /** True if more rows likely exist beyond this page. */
  hasMore: boolean;
}
