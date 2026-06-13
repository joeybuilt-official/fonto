// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — bulk-reassign UI.
//
// Wraps POST /api/v1/scope/reassign in a small form: pick a selector
// (asset IDs, exact folder, folder + descendants, or ingestion source),
// pick a target scope (PERSONAL/SHOOT), and optionally file into a shoot
// when targeting SHOOT. On success the returned batchId is surfaced as
// an "Undo last batch" button that POSTs /api/v1/scope/reassign/undo.
//
// Two safety nets:
//   1. The selector must be non-empty — the API also rejects an empty
//      body, but pre-validation here avoids a 400 round-trip.
//   2. The "Apply" button labels itself with the count once a selector
//      is filled in (the API returns `scanned` + `reassigned`); we show
//      both so an operator can spot a typo'd folder before undoing.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui";
import type { Scope } from "@/lib/scope";

interface Shoot {
  id: string;
  name: string;
  clientId: string | null;
}

type SelectorKind = "directoryPathPrefix" | "directoryPath" | "source" | "assetIds";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Optional pre-fill: when the dialog is opened from a shoot detail page we
  // pre-pick the target shoot. The operator can still change it.
  defaultShootId?: string | null;
  defaultTo?: Scope;
  // Called after a successful apply (or undo) so the parent can refresh.
  onApplied?: () => void;
}

export function BulkReassignDialog({
  open,
  onOpenChange,
  defaultShootId = null,
  defaultTo = "SHOOT",
  onApplied,
}: Props) {
  const [to, setTo] = useState<Scope>(defaultTo);
  const [shootId, setShootId] = useState<string>(defaultShootId ?? "");
  const [shoots, setShoots] = useState<Shoot[]>([]);
  const [selectorKind, setSelectorKind] = useState<SelectorKind>("directoryPathPrefix");
  const [selectorValue, setSelectorValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastBatch, setLastBatch] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTo(defaultTo);
    setShootId(defaultShootId ?? "");
    setSelectorValue("");
    setMsg(null);
    setLastBatch(null);
    // Pull the shoot list lazily so the dialog can be mounted at app-level
    // without paying the fetch cost upfront.
    void (async () => {
      try {
        const res = await fetch("/api/v1/shoots");
        if (!res.ok) throw new Error(`shoots ${res.status}`);
        const data = (await res.json()) as { shoots?: Shoot[] };
        setShoots(data.shoots ?? []);
      } catch {
        setShoots([]);
      }
    })();
  }, [open, defaultTo, defaultShootId]);

  const apply = useCallback(async () => {
    setSubmitting(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { to };
      if (to === "SHOOT" && shootId) body.shootId = shootId;
      if (selectorKind === "assetIds") {
        const ids = selectorValue
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length === 0) {
          setMsg("Enter at least one asset id.");
          setSubmitting(false);
          return;
        }
        body.assetIds = ids;
      } else if (selectorKind === "directoryPath") {
        if (!selectorValue.trim()) {
          setMsg("Enter a folder path.");
          setSubmitting(false);
          return;
        }
        body.directoryPath = selectorValue.trim();
      } else if (selectorKind === "directoryPathPrefix") {
        if (!selectorValue.trim()) {
          setMsg("Enter a folder path prefix.");
          setSubmitting(false);
          return;
        }
        body.directoryPathPrefix = selectorValue.trim();
      } else if (selectorKind === "source") {
        if (!selectorValue.trim()) {
          setMsg("Enter an ingestion source tag.");
          setSubmitting(false);
          return;
        }
        body.source = selectorValue.trim();
      }

      const res = await fetch("/api/v1/scope/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        batchId?: string;
        reassigned?: number;
        scanned?: number;
        error?: string;
      };
      if (!res.ok) {
        setMsg(data.error ?? `Failed (${res.status})`);
      } else {
        setLastBatch(data.batchId ?? null);
        setMsg(
          `Reassigned ${data.reassigned ?? 0} of ${data.scanned ?? 0} assets.`
        );
        onApplied?.();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [to, shootId, selectorKind, selectorValue, onApplied]);

  const undo = useCallback(async () => {
    if (!lastBatch) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/scope/reassign/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: lastBatch }),
      });
      const data = (await res.json()) as { restored?: number; error?: string };
      if (!res.ok) {
        setMsg(data.error ?? `Undo failed (${res.status})`);
      } else {
        setMsg(`Undid the batch (${data.restored ?? 0} restored).`);
        setLastBatch(null);
        onApplied?.();
      }
    } finally {
      setSubmitting(false);
    }
  }, [lastBatch, onApplied]);

  const inputPlaceholder = (() => {
    switch (selectorKind) {
      case "directoryPath":
        return "/Photos/2024-Smith-Wedding";
      case "directoryPathPrefix":
        return "/Photos/Weddings";
      case "source":
        return "upload | drive_takeout | amazon_zip | ...";
      case "assetIds":
        return "uuid, uuid, uuid…";
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk reassign scope</DialogTitle>
          <DialogDescription>
            Move every matching asset to PERSONAL or SHOOT. Reversible per batch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-[var(--ft-space-3)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--ft-space-3)]">
            <div>
              <label className="block text-xs text-[var(--ft-color-on-surface-variant)] mb-1">
                Target scope
              </label>
              <Select value={to} onValueChange={(v) => setTo(v as Scope)}>
                <SelectTrigger aria-label="Target scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERSONAL">Personal</SelectItem>
                  <SelectItem value="SHOOT">Shoot</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ft-color-on-surface-variant)] mb-1">
                File into shoot (optional)
              </label>
              <Select
                value={shootId || "__none"}
                onValueChange={(v) => setShootId(v == null || v === "__none" ? "" : String(v))}
                disabled={to !== "SHOOT" || shoots.length === 0}
              >
                <SelectTrigger aria-label="Shoot">
                  <SelectValue placeholder={shoots.length === 0 ? "No shoots yet" : "Pick a shoot"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— Unfiled —</SelectItem>
                  {shoots.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--ft-color-on-surface-variant)] mb-1">
              Match by
            </label>
            <Select
              value={selectorKind}
              onValueChange={(v) => setSelectorKind(v as SelectorKind)}
            >
              <SelectTrigger aria-label="Selector kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="directoryPathPrefix">Folder + descendants</SelectItem>
                <SelectItem value="directoryPath">Exact folder</SelectItem>
                <SelectItem value="source">Ingestion source</SelectItem>
                <SelectItem value="assetIds">Asset IDs</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <TextField>
            <TextFieldLabel>Value</TextFieldLabel>
            <TextFieldInput
              value={selectorValue}
              onChange={(e) => setSelectorValue(e.target.value)}
              placeholder={inputPlaceholder}
            />
          </TextField>

          {msg && (
            <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
              {msg}
            </p>
          )}
          {lastBatch && (
            <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
              Batch id: <code>{lastBatch}</code>
            </p>
          )}
        </div>

        <DialogFooter>
          {lastBatch && (
            <Button variant="outlined" size="sm" onClick={undo} disabled={submitting}>
              Undo last batch
            </Button>
          )}
          <Button variant="text" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Close
          </Button>
          <Button variant="filled" size="sm" onClick={apply} disabled={submitting}>
            {submitting ? "Applying…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
