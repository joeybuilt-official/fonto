// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/photos → /app/library (308). Moments are Library's default view, so no
// kind filter is needed. `?asset=<id>` (used by email digest deep-links) maps
// to Library's lightbox param `?lb=<id>`. Canonical-Library redirect (M2).

import { permanentRedirect } from "next/navigation";

export default async function PhotosRedirect({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string }>;
}) {
  const sp = await searchParams;
  permanentRedirect(
    sp.asset ? `/app/library?lb=${encodeURIComponent(sp.asset)}` : "/app/library"
  );
}
