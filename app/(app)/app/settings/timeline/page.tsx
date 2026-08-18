// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core Phase 2 — "Timeline & Facts" authoring surface.
//
// Lists temporal facts (grouped by type) and lets the user create / edit /
// delete them. Drives the existing /api/v1/temporal-facts routes; the server
// owns the partial-date string→(date, precision) split, so the form just sends
// the raw string the user typed.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui";

type FactType =
  | "residence"
  | "trip"
  | "event"
  | "recurring_event"
  | "life_milestone";

const FACT_TYPES: { value: FactType; label: string }[] = [
  { value: "residence", label: "Residence" },
  { value: "trip", label: "Trip" },
  { value: "event", label: "Event" },
  { value: "recurring_event", label: "Recurring event" },
  { value: "life_milestone", label: "Life milestone" },
];

const TYPE_LABEL: Record<FactType, string> = Object.fromEntries(
  FACT_TYPES.map((t) => [t.value, t.label])
) as Record<FactType, string>;

interface Fact {
  id: string;
  workspaceId: string;
  type: FactType;
  label: string;
  dateStart: string | null;
  dateStartPrecision: string | null;
  dateEnd: string | null;
  dateEndPrecision: string | null;
  recurrence: string | null;
  locationLabel: string | null;
  personIds: string[];
  confidence: number;
  origin: string | null;
  createdAt: string;
  updatedAt: string;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Render a friendly partial-date label from the (date, precision) pair the
// server splits the raw string into. day → "Aug 11, 2014", month → "Aug 2014",
// year → "2014".
function formatPartial(
  date: string | null,
  precision: string | null
): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-");
  if (precision === "day" && y && m && d) {
    const mi = Number(m) - 1;
    return `${MONTHS[mi] ?? m} ${Number(d)}, ${y}`;
  }
  if (precision === "month" && y && m) {
    const mi = Number(m) - 1;
    return `${MONTHS[mi] ?? m} ${y}`;
  }
  return y ?? date;
}

// Reconstruct the editable partial-date string (what the user originally
// typed) from the server's normalised date + precision, so re-saving an edit
// preserves precision instead of promoting "2014-08" → day-precision
// "2014-08-01".
function toPartialInput(
  date: string | null,
  precision: string | null
): string {
  if (!date) return "";
  if (precision === "year") return date.slice(0, 4);
  if (precision === "month") return date.slice(0, 7);
  return date.slice(0, 10);
}

function formatSpan(fact: Fact): string {
  const start = formatPartial(fact.dateStart, fact.dateStartPrecision);
  const end = formatPartial(fact.dateEnd, fact.dateEndPrecision);
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return `until ${end}`;
  return "";
}

interface DraftState {
  type: FactType;
  label: string;
  dateStart: string;
  dateEnd: string;
  locationLabel: string;
  recurrence: string;
}

const EMPTY_DRAFT: DraftState = {
  type: "event",
  label: "",
  dateStart: "",
  dateEnd: "",
  locationLabel: "",
  recurrence: "",
};

