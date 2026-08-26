// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Folder rename / move / delete dialog, lifted out of the /app/folders page so
// Library can offer the same folder management (M2 canonical parity — folder
// CRUD in Library). Backs onto POST /api/v1/folders/operation via the caller's
// onSubmit. Folders are directory_path prefixes, not rows, so every op is a
// bulk UPDATE server-side.

"use client";

import { useState } from "react";
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

export type FolderOpTarget = { name: string; path: string };
export type FolderOpAction = "rename" | "move" | "delete";

// The parent path of a folder path ("" = root). Kept here so both the dialog's
// default "move" target and any caller share one definition.
export function parentOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  segs.pop();
  return segs.length === 0 ? "" : "/" + segs.join("/");
}

export function FolderOpDialog({
  op,
  onClose,
  onSubmit,
}: {
  op: { action: FolderOpAction; folder: FolderOpTarget };
  onClose: () => void;
  onSubmit: (
    payload: Record<string, unknown>,
    folderPath: string
  ) => Promise<string | null>;
}) {
  const { action, folder } = op;
  const [name, setName] = useState(action === "rename" ? folder.name : "");
  const [parent, setParent] = useState(
    action === "move" ? parentOf(folder.path) : ""
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const renameValid =
    trimmedName.length > 0 &&
    !trimmedName.includes("/") &&
    trimmedName !== folder.name;

  async function submit(payload: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    const err = await onSubmit(payload, folder.path);
    setSubmitting(false);
    if (err) setError(err);
    else onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {action === "rename" && (
          <>
            <DialogHeader>
              <DialogTitle>Rename folder</DialogTitle>
              <DialogDescription>
                Rename “{folder.name}”. Names can’t be empty or contain “/”.
              </DialogDescription>
            </DialogHeader>
            <TextField variant="outlined">
              <TextFieldLabel>New name</TextFieldLabel>
              <TextFieldInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={folder.name}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameValid && !submitting) {
                    void submit({
                      op: "rename",
                      path: folder.path,
                      newName: trimmedName,
                    });
                  }
                }}
              />
            </TextField>
            {error && (
              <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-error)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="text"
                size="sm"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="filled"
                size="sm"
                disabled={!renameValid || submitting}
                onClick={() =>
                  submit({
                    op: "rename",
                    path: folder.path,
                    newName: trimmedName,
                  })
                }
              >
                {submitting ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </>
        )}

        {action === "move" && (
          <>
            <DialogHeader>
              <DialogTitle>Move folder</DialogTitle>
              <DialogDescription>
                Move “{folder.path}” under a new parent path. Leave blank to
                move it to the root.
              </DialogDescription>
            </DialogHeader>
            <TextField variant="outlined">
              <TextFieldLabel>Parent path</TextFieldLabel>
              <TextFieldInput
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                placeholder="/ (root)"
                autoFocus
              />
            </TextField>
            {error && (
              <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-error)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="text"
                size="sm"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="filled"
                size="sm"
                disabled={submitting}
                onClick={() =>
                  submit({
                    op: "move",
                    path: folder.path,
                    newParent: parent.trim(),
                  })
                }
              >
                {submitting ? "Moving…" : "Move"}
              </Button>
            </DialogFooter>
          </>
        )}

        {action === "delete" && (
          <>
            <DialogHeader>
              <DialogTitle>Delete “{folder.name}”?</DialogTitle>
              <DialogDescription>
                Choose what happens to the assets inside this folder. This can’t
                be undone from here.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-error)]">
                {error}
              </p>
            )}
            <DialogFooter className="flex-col items-stretch gap-[var(--ft-space-2)] sm:flex-row sm:justify-end">
              <Button
                variant="text"
                size="sm"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="outlined"
                size="sm"
                disabled={submitting}
                onClick={() =>
                  submit({ op: "delete", path: folder.path, action: "orphan" })
                }
              >
                Keep assets, remove folder
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={submitting}
                onClick={() =>
                  submit({ op: "delete", path: folder.path, action: "trash" })
                }
              >
                <Trash2 className="size-3.5" />
                {submitting ? "Trashing…" : "Trash assets"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
