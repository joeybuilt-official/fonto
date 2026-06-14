// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — shoot browser landing.
//
// Layout: Client → Shoot → Stage.
//   Clients are top-level cards; each lists its shoots inline.
//   Hobby (client-less) shoots are grouped under their own card.
//   Each shoot row exposes per-stage counts (RAW / SELECTS / DELIVERED /
//   REJECTS / Unstaged) and links to the detail page.
//
// Top-level controls:
//   - "New client" + "New shoot" — minimal inline forms.
//   - "Bulk reassign" — opens the dialog (P5d).
//   - "View All in Library" — jumps to /app/library?scope=SHOOT.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Camera, FolderPlus, Plus, Repeat, Trash2, User as UserIcon } from "lucide-react";
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
import { BulkReassignDialog } from "./_components/bulk-reassign-dialog";
import { DeleteShootDialog } from "./_components/delete-shoot-dialog";

interface Client {
  id: string;
  name: string;
  notes: string;
}

type Stage = "RAW" | "SELECTS" | "DELIVERED" | "REJECTS" | "UNSTAGED";

interface Shoot {
  id: string;
  clientId: string | null;
  name: string;
  shootDate: string | null;
  kind: string | null;
  paid: boolean;
  counts: Record<Stage | "total", number>;
}

const STAGE_KEYS: Stage[] = ["RAW", "SELECTS", "DELIVERED", "REJECTS", "UNSTAGED"];
const STAGE_LABEL: Record<Stage, string> = {
  RAW: "Raw",
  SELECTS: "Selects",
  DELIVERED: "Delivered",
  REJECTS: "Rejects",
  UNSTAGED: "Unstaged",
};

