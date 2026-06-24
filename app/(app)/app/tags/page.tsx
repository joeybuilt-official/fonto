// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — Manage tags. A nested tree where you can add a sub-tag,
// rename, move (re-parent), or jump to a tag's photos. Hierarchy is stored as
// parentId + a materialized path; filtering a parent elsewhere shows all of its
// descendants' photos too. No deletes here (kept minimal; the API promotes a
// deleted parent's children to roots).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Plus,
  Pencil,
  FolderInput,
  Tag as TagIcon,
  Loader2,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface Tag {
  id: string;
  name: string;
  color?: string | null;
  parentId?: string | null;
  path?: string | null;
}

const inputCls =
  "min-w-0 flex-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] px-[var(--ft-space-2)] py-1 text-[length:var(--ft-type-body-medium-size)] text-[var(--ft-color-on-surface)] outline-none focus:border-[var(--ft-color-primary)]";

export default function ManageTagsPage(): React.ReactElement {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Per-node UI mode: adding a child / renaming / moving.
  const [adding, setAdding] = useState<string | "root" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/v1/tags", { cache: "no-store" });
    const j = (await res.json()) as { tags?: Tag[] };
    setTags(j.tags ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const byParent = useMemo(() => {
    const m = new Map<string | null, Tag[]>();
    for (const t of tags ?? []) {
      const k = t.parentId ?? null;
      const arr = m.get(k) ?? [];
      arr.push(t);
      m.set(k, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [tags]);

  const depthOf = useCallback((t: Tag) => (t.path ? t.path.split("/").filter(Boolean).length : 1), []);

  const createTag = useCallback(
    async (name: string, parentId: string | null) => {
      if (!name.trim()) return;
      setBusy(true);
      try {
        await fetch("/api/v1/tags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), parentId }),
        });
        await load();
      } finally {
        setBusy(false);
        setAdding(null);
        setDraft("");
      }
    },
    [load]
  );

  const patchTag = useCallback(
    async (id: string, body: { name?: string; parentId?: string | null }) => {
      setBusy(true);
      try {
        await fetch(`/api/v1/tags/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        await load();
      } finally {
        setBusy(false);
        setRenaming(null);
        setMoving(null);
        setDraft("");
      }
    },
    [load]
  );

  // Valid move targets: any tag that is not the node itself or one of its
  // descendants (would create a cycle). Compared via the materialized path.
  const moveTargets = useCallback(
    (node: Tag) =>
      (tags ?? []).filter((t) => !(t.path && node.path && t.path.startsWith(node.path))),
    [tags]
  );

  const renderNode = (t: Tag, depth: number): React.ReactElement => {
    const kids = byParent.get(t.id) ?? [];
    const isCollapsed = collapsed.has(t.id);
    return (
      <div key={t.id}>
        <div
          className="flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-small)] py-1 hover:bg-[var(--ft-color-surface-container-low)]"
          style={{ paddingLeft: depth * 18 + 4 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              onClick={() =>
                setCollapsed((p) => {
                  const n = new Set(p);
                  n.has(t.id) ? n.delete(t.id) : n.add(t.id);
                  return n;
                })
              }
              className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--ft-color-on-surface-variant)]"
            >
              <ChevronRight className={`h-4 w-4 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: t.color ?? "#6366f1" }}
          />

          {renaming === t.id ? (
            <form
              className="flex flex-1 items-center gap-[var(--ft-space-1)]"
              onSubmit={(e) => {
                e.preventDefault();
                void patchTag(t.id, { name: draft });
              }}
            >
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus className={inputCls} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Button type="submit" variant="filled" disabled={busy} aria-label="Save">
                <Check className="h-4 w-4" />
              </Button>
              <Button type="button" variant="text" onClick={() => setRenaming(null)} aria-label="Cancel">
                <X className="h-4 w-4" />
              </Button>
            </form>
          ) : moving === t.id ? (
            <div className="flex flex-1 items-center gap-[var(--ft-space-1)]">
              <select
                className={inputCls}
                defaultValue={t.parentId ?? ""}
                onChange={(e) => void patchTag(t.id, { parentId: e.target.value || null })}
              >
                <option value="">— Top level —</option>
                {moveTargets(t).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="text" onClick={() => setMoving(null)} aria-label="Cancel">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <Link
                href={`/app/search?tagId=${t.id}`}
                className="flex-1 truncate text-[length:var(--ft-type-body-medium-size)] capitalize text-[var(--ft-color-on-surface)] hover:underline"
              >
                {t.name}
              </Link>
              <button
                type="button"
                onClick={() => {
                  setAdding(t.id);
                  setDraft("");
                }}
                title="Add sub-tag"
                className="shrink-0 rounded-[var(--ft-shape-small)] p-1 text-[var(--ft-color-on-surface-variant)] hover:bg-[var(--ft-color-surface-container-high)]"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenaming(t.id);
                  setDraft(t.name);
                }}
                title="Rename"
                className="shrink-0 rounded-[var(--ft-shape-small)] p-1 text-[var(--ft-color-on-surface-variant)] hover:bg-[var(--ft-color-surface-container-high)]"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setMoving(t.id)}
                title="Move"
                className="shrink-0 rounded-[var(--ft-shape-small)] p-1 text-[var(--ft-color-on-surface-variant)] hover:bg-[var(--ft-color-surface-container-high)]"
              >
                <FolderInput className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {adding === t.id && (
          <form
            className="flex items-center gap-[var(--ft-space-1)] py-1"
            style={{ paddingLeft: (depth + 1) * 18 + 28 }}
            onSubmit={(e) => {
              e.preventDefault();
              void createTag(draft, t.id);
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus className={inputCls} placeholder="New sub-tag name" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <Button type="submit" variant="filled" disabled={busy}>
              Add
            </Button>
            <Button type="button" variant="text" onClick={() => setAdding(null)} aria-label="Cancel">
              <X className="h-4 w-4" />
            </Button>
          </form>
        )}

        {!isCollapsed && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const roots = byParent.get(null) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-[var(--ft-space-5)] px-[var(--ft-space-4)] py-[var(--ft-space-6)]">
      <Link
        href="/app/explore"
        className="inline-flex items-center gap-1 text-xs text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Explore
      </Link>

      <div className="flex items-start gap-[var(--ft-space-4)]">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]">
          <TagIcon className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-[var(--ft-color-on-surface)]">Manage tags</h1>
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
            Nest tags into groups — like Travel ▸ 2018 ▸ Italy. Filtering a group
            shows every photo underneath it.
          </p>
        </div>
      </div>

      {tags === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--ft-color-on-surface-variant)]" />
        </div>
      ) : (
        <div className="space-y-[var(--ft-space-2)]">
          {roots.map((r) => renderNode(r, 0))}

          {adding === "root" ? (
            <form
              className="flex items-center gap-[var(--ft-space-1)] py-1 pl-2"
              onSubmit={(e) => {
                e.preventDefault();
                void createTag(draft, null);
              }}
            >
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus className={inputCls} placeholder="New tag name" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Button type="submit" variant="filled" disabled={busy}>
                Add
              </Button>
              <Button type="button" variant="text" onClick={() => setAdding(null)} aria-label="Cancel">
                <X className="h-4 w-4" />
              </Button>
            </form>
          ) : (
            <Button
              variant="tonal"
              onClick={() => {
                setAdding("root");
                setDraft("");
              }}
            >
              <Plus className="h-4 w-4" />
              New tag
            </Button>
          )}

          {roots.length === 0 && adding !== "root" && (
            <p className="py-8 text-center text-sm text-[var(--ft-color-on-surface-variant)]">
              No tags yet. Create one to start organizing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
