// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — shared filter popover. One implementation drives every asset
// page's filter UI. Pages declare which filter slots they expose via the
// `available` prop; everything else is hidden, so the same component
// renders a 2-control popover for /trash and a 7-control popover for
// /photos without per-page forks.
//
// The popover is a presentational layer over `FilterState` from
// use-toolbar-state. It never reads the URL directly — the parent toolbar
// owns that round-trip — and emits a single `onChange(patch)` per
// interaction so the toolbar can batch URL writes if it wants to.

"use client";

import { useEffect, useState } from "react";
import { Filter, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FilterState } from "@/lib/hooks/use-toolbar-state";

const SUBTYPE_CHIPS = [
  { value: "photo", label: "Photos" },
  { value: "screenshot", label: "Screenshots" },
  { value: "mockup", label: "Mockups" },
  { value: "logo", label: "Logos" },
  { value: "icon", label: "Icons" },
  { value: "scan", label: "Scans" },
  { value: "document", label: "Documents" },
] as const;

const MIME_CHIPS = [
  { value: "image/", label: "Images" },
  { value: "video/", label: "Videos" },
  { value: "audio/", label: "Audio" },
  { value: "application/pdf", label: "PDF" },
  { value: "text/", label: "Text" },
] as const;

// Curated palette — matches the dominant-color bucketing used during
// ingest (sharp's named extraction). Hex values are display-only; the
// query string carries the name.
const COLOR_CHIPS = [
  { value: "red", hex: "#ef4444" },
  { value: "orange", hex: "#f97316" },
  { value: "yellow", hex: "#eab308" },
  { value: "green", hex: "#22c55e" },
  { value: "teal", hex: "#14b8a6" },
  { value: "blue", hex: "#3b82f6" },
  { value: "purple", hex: "#a855f7" },
  { value: "pink", hex: "#ec4899" },
  { value: "brown", hex: "#92400e" },
  { value: "gray", hex: "#6b7280" },
  { value: "black", hex: "#0a0a0a" },
  { value: "white", hex: "#fafafa" },
] as const;

interface Tag {
  id: string;
  name: string;
  color?: string | null;
}

interface Person {
  id: string;
  name: string | null;
  coverAssetId: string | null;
  instanceCount: number;
}

interface FolderLeaf {
  path: string;
  assetCount: number;
}

export type FilterKey = keyof FilterState;

interface FilterPopoverProps {
  state: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  available: FilterKey[];
  /** Reset all filter keys back to default. */
  onReset?: () => void;
}

function chipBase(active: boolean): string {
  return cn(
    "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors",
    active
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-background text-foreground hover:bg-muted"
  );
}

function activeCount(s: FilterState, keys: FilterKey[]): number {
  let n = 0;
  for (const k of keys) {
    const v = s[k];
    if (k === "q" || k === "sort") continue; // q + sort live outside the popover
    if (typeof v === "string" && v) n++;
    else if (typeof v === "boolean" && v) n++;
    else if (typeof v === "number" && v != null) n++;
    else if (Array.isArray(v) && v.length) n++;
  }
  return n;
}