export default function ShootsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [shoots, setShoots] = useState<Shoot[]>([]);
  const [loading, setLoading] = useState(true);
  const [createClientOpen, setCreateClientOpen] = useState(false);
  const [createShootOpen, setCreateShootOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newClient, setNewClient] = useState({ name: "", notes: "" });
  const [newShoot, setNewShoot] = useState<{
    name: string;
    clientId: string;
    shootDate: string;
    kind: string;
    paid: boolean;
  }>({ name: "", clientId: "", shootDate: "", kind: "", paid: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, sRes] = await Promise.all([
        fetch("/api/v1/clients"),
        fetch("/api/v1/shoots"),
      ]);
      const cData = cRes.ok ? ((await cRes.json()) as { clients?: Client[] }) : { clients: [] };
      const sData = sRes.ok ? ((await sRes.json()) as { shoots?: Shoot[] }) : { shoots: [] };
      setClients(cData.clients ?? []);
      setShoots(sData.shoots ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleShootDeleted = useCallback(
    (summary: { revertedAssets: number; batchId?: string }) => {
      setNotice(
        summary.revertedAssets > 0
          ? `Shoot deleted. ${summary.revertedAssets} ${
              summary.revertedAssets === 1 ? "photo" : "photos"
            } returned to your personal library.`
          : "Shoot deleted."
      );
      void load();
    },
    [load]
  );

  const byClient = useMemo(() => {
    const map = new Map<string, Shoot[]>();
    const hobby: Shoot[] = [];
    for (const s of shoots) {
      if (s.clientId == null) hobby.push(s);
      else {
        const arr = map.get(s.clientId) ?? [];
        arr.push(s);
        map.set(s.clientId, arr);
      }
    }
    return { map, hobby };
  }, [shoots]);

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    const name = newClient.name.trim();
    if (!name) return;
    const res = await fetch("/api/v1/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, notes: newClient.notes }),
    });
    if (res.ok) {
      setNewClient({ name: "", notes: "" });
      setCreateClientOpen(false);
      void load();
    }
  }

  async function handleCreateShoot(e: React.FormEvent) {
    e.preventDefault();
    const name = newShoot.name.trim();
    if (!name) return;
    const body: Record<string, unknown> = {
      name,
      paid: newShoot.paid,
    };
    if (newShoot.clientId) body.clientId = newShoot.clientId;
    if (newShoot.shootDate) body.shootDate = newShoot.shootDate;
    if (newShoot.kind.trim()) body.kind = newShoot.kind.trim();
    const res = await fetch("/api/v1/shoots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setNewShoot({ name: "", clientId: "", shootDate: "", kind: "", paid: false });
      setCreateShootOpen(false);
      void load();
    }
  }

  return (
    <div className="space-y-[var(--ft-space-4)] px-4 py-4">
      <div className="flex items-center justify-between gap-[var(--ft-space-3)] flex-wrap">
        <div>
          <h1 className="text-[length:var(--ft-type-title-large-size)] leading-[var(--ft-type-title-large-line)] font-semibold">
            Shoots
          </h1>
          <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
            Deliberate sessions — professional + hobby. Hidden from the personal timeline.
          </p>
        </div>
        <div className="flex items-center gap-[var(--ft-space-2)]">
          <Button variant="outlined" size="sm" onClick={() => setCreateClientOpen((v) => !v)}>
            <UserIcon className="size-3.5" /> New client
          </Button>
          <Button variant="outlined" size="sm" onClick={() => setCreateShootOpen((v) => !v)}>
            <Plus className="size-3.5" /> New shoot
          </Button>
          <Button variant="tonal" size="sm" onClick={() => setReassignOpen(true)}>
            <Repeat className="size-3.5" /> Bulk reassign
          </Button>
          <Button variant="text" size="sm" render={<Link href="/app/library?scope=SHOOT" />}>
            View all in Library
          </Button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] px-3 py-2 text-[length:var(--ft-type-body-small-size)]">
          <span>{notice}</span>
          <Button variant="text" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {createClientOpen && (
        <Card variant="outlined">
          <CardContent>
            <form onSubmit={handleCreateClient} className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--ft-space-3)] py-2">
              <TextField>
                <TextFieldLabel>Client name</TextFieldLabel>
                <TextFieldInput
                  value={newClient.name}
                  onChange={(e) => setNewClient((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Smith Family"
                  autoFocus
                />
              </TextField>
              <TextField>
                <TextFieldLabel>Notes</TextFieldLabel>
                <TextFieldInput
                  value={newClient.notes}
                  onChange={(e) => setNewClient((s) => ({ ...s, notes: e.target.value }))}
                />
              </TextField>
              <div className="sm:col-span-2 flex justify-end gap-[var(--ft-space-2)]">
                <Button type="button" variant="text" size="sm" onClick={() => setCreateClientOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="filled" size="sm">
                  Create client
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {createShootOpen && (
        <Card variant="outlined">
          <CardContent>
            <form onSubmit={handleCreateShoot} className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--ft-space-3)] py-2">
              <TextField>
                <TextFieldLabel>Shoot name</TextFieldLabel>
                <TextFieldInput
                  value={newShoot.name}
                  onChange={(e) => setNewShoot((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Smith Wedding"
                  autoFocus
                />
              </TextField>
              <div>
                <label className="block text-xs text-[var(--ft-color-on-surface-variant)] mb-1">Client (optional)</label>
                <Select
                  value={newShoot.clientId || "__none"}
                  onValueChange={(v) =>
                    setNewShoot((s) => ({
                      ...s,
                      clientId: v == null || v === "__none" ? "" : String(v),
                    }))
                  }
                >
                  <SelectTrigger aria-label="Client">
                    <SelectValue placeholder="— Hobby (no client) —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— Hobby (no client) —</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <TextField>
                <TextFieldLabel>Date</TextFieldLabel>
                <TextFieldInput
                  type="date"
                  value={newShoot.shootDate}
                  onChange={(e) => setNewShoot((s) => ({ ...s, shootDate: e.target.value }))}
                />
              </TextField>
              <TextField>
                <TextFieldLabel>Kind</TextFieldLabel>
                <TextFieldInput
                  value={newShoot.kind}
                  onChange={(e) => setNewShoot((s) => ({ ...s, kind: e.target.value }))}
                  placeholder="wedding | senior | hobby | …"
                />
              </TextField>
              <label className="flex items-center gap-2 text-[length:var(--ft-type-body-small-size)]">
                <input
                  type="checkbox"
                  checked={newShoot.paid}
                  onChange={(e) => setNewShoot((s) => ({ ...s, paid: e.target.checked }))}
                />
                Paid
              </label>
              <div className="sm:col-span-2 flex justify-end gap-[var(--ft-space-2)]">
                <Button type="button" variant="text" size="sm" onClick={() => setCreateShootOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="filled" size="sm">
                  Create shoot
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-[var(--ft-color-on-surface-variant)]">Loading…</p>
      ) : (
        <div className="space-y-[var(--ft-space-4)]">
          {clients.map((c) => (
            <ClientBlock
              key={c.id}
              client={c}
              shoots={byClient.map.get(c.id) ?? []}
              onChanged={handleShootDeleted}
            />
          ))}

          {byClient.hobby.length > 0 && (
            <Card variant="outlined">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-[length:var(--ft-type-title-medium-size)]">
                  <Camera className="size-4" /> Hobby (no client)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-[var(--ft-space-2)]">
                  {byClient.hobby.map((s) => (
                    <ShootRow key={s.id} shoot={s} onChanged={handleShootDeleted} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {clients.length === 0 && byClient.hobby.length === 0 && (
            <Card variant="outlined">
              <CardContent>
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FolderPlus className="size-10 text-[var(--ft-color-on-surface-variant)] mb-3" />
                  <p className="font-medium">No shoots yet</p>
                  <p className="text-sm text-[var(--ft-color-on-surface-variant)] mt-1">
                    Create a client + shoot, or bulk-reassign an existing folder.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <BulkReassignDialog
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        onApplied={() => void load()}
      />
    </div>
  );
}

function ClientBlock({
  client,
  shoots,
  onChanged,
}: {
  client: Client;
  shoots: Shoot[];
  onChanged?: (summary: { revertedAssets: number; batchId?: string }) => void;
}) {
  return (
    <Card variant="outlined">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[length:var(--ft-type-title-medium-size)]">
          <UserIcon className="size-4" /> {client.name}
        </CardTitle>
        {client.notes && (
          <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
            {client.notes}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {shoots.length === 0 ? (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">No shoots for this client yet.</p>
        ) : (
          <div className="space-y-[var(--ft-space-2)]">
            {shoots.map((s) => (
              <ShootRow key={s.id} shoot={s} onChanged={onChanged} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ShootRow({
  shoot,
  onChanged,
}: {
  shoot: Shoot;
  onChanged?: (summary: { revertedAssets: number; batchId?: string }) => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <div className="flex items-center gap-[var(--ft-space-2)] rounded-lg border border-[var(--ft-color-outline-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_4%,transparent)] transition-colors">
      <Link
        href={`/app/shoots/${shoot.id}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-[var(--ft-space-3)] px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{shoot.name}</p>
          <p className="text-xs text-[var(--ft-color-on-surface-variant)] truncate">
            {[
              shoot.shootDate ?? null,
              shoot.kind ?? null,
              shoot.paid ? "paid" : null,
            ]
              .filter(Boolean)
              .join(" • ") || "—"}
          </p>
        </div>
        <div className="flex items-center gap-[var(--ft-space-2)] flex-wrap justify-end">
          {STAGE_KEYS.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--ft-color-surface-container-low)] px-2 py-0.5 text-xs text-[var(--ft-color-on-surface-variant)]"
              title={STAGE_LABEL[k]}
            >
              {STAGE_LABEL[k]} {shoot.counts[k]}
            </span>
          ))}
        </div>
      </Link>
      <Button
        variant="text"
        size="sm"
        className="mr-1 text-destructive"
        aria-label={`Delete shoot ${shoot.name}`}
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <DeleteShootDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        shoot={{ id: shoot.id, name: shoot.name, total: shoot.counts.total }}
        onDeleted={onChanged}
      />
    </div>
  );
}
