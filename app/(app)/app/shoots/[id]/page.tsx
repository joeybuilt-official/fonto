// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — shoot detail (Stage browser).
//
// Tabs across the top: All · RAW · SELECTS · DELIVERED · REJECTS · Unstaged.
// Each tab filters via /api/v1/assets?scope=SHOOT&shootId=…&shootStage=….
// Selecting assets and clicking "Move to <stage>" calls PATCH on each id.
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Repeat, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { type Asset } from "../../_components/photo-card";
import { AssetGrid } from "../../_components/asset-grid";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { SHOOT_STAGES, type ShootStage } from "@/lib/scope";
import { BulkReassignDialog } from "../_components/bulk-reassign-dialog";
import { DeleteShootDialog } from "../_components/delete-shoot-dialog";

interface Shoot {
  id: string;
  clientId: string | null;
  name: string;
  shootDate: string | null;
  kind: string | null;
  paid: boolean;
  consentStatus: string | null;
  counts: Record<ShootStage | "UNSTAGED" | "total", number>;
}

interface Client {
  id: string;
  name: string;
}

type StageTab = "all" | ShootStage | "unstaged";

const STAGE_TABS: Array<{ value: StageTab; label: string }> = [
  { value: "all", label: "All" },
  ...SHOOT_STAGES.map((s) => ({ value: s as StageTab, label: titleCase(s) })),
  { value: "unstaged", label: "Unstaged" },
];

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function ShootDetailInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const shootId = params.id;

  const tab = ((): StageTab => {
    const raw = sp.get("stage");
    if (raw === "unstaged") return "unstaged";
    if (raw && SHOOT_STAGES.includes(raw as ShootStage)) return raw as StageTab;
    return "all";
  })();

  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const toolbar = useToolbarState({
    page: `shoot:${shootId}`,
    availableFilters: [],
  });

  // Load the shoot row (+ its counts) + parent client name.
  const loadShoot = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/shoots");
      if (!res.ok) return;
      const data = (await res.json()) as { shoots?: Shoot[] };
      const s = (data.shoots ?? []).find((x) => x.id === shootId) ?? null;
      setShoot(s);
      if (s?.clientId) {
        const cRes = await fetch("/api/v1/clients");
        if (cRes.ok) {
          const cData = (await cRes.json()) as { clients?: Client[] };
          setClient((cData.clients ?? []).find((c) => c.id === s.clientId) ?? null);
        }
      } else {
        setClient(null);
      }
    } catch {
      // non-fatal
    }
  }, [shootId]);

  // Load the asset list for the active stage.
  const loadAssets = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    qs.set("scope", "SHOOT");
    qs.set("shootId", shootId);
    if (tab !== "all") qs.set("shootStage", tab);
    try {
      const res = await fetch(`/api/v1/assets?${qs.toString()}`);
      if (!res.ok) throw new Error(`assets ${res.status}`);
      const data = (await res.json()) as { assets?: Asset[] };
      setAssets(data.assets ?? []);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [shootId, tab]);

  useEffect(() => {
    void loadShoot();
  }, [loadShoot, refreshKey]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets, refreshKey]);

  function setTab(value: StageTab) {
    const next = new URLSearchParams(sp.toString());
    if (value === "all") next.delete("stage");
    else next.set("stage", value);
    const q = next.toString();
    router.push(`/app/shoots/${shootId}${q ? `?${q}` : ""}`);
  }

  // Bulk-stage the current selection. Calls PATCH per id (matches the existing
  // per-asset PATCH surface; no bulk-stage endpoint introduced).
  const moveSelectionTo = useCallback(
    async (stage: ShootStage | null) => {
      const ids = Array.from(toolbar.selectedIds);
      if (ids.length === 0) return;
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/v1/assets/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shootStage: stage }),
          })
        )
      );
      toolbar.clearSelection();
      setRefreshKey((k) => k + 1);
    },
    [toolbar]
  );

  const headerSubtitle = useMemo(() => {
    if (!shoot) return null;
    return [
      client?.name ?? "Hobby",
      shoot.shootDate ?? null,
      shoot.kind ?? null,
      shoot.paid ? "paid" : null,
    ]
      .filter(Boolean)
      .join(" • ");
  }, [shoot, client]);

  return (
    <div className="space-y-[var(--ft-space-3)] px-4 py-4">
      <div className="flex items-center justify-between gap-[var(--ft-space-3)] flex-wrap">
        <div className="flex items-center gap-[var(--ft-space-2)] min-w-0">
          <Button variant="text" size="sm" render={<Link href="/app/shoots" />}>
            <ArrowLeft className="size-3.5" /> All shoots
          </Button>
          <div className="min-w-0">
            <h1 className="text-[length:var(--ft-type-title-large-size)] font-semibold truncate">
              {shoot?.name ?? "Shoot"}
            </h1>
            {headerSubtitle && (
              <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)] truncate">
                {headerSubtitle}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-[var(--ft-space-2)]">
          <Button variant="tonal" size="sm" onClick={() => setReassignOpen(true)}>
            <Repeat className="size-3.5" /> File in / out
          </Button>
          <Button
            variant="text"
            size="sm"
            className="text-destructive"
            onClick={() => setDeleteOpen(true)}
            disabled={!shoot}
          >
            <Trash2 className="size-3.5" /> Delete shoot
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-[var(--ft-space-2)]">
        {STAGE_TABS.map((t) => {
          const count =
            t.value === "all"
              ? shoot?.counts.total ?? 0
              : t.value === "unstaged"
                ? shoot?.counts.UNSTAGED ?? 0
                : (shoot?.counts[t.value as ShootStage] ?? 0);
          const selected = tab === t.value;
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              data-selected={selected ? "true" : "false"}
              className="rounded-full border border-[var(--ft-color-outline)] data-[selected=true]:border-transparent data-[selected=true]:bg-[var(--ft-color-secondary-container)] data-[selected=true]:text-[var(--ft-color-on-secondary-container)] px-3 py-1 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
            >
              {t.label} <span className="opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {toolbar.selectedIds.size > 0 && (
        <Card variant="outlined">
          <CardContent className="flex items-center justify-between gap-[var(--ft-space-3)] flex-wrap py-3">
            <p className="text-sm">
              {toolbar.selectedIds.size} selected — move to stage:
            </p>
            <div className="flex gap-[var(--ft-space-2)] flex-wrap">
              {SHOOT_STAGES.map((s) => (
                <Button
                  key={s}
                  variant="outlined"
                  size="sm"
                  onClick={() => void moveSelectionTo(s)}
                >
                  {titleCase(s)}
                </Button>
              ))}
              <Button
                variant="text"
                size="sm"
                onClick={() => void moveSelectionTo(null)}
              >
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-[var(--ft-color-on-surface-variant)]">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : assets.length === 0 ? (
        <Card variant="outlined">
          <CardHeader>
            <CardTitle className="text-[length:var(--ft-type-title-medium-size)]">
              No assets in this view
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
              Use “File in / out” to bulk-assign assets to this shoot, then move them through stages.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AssetGrid assets={assets} toolbar={toolbar} viewMode="grid" />
      )}

      <BulkReassignDialog
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        defaultShootId={shootId}
        defaultTo="SHOOT"
        onApplied={() => setRefreshKey((k) => k + 1)}
      />

      {shoot && (
        <DeleteShootDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          shoot={{ id: shoot.id, name: shoot.name, total: shoot.counts.total }}
          onDeleted={() => router.push("/app/shoots")}
        />
      )}
    </div>
  );
}

export default function ShootDetailPage() {
  return (
    <Suspense fallback={<div className="px-4 py-4 text-sm text-[var(--ft-color-on-surface-variant)]">Loading…</div>}>
      <ShootDetailInner />
    </Suspense>
  );
}