export default function TimelineFactsPage() {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // null = creating; otherwise the id being edited (form is reused, prefilled).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/v1/temporal-facts");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { facts: Fact[] };
      setFacts(data.facts);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  };

  const startEdit = (fact: Fact) => {
    setEditingId(fact.id);
    setFormError(null);
    setDraft({
      type: fact.type,
      label: fact.label,
      dateStart: toPartialInput(fact.dateStart, fact.dateStartPrecision),
      dateEnd: toPartialInput(fact.dateEnd, fact.dateEndPrecision),
      locationLabel: fact.locationLabel ?? "",
      recurrence: fact.recurrence ?? "",
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.label.trim()) return;
    setBusy(true);
    setFormError(null);

    // The server splits the partial-date string itself, so send the raw
    // string the user typed (or null to clear). Recurrence is only meaningful
    // for recurring_event.
    const body: Record<string, unknown> = {
      type: draft.type,
      label: draft.label.trim(),
      dateStart: draft.dateStart.trim() || null,
      dateEnd: draft.dateEnd.trim() || null,
      locationLabel: draft.locationLabel.trim() || null,
      recurrence:
        draft.type === "recurring_event"
          ? draft.recurrence.trim() || null
          : null,
    };

    try {
      const r = await fetch(
        editingId
          ? `/api/v1/temporal-facts/${editingId}`
          : "/api/v1/temporal-facts",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) {
        const data = (await r.json().catch(() => ({ error: r.statusText }))) as {
          error?: string;
        };
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      resetForm();
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (fact: Fact) => {
    if (!confirm(`Delete "${fact.label}"? This can't be undone.`)) return;
    try {
      const r = await fetch(`/api/v1/temporal-facts/${fact.id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (editingId === fact.id) resetForm();
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  // Group + sort the list by type (in the FACT_TYPES display order).
  const grouped = FACT_TYPES.map((t) => ({
    type: t.value,
    label: t.label,
    items: (facts ?? []).filter((f) => f.type === t.value),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-[var(--ft-space-6)] max-w-3xl">
      <div className="flex items-center gap-[var(--ft-space-3)]">
        <Link
          href="/app/settings"
          className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
        >
          ← Settings
        </Link>
      </div>
      <div>
        <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)]">
          Timeline &amp; Facts
        </h1>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          Tell Fonto about the places you&apos;ve lived, trips you&apos;ve taken,
          and milestones in your family&apos;s life. These facts anchor photo
          dates, locations, and people across your library.
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-error)]/40 bg-[var(--ft-color-error-container)] p-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-error-container)]">
          {error}
        </div>
      )}

      <Card variant="outlined">
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            {editingId ? "Edit fact" : "Add a fact"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-[var(--ft-space-4)]">
            <div className="space-y-[var(--ft-space-1)]">
              <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-medium text-[var(--ft-color-on-surface-variant)]">
                Type
              </span>
              <Select
                value={draft.type}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, type: v as FactType }))
                }
              >
                <SelectTrigger aria-label="Fact type" className="h-10">
                  <SelectValue>
                    {(v) => TYPE_LABEL[v as FactType] ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {FACT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <TextField>
              <TextFieldLabel htmlFor="fact-label" className="uppercase tracking-wide">
                Label
              </TextFieldLabel>
              <TextFieldInput
                id="fact-label"
                type="text"
                value={draft.label}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, label: e.target.value }))
                }
                placeholder="e.g. Lived in Portland"
                required
              />
            </TextField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--ft-space-4)]">
              <TextField>
                <TextFieldLabel htmlFor="fact-start" className="uppercase tracking-wide">
                  Start date
                </TextFieldLabel>
                <TextFieldInput
                  id="fact-start"
                  type="text"
                  value={draft.dateStart}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, dateStart: e.target.value }))
                  }
                  placeholder="YYYY or YYYY-MM or YYYY-MM-DD"
                />
              </TextField>
              <TextField>
                <TextFieldLabel htmlFor="fact-end" className="uppercase tracking-wide">
                  End date
                </TextFieldLabel>
                <TextFieldInput
                  id="fact-end"
                  type="text"
                  value={draft.dateEnd}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, dateEnd: e.target.value }))
                  }
                  placeholder="YYYY or YYYY-MM or YYYY-MM-DD"
                />
              </TextField>
            </div>

            <TextField>
              <TextFieldLabel htmlFor="fact-location" className="uppercase tracking-wide">
                Location
              </TextFieldLabel>
              <TextFieldInput
                id="fact-location"
                type="text"
                value={draft.locationLabel}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, locationLabel: e.target.value }))
                }
                placeholder="e.g. Portland, OR"
              />
            </TextField>

            {/* Recurrence (RRULE) is only relevant for recurring events. */}
            {draft.type === "recurring_event" && (
              <TextField>
                <TextFieldLabel htmlFor="fact-recurrence" className="uppercase tracking-wide">
                  Recurrence (RRULE)
                </TextFieldLabel>
                <TextFieldInput
                  id="fact-recurrence"
                  type="text"
                  value={draft.recurrence}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, recurrence: e.target.value }))
                  }
                  placeholder="FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25"
                />
              </TextField>
            )}

            {formError && (
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-[var(--ft-space-2)]">
              {editingId && (
                <Button
                  type="button"
                  variant="text"
                  size="lg"
                  onClick={resetForm}
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                variant="filled"
                size="lg"
                disabled={busy || !draft.label.trim()}
              >
                {busy
                  ? "Saving…"
                  : editingId
                  ? "Save changes"
                  : "Add fact"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Your facts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {facts === null ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              Loading…
            </p>
          ) : facts.length === 0 ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              No facts yet. Add one above.
            </p>
          ) : (
            <div className="space-y-[var(--ft-space-5)]">
              {grouped.map((group) => (
                <div key={group.type} className="space-y-[var(--ft-space-2)]">
                  <h3 className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
                    {group.label}
                  </h3>
                  <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
                    {group.items.map((fact) => {
                      const span = formatSpan(fact);
                      return (
                        <li
                          key={fact.id}
                          className="py-[var(--ft-space-3)] flex items-center justify-between gap-[var(--ft-space-4)]"
                        >
                          <div className="space-y-[var(--ft-space-1)] min-w-0 flex-1">
                            <span className="block text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)] truncate">
                              {fact.label}
                            </span>
                            <div className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] flex flex-wrap gap-x-[var(--ft-space-3)] gap-y-[var(--ft-space-1)]">
                              {span && <span>{span}</span>}
                              {fact.locationLabel && <span>{fact.locationLabel}</span>}
                              {fact.recurrence && (
                                <span className="font-mono">{fact.recurrence}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-[var(--ft-space-2)] shrink-0">
                            <Button
                              type="button"
                              variant="outlined"
                              size="sm"
                              onClick={() => startEdit(fact)}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="outlined"
                              size="sm"
                              onClick={() => onDelete(fact)}
                              className="border-[var(--ft-color-error)]/40 text-[var(--ft-color-error)] hover:bg-[var(--ft-color-error)]/10"
                            >
                              Delete
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
