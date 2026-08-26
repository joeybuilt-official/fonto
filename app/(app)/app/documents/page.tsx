// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/documents → /app/library?kind=document (308). The document reading pane
// now lives in the Library lightbox (a PDF/text asset opens DocPreview), and
// server-side OCR search (?q=) + subtype filtering already exist in Library, so
// this route is a permanent alias. `?selected=<id>` maps to the lightbox param
// `?lb=<id>`. Canonical-Library redirect (M2).

import { permanentRedirect } from "next/navigation";

export default async function DocumentsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams({ kind: "document" });
  if (sp.selected) params.set("lb", sp.selected);
  permanentRedirect(`/app/library?${params.toString()}`);
}
