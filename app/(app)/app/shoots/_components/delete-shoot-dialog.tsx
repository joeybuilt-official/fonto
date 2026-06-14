// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 — deliberate shoot deletion.
//
// Deleting a shoot is destructive-adjacent: the shoot row is removed and every
// photo filed into it is reverted to scope='PERSONAL' (returned to the personal
// timeline — NOT deleted). To make this a deliberate action rather than a
// one-click slip:
//   - the dialog states exactly how many photos move and where they go;
//   - a non-empty shoot requires typing the shoot's name to arm the button;
//   - the result reports the count + batchId (bulk-reassign can undo it).
"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shoot: { id: string; name: string; total: number };
  // Called after a successful delete with the API summary so the parent can
  // refresh + surface a toast.
  onDeleted?: (summary: { revertedAssets: number; batchId?: string }) => void;
}

export function DeleteShootDialog({ open, onOpenChange, shoot, onDeleted }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setMsg(null);
    }
  }, [open]);

  const nonEmpty = shoot.total > 0;
  // Non-empty shoots demand a typed-name match before the button arms.
  const armed = !nonEmpty || confirmText.trim() === shoot.name.trim();

  async function handleDelete() {
    if (!armed) return;
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/v1/shoots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: shoot.id }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        revertedAssets?: number;
        batchId?: string;
        error?: string;
      };
      if (!res.ok) {
        setMsg(data.error ?? `Delete failed (${res.status})`);
        return;
      }
      onDeleted?.({ revertedAssets: data.revertedAssets ?? 0, batchId: data.batchId });
      onOpenChange(false);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{shoot.name}”?</DialogTitle>
          <DialogDescription>
            {nonEmpty ? (
              <>
                This shoot has <strong>{shoot.total}</strong>{" "}
                {shoot.total === 1 ? "photo" : "photos"}. Deleting the shoot returns{" "}
                {shoot.total === 1 ? "it" : "them"} to your <strong>personal library</strong> —
                the {shoot.total === 1 ? "photo is" : "photos are"} <strong>not</strong> deleted.
                You can undo this from Bulk reassign.
              </>
            ) : (
              <>This shoot has no photos. It will be removed.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {nonEmpty && (
          <TextField>
            <TextFieldLabel>
              Type the shoot name to confirm: <code>{shoot.name}</code>
            </TextFieldLabel>
            <TextFieldInput
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={shoot.name}
              autoFocus
            />
          </TextField>
        )}

        {msg && (
          <p className="text-[length:var(--ft-type-body-small-size)] text-destructive">{msg}</p>
        )}

        <DialogFooter>
          <Button variant="text" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={!armed || submitting}
          >
            <Trash2 className="size-3.5" />
            {submitting
              ? "Deleting…"
              : nonEmpty
                ? `Delete & return ${shoot.total} ${shoot.total === 1 ? "photo" : "photos"}`
                : "Delete shoot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
