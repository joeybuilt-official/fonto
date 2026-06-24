// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — pure helpers for the hierarchical-tag materialized path.
// A tag's `path` is the slash-delimited, trailing-slashed list of ancestor ids
// including self: a root is '/<id>/', a child is '<parent.path><id>/'. Id-based
// so a rename never touches the path. Descendant-inclusive filter for tag X is
// `path LIKE X.path || '%'` (the trailing slash makes the prefix self-inclusive).

/** Max nesting depth (root = depth 1). Bounds path length + UI indentation. */
export const TAG_DEPTH_LIMIT = 6;

/** Number of ids in a path, i.e. the node's depth (root = 1). */
export function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/** Materialized path for a new child of `parentPath` (null/'' parent = root). */
export function childPath(parentPath: string | null | undefined, childId: string): string {
  const base = parentPath && parentPath.length > 0 ? parentPath : "/";
  return `${base}${childId}/`;
}

/** True when `candidate` is `ancestor` itself or anything beneath it. */
export function isSelfOrDescendant(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath.startsWith(ancestorPath);
}

/**
 * Rewrite one subtree row's path when the subtree root moves from
 * `oldSelfPath` to `newSelfPath`. `rowPath` must be `oldSelfPath` or a
 * descendant of it.
 */
export function rewriteSubtreePath(
  oldSelfPath: string,
  newSelfPath: string,
  rowPath: string
): string {
  return newSelfPath + rowPath.slice(oldSelfPath.length);
}