export function FilterPopover({
  state,
  onChange,
  available,
  onReset,
}: FilterPopoverProps) {
  const showSubtype = available.includes("type");
  const showMime = available.includes("mime");
  const showDate = available.includes("from") || available.includes("to");
  const showColor = available.includes("color");
  const showFavorite = available.includes("favorite");
  const showRating = available.includes("ratingMin");
  const showTag = available.includes("tagIds");
  const showPerson = available.includes("personIds");
  const showFolder = available.includes("directoryPathPrefix");

  const [tags, setTags] = useState<Tag[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [folders, setFolders] = useState<FolderLeaf[]>([]);

  useEffect(() => {
    if (!showTag) return;
    let cancelled = false;
    fetch("/api/v1/tags")
      .then((r) => r.json())
      .then((d: { tags?: Tag[] }) => {
        if (!cancelled) setTags(d.tags ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showTag]);

  useEffect(() => {
    if (!showPerson) return;
    let cancelled = false;
    fetch("/api/v1/persons")
      .then((r) => r.json())
      .then((d: { persons?: Person[] }) => {
        if (!cancelled) setPeople(d.persons ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showPerson]);

  useEffect(() => {
    if (!showFolder) return;
    let cancelled = false;
    fetch("/api/v1/folders/tree")
      .then((r) => r.json())
      .then((d: { paths?: FolderLeaf[] }) => {
        if (!cancelled) setFolders(d.paths ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showFolder]);

  const n = activeCount(state, available);

  return (
    <Popover>
      <PopoverTrigger
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <Filter className="h-3.5 w-3.5" />
        <span>Filter</span>
        {n > 0 && (
          <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {n}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-h-[70vh] overflow-y-auto"
        align="end"
        sideOffset={6}
      >
        <div className="flex items-center justify-between">
          <p className="font-heading text-sm font-medium">Filter</p>
          {n > 0 && onReset && (
            <button
              onClick={onReset}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Clear all
            </button>
          )}
        </div>

        {showSubtype && (
          <Section label="Type">
            <div className="flex flex-wrap gap-1.5">
              {SUBTYPE_CHIPS.map((c) => {
                const active = state.type === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() =>
                      onChange({ type: active ? null : c.value })
                    }
                    className={chipBase(active)}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {showMime && (
          <Section label="File">
            <div className="flex flex-wrap gap-1.5">
              {MIME_CHIPS.map((c) => {
                const active = state.mime === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() =>
                      onChange({ mime: active ? null : c.value })
                    }
                    className={chipBase(active)}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {showDate && (
          <Section label="Date">
            <div className="flex items-center gap-2">
              <DateInput
                value={state.from ?? ""}
                onChange={(v) => onChange({ from: v || null })}
                label="From"
              />
              <span className="text-xs text-muted-foreground">→</span>
              <DateInput
                value={state.to ?? ""}
                onChange={(v) => onChange({ to: v || null })}
                label="To"
              />
            </div>
          </Section>
        )}

        {showColor && (
          <Section label="Color">
            <div className="flex flex-wrap gap-1.5">
              {COLOR_CHIPS.map((c) => {
                const active = state.color === c.value;
                return (
                  <button
                    key={c.value}
                    title={c.value}
                    onClick={() =>
                      onChange({ color: active ? null : c.value })
                    }
                    className={cn(
                      "h-6 w-6 rounded-full border-2 transition-transform",
                      active
                        ? "border-primary scale-110"
                        : "border-border hover:scale-105"
                    )}
                    style={{ background: c.hex }}
                  />
                );
              })}
            </div>
          </Section>
        )}

        {(showFavorite || showRating) && (
          <Section label="Quality">
            <div className="flex flex-wrap items-center gap-2">
              {showFavorite && (
                <button
                  onClick={() => onChange({ favorite: !state.favorite })}
                  className={chipBase(state.favorite)}
                >
                  ♥ Favorites only
                </button>
              )}
              {showRating && (
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((r) => {
                    const active = (state.ratingMin ?? 0) >= r;
                    return (
                      <button
                        key={r}
                        onClick={() =>
                          onChange({
                            ratingMin:
                              state.ratingMin === r ? null : r,
                          })
                        }
                        className={cn(
                          "h-6 w-6 text-base transition-colors",
                          active
                            ? "text-yellow-500"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        aria-label={`At least ${r} star${r === 1 ? "" : "s"}`}
                      >
                        ★
                      </button>
                    );
                  })}
                  {state.ratingMin != null && (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      {state.ratingMin}+
                    </span>
                  )}
                </div>
              )}
            </div>
          </Section>
        )}

        {showTag && tags.length > 0 && (
          <Section label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const active = state.tagIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() =>
                      onChange({
                        tagIds: active
                          ? state.tagIds.filter((x) => x !== t.id)
                          : [...state.tagIds, t.id],
                      })
                    }
                    className={chipBase(active)}
                    style={
                      active && t.color
                        ? { background: t.color, borderColor: t.color }
                        : undefined
                    }
                  >
                    #{t.name}
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {showPerson && people.length > 0 && (
          <Section label="People">
            <div className="flex flex-wrap gap-1.5">
              {people.slice(0, 24).map((p) => {
                const active = state.personIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      onChange({
                        personIds: active
                          ? state.personIds.filter((x) => x !== p.id)
                          : [...state.personIds, p.id],
                      })
                    }
                    className={chipBase(active)}
                  >
                    {p.name ?? "Unnamed"}{" "}
                    <span className="text-[10px] opacity-60">
                      ({p.instanceCount})
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {showFolder && folders.length > 0 && (
          <Section label="Folder">
            <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
              {folders.map((f) => {
                const active = state.directoryPathPrefix === f.path;
                return (
                  <button
                    key={f.path}
                    onClick={() =>
                      onChange({
                        directoryPathPrefix: active ? null : f.path,
                      })
                    }
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                    title={f.path}
                  >
                    <span className="truncate">{f.path}</span>
                    <span className="shrink-0 text-[10px] opacity-60">
                      {f.assetCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 pt-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function DateInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
    />
  );
}
