// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. Client island for the review queue. Fetches the
// three lanes, signs thumbnails via the existing batch URL endpoint, and drives
// per-item + batch accept/reject against /api/admin/review-queue/confirm.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Decision = "auto-commit" | "review" | "leave";

interface DateItem {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  mapEstimate: string | null;
  mapPrecision: string | null;
  ciLow: string | null;
  ciHigh: string | null;
  confidence: number;
  conflict: boolean;
  reasons: string[];
}

interface VariantGroup {
  groupId: string;
  canonicalAssetId: string;
  canonicalScore: number;
  confidence: number;
  decision: Decision;
  trashCandidates: { assetId: string; ssim: number }[];
  keptDistinct: string[];
}

interface IdentityCluster {
  personId: string;
  instanceCount: number;
  coverFaceId: string | null;
}

interface QueueResponse {
  workspaceId: string;
  date: { review: DateItem[]; counts: { review: number; autoCommit: number; leave: number } };
  variant: { groups: VariantGroup[]; limit: number };
  identity: { clusters: IdentityCluster[] };
}

type Lane = "date" | "variant" | "identity";

export function ReviewQueueClient(): React.ReactElement {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lane, setLane] = useState<Lane>("date");
  const [dateSel, setDateSel] = useState<Set<string>>(new Set());
  const [variantSel, setVariantSel] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/review-queue", { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load queue (${res.status})`);
        return;
      }
      const json = (await res.json()) as QueueResponse;
      setData(json);
      setDateSel(new Set());
      setVariantSel(new Set());

      const ids = new Set<string>();
      json.date.review.forEach((d) => ids.add(d.assetId));
      json.variant.groups.forEach((g) => {
        ids.add(g.canonicalAssetId);
        g.trashCandidates.forEach((c) => ids.add(c.assetId));
      });
      if (ids.size > 0) {
        const ures = await fetch("/api/v1/assets/urls", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [...ids], variant: "thumb" }),
        });
        if (ures.ok) {
          const ujson = (await ures.json()) as { urls?: Record<string, string> };
          setUrls(ujson.urls ?? {});
        }
      }
    } catch {
      setError("Network error loading queue");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (payload: {
      date?: { assetId: string; action: "confirm" | "reject" | "quarantine" }[];
      variant?: { groupId: string; action: "commit" }[];
    }) => {
      setBusy(true);
      setStatus(null);
      try {
        const res = await fetch("/api/admin/review-queue/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setStatus(`Action failed (${res.status})`);
          return;
        }
        const json = (await res.json()) as {
          date?: { ok: boolean }[];
          variant?: { ok: boolean; trashed: number }[];
        };
        const dateOk = (json.date ?? []).filter((r) => r.ok).length;
        const varTrash = (json.variant ?? []).reduce((a, r) => a + (r.ok ? r.trashed : 0), 0);
        const parts: string[] = [];
        if (dateOk) parts.push(`${dateOk} date${dateOk === 1 ? "" : "s"} updated`);
        if (varTrash) parts.push(`${varTrash} variant${varTrash === 1 ? "" : "s"} trashed`);
        setStatus(parts.length ? parts.join(", ") : "No changes applied");
        await load();
      } catch {
        setStatus("Network error applying changes");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const counts = useMemo(() => {
    if (!data) return { date: 0, variant: 0, identity: 0 };
    return {
      date: data.date.review.length,
      variant: data.variant.groups.length,
      identity: data.identity.clusters.length,
    };
  }, [data]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
        {error}
        <Button className="ml-3" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LaneTab label="Dates" n={counts.date} active={lane === "date"} onClick={() => setLane("date")} />
        <LaneTab label="Variants" n={counts.variant} active={lane === "variant"} onClick={() => setLane("variant")} />
        <LaneTab label="Identity" n={counts.identity} active={lane === "identity"} onClick={() => setLane("identity")} />
        {status && <span className="ml-auto text-xs text-muted-foreground">{status}</span>}
      </div>

      {lane === "date" && (
        <DateLane
          items={data.date.review}
          counts={data.date.counts}
          urls={urls}
          sel={dateSel}
          setSel={setDateSel}
          busy={busy}
          onAction={(assetId, action) => submit({ date: [{ assetId, action }] })}
          onBatch={(action) =>
            submit({ date: [...dateSel].map((assetId) => ({ assetId, action })) })
          }
        />
      )}

      {lane === "variant" && (
        <VariantLane
          groups={data.variant.groups}
          urls={urls}
          sel={variantSel}
          setSel={setVariantSel}
          busy={busy}
          onCommit={(groupId) => submit({ variant: [{ groupId, action: "commit" }] })}
          onBatch={() => submit({ variant: [...variantSel].map((groupId) => ({ groupId, action: "commit" })) })}
        />
      )}

      {lane === "identity" && <IdentityLane clusters={data.identity.clusters} />}
    </div>
  );
}

function LaneTab({ label, n, active, onClick }: { label: string; n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-sm transition-colors ${
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"
      }`}
    >
      {label} <span className="opacity-70">({n})</span>
    </button>
  );
}

function Thumb({ url, alt, className }: { url?: string; alt: string; className?: string }) {
  if (!url) {
    return <div className={`flex items-center justify-center bg-muted text-[10px] text-muted-foreground ${className ?? ""}`}>no preview</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={`object-cover ${className ?? ""}`} loading="lazy" decoding="async" />;
}

function fmtDate(d: string | null, precision?: string | null): string {
  if (!d) return "—";
  const iso = d.slice(0, 10);
  if (precision === "year") return iso.slice(0, 4);
  if (precision === "month") return iso.slice(0, 7);
  return iso;
}

function DateLane({
  items,
  counts,
  urls,
  sel,
  setSel,
  busy,
  onAction,
  onBatch,
}: {
  items: DateItem[];
  counts: { review: number; autoCommit: number; leave: number };
  urls: Record<string, string>;
  sel: Set<string>;
  setSel: (s: Set<string>) => void;
  busy: boolean;
  onAction: (assetId: string, action: "confirm" | "reject" | "quarantine") => void;
  onBatch: (action: "confirm" | "reject" | "quarantine") => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  };

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No dates need review. {counts.autoCommit} high-confidence and {counts.leave} low-confidence proposals are not surfaced here.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{sel.size} selected</span>
        <Button disabled={busy || sel.size === 0} onClick={() => onBatch("confirm")}>
          Confirm selected
        </Button>
        <Button variant="outline" disabled={busy || sel.size === 0} onClick={() => onBatch("reject")}>
          Reject selected
        </Button>
      </div>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.assetId} className="flex items-center gap-3 rounded-md border p-2">
            <input type="checkbox" checked={sel.has(it.assetId)} onChange={() => toggle(it.assetId)} aria-label="select" />
            <Thumb url={urls[it.assetId]} alt={it.filename} className="h-14 w-14 shrink-0 rounded" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{it.filename}</span>
                {it.conflict && <Badge variant="destructive">conflict</Badge>}
                <Badge variant="secondary">conf {it.confidence}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                stored {fmtDate(it.capturedAt)} → proposed{" "}
                <span className="font-medium text-foreground">{fmtDate(it.mapEstimate, it.mapPrecision)}</span>
                {it.ciLow && it.ciHigh && (
                  <span> ({fmtDate(it.ciLow)} … {fmtDate(it.ciHigh)})</span>
                )}
              </div>
              {it.reasons.length > 0 && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{it.reasons.join(" · ")}</div>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button disabled={busy} onClick={() => onAction(it.assetId, "confirm")}>
                Confirm
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => onAction(it.assetId, "reject")}>
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VariantLane({
  groups,
  urls,
  sel,
  setSel,
  busy,
  onCommit,
  onBatch,
}: {
  groups: VariantGroup[];
  urls: Record<string, string>;
  sel: Set<string>;
  setSel: (s: Set<string>) => void;
  busy: boolean;
  onCommit: (groupId: string) => void;
  onBatch: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  };
  const autoIds = groups.filter((g) => g.decision === "auto-commit").map((g) => g.groupId);
  const selAuto = [...sel].filter((id) => autoIds.includes(id));

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No variant groups need review in this sample.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{selAuto.length} auto-commit groups selected</span>
        <Button disabled={busy || selAuto.length === 0} onClick={onBatch}>
          Commit selected (reversible trash)
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setSel(new Set(autoIds))}
        >
          Select all auto-commit
        </Button>
      </div>
      <ul className="space-y-3">
        {groups.map((g) => {
          const canCommit = g.decision === "auto-commit";
          return (
            <li key={g.groupId} className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!canCommit}
                  checked={sel.has(g.groupId)}
                  onChange={() => toggle(g.groupId)}
                  aria-label="select group"
                />
                <Badge variant={canCommit ? "default" : "secondary"}>{g.decision}</Badge>
                <span className="text-xs text-muted-foreground">
                  weakest SSIM {g.confidence} · canonical quality {g.canonicalScore} · trash {g.trashCandidates.length}
                </span>
                <Button
                  className="ml-auto"
                  disabled={busy || !canCommit}
                  onClick={() => onCommit(g.groupId)}
                >
                  Commit (trash {g.trashCandidates.length})
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <figure className="text-center">
                  <Thumb url={urls[g.canonicalAssetId]} alt="canonical" className="h-20 w-20 rounded ring-2 ring-primary" />
                  <figcaption className="mt-0.5 text-[10px] text-primary">keep</figcaption>
                </figure>
                {g.trashCandidates.map((c) => (
                  <figure key={c.assetId} className="text-center">
                    <Thumb url={urls[c.assetId]} alt="variant" className="h-20 w-20 rounded opacity-70" />
                    <figcaption className="mt-0.5 text-[10px] text-muted-foreground">ssim {c.ssim}</figcaption>
                  </figure>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IdentityLane({ clusters }: { clusters: IdentityCluster[] }) {
  if (clusters.length === 0) {
    return <p className="text-sm text-muted-foreground">No unnamed face clusters.</p>;
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Unnamed face clusters. Naming + merge happens on the People page; in-queue
        elicitation arrives in Phase 5.5.
      </p>
      <ul className="flex flex-wrap gap-2">
        {clusters.map((c) => (
          <li key={c.personId} className="rounded-md border px-3 py-2 text-sm">
            <a className="underline" href={`/app/people`}>
              Unnamed cluster
            </a>
            <span className="ml-2 text-muted-foreground">{c.instanceCount} faces</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
