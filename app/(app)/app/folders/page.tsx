// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/folders → /app/library (308). Library browses folders (the Folder chip)
// and now manages them (rename/move/delete + drag-drop), so this route is a
// permanent alias. `?path=<p>` maps to Library's `?directoryPathPrefix=<p>`.
// Canonical-Library redirect (M2).

import { permanentRedirect } from "next/navigation";

export default async function FoldersRedirect({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const sp = await searchParams;
  permanentRedirect(
    sp.path
      ? `/app/library?directoryPathPrefix=${encodeURIComponent(sp.path)}`
      : "/app/library"
  );
}
