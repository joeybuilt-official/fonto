// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/timeline → /app/library (308). Library IS the chronological timeline;
// this route is kept only as a permanent alias so old links still resolve.
// Canonical-Library redirect (M2). See docs/claude/platform/plan-daily-driver-m2-canonical.md.

import { permanentRedirect } from "next/navigation";

export default function TimelineRedirect() {
  permanentRedirect("/app/library");
}
