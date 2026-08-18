// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-2 — left-rail collapsible folder tree for /app/folders.
//
// Fetches the full path list from /api/v1/folders/tree on mount, builds
// a nested tree client-side, then renders it with expand/collapse. The
// active node (matching the page's `currentPath`) gets highlighted.
//
// Drop targets: every node is a valid PhotoCard drop target via the
// same `application/x-fonto-asset` MIME the FolderCard uses, so users
// can drag an asset from the right pane onto any folder in the tree
// (not just the visible children at the current level).
//
// Expand state lives in localStorage keyed by workspace + tree key, so
// a refresh keeps the tree at the user's last shape.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Home,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TreeNode {
  name: string;
  path: string; // "/Photos/2024"
  assetCount: number; // leaf-only count (assets exactly at this path)
  children: TreeNode[];
}

interface FolderTreeResponse {
  paths: Array<{ path: string; assetCount: number }>;
  rootAssetCount: number;
}

const EXPAND_KEY = "fonto.folderTree.expanded";

/**
 * Build a nested tree from the flat path list. Intermediate nodes that
 * have no asset rows of their own (e.g. `/Photos` when only
 * `/Photos/2024` exists) get a synthetic node with assetCount=0 so the
 * UI can still navigate through them.
 */
function buildTree(
  paths: Array<{ path: string; assetCount: number }>
): TreeNode[] {
  const root: TreeNode = { name: "", path: "", assetCount: 0, children: [] };
  for (const { path, assetCount } of paths) {
    const segs = path.split("/").filter(Boolean);
    let cur = root;
    let acc = "";
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      acc += "/" + seg;
      let child = cur.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: acc, assetCount: 0, children: [] };
        cur.children.push(child);
      }
      if (i === segs.length - 1) {
        child.assetCount = assetCount;
      }
      cur = child;
    }
  }
  // Recursive alpha sort. The flat list arrives sorted, so children of
  // the same parent are already sorted; this just keeps it stable when a
  // synthetic parent gets injected mid-walk.
  function sortRec(n: TreeNode) {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortRec);
  }
  sortRec(root);
  return root.children;
}

function descendantCount(n: TreeNode): number {
  let c = n.assetCount;
  for (const child of n.children) c += descendantCount(child);
  return c;
}

function loadExpanded(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPAND_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveExpanded(s: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPAND_KEY, JSON.stringify([...s]));
  } catch {
    // Quota or disabled — silently drop; the tree still works in-memory.
  }
}

/**
 * Compute every ancestor path of `target`, inclusive of the target
 * itself. Used to auto-expand the tree to the current page's folder so
 * the active node is visible on first paint.
 */
function ancestorPaths(target: string): string[] {
  if (!target) return [];
  const segs = target.split("/").filter(Boolean);
  const out: string[] = [];
  let acc = "";
  for (const s of segs) {
    acc += "/" + s;
    out.push(acc);
  }
  return out;
}

export function FolderTree({
  currentPath,
  onAssetDrop,
}: {
  currentPath: string;
  onAssetDrop?: (folderPath: string, assetId: string) => void;
}) {
  const [data, setData] = useState<FolderTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());
  const [reloadKey, setReloadKey] = useState(0);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Auto-expand every ancestor of currentPath on path change. We don't
  // collapse anything the user opened — only ever additive.
  useEffect(() => {
    const ancestors = ancestorPaths(currentPath);
    if (ancestors.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- additively expand ancestors when currentPath changes
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      saveExpanded(next);
      return next;
    });
  }, [currentPath]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset load state on reload before refetch
    setLoading(true);
    setError(null);
    fetch("/api/v1/folders/tree")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<FolderTreeResponse>;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const tree = useMemo(() => (data ? buildTree(data.paths) : []), [data]);

  const toggle = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      saveExpanded(next);
      return next;
    });
  }, []);

  const handleDrop = useCallback(
    (path: string, e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const assetId = e.dataTransfer.getData("application/x-fonto-asset");
      if (assetId && onAssetDrop) onAssetDrop(path, assetId);
    },
    [onAssetDrop]
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/30">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Folders
        </span>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Refresh folder tree"
          title="Refresh"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* Root entry is always visible — clicking it navigates to /app/folders. */}
        <RowLink
          path=""
          name="Root"
          icon={<Home className="h-3.5 w-3.5" />}
          depth={0}
          active={currentPath === ""}
          assetCount={data?.rootAssetCount ?? 0}
          dragOver={dragOver === ""}
          onDragEnter={() => setDragOver("")}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => handleDrop("", e)}
        />

        {loading && !data && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">tree: {error}</div>
        )}

        {tree.map((node) => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={1}
            expanded={expanded}
            currentPath={currentPath}
            onToggle={toggle}
            dragOver={dragOver}
            onDragEnter={setDragOver}
            onDragLeave={() => setDragOver(null)}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  currentPath,
  onToggle,
  dragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  currentPath: string;
  onToggle: (path: string) => void;
  dragOver: string | null;
  onDragEnter: (path: string) => void;
  onDragLeave: () => void;
  onDrop: (path: string, e: React.DragEvent) => void;
}) {
  const isOpen = expanded.has(node.path);
  const hasChildren = node.children.length > 0;
  const count = descendantCount(node);
  const active = currentPath === node.path;

  return (
    <>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.path)}
            className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            style={{ marginLeft: depth * 10 }}
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span
            className="shrink-0"
            style={{ marginLeft: depth * 10, width: 18 }}
          />
        )}
        <RowLink
          path={node.path}
          name={node.name}
          icon={
            isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 text-primary-text" />
            ) : (
              <FolderIcon className="h-3.5 w-3.5 text-primary-text" />
            )
          }
          depth={0 /* indent handled by the wrapper above */}
          active={active}
          assetCount={count}
          dragOver={dragOver === node.path}
          onDragEnter={() => onDragEnter(node.path)}
          onDragLeave={onDragLeave}
          onDrop={(e) => onDrop(node.path, e)}
        />
      </div>
      {isOpen &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            currentPath={currentPath}
            onToggle={onToggle}
            dragOver={dragOver}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          />
        ))}
    </>
  );
}

function RowLink({
  path,
  name,
  icon,
  depth,
  active,
  assetCount,
  dragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: {
  path: string;
  name: string;
  icon: React.ReactNode;
  depth: number;
  active: boolean;
  assetCount: number;
  dragOver: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const href = path === "" ? "/app/folders" : `/app/folders?path=${encodeURIComponent(path)}`;
  return (
    <Link
      href={href}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-fonto-asset")) {
          e.preventDefault();
          onDragEnter();
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) onDragLeave();
      }}
      onDrop={onDrop}
      className={cn(
        "group flex flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors min-w-0",
        active ? "bg-primary/10 text-foreground font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        dragOver && "ring-2 ring-primary"
      )}
      style={{ marginLeft: depth * 10 }}
    >
      {icon}
      <span className="truncate flex-1">{name}</span>
      {assetCount > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
          {assetCount}
        </span>
      )}
    </Link>
  );
}
