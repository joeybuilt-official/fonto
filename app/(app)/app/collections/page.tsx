// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — Collections fan-out wrapper.
//
// Hosts four sub-tabs (Albums / Smart / Projects / Stacks) that each
// own their toolbar + body. Sub-tab selection round-trips through
// `?tab=` (default = albums; missing param = albums for clean URLs).
// Detail routes `collections/[id]`, `projects/[id]`, `stacks/[id]`
// keep their own pages — this wrapper only collapses the landing
// surfaces. ADR 0004, plan-ux.md Phase 2.

"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FolderOpen, Zap, Folder, Layers } from "lucide-react";
import { TabBar, type TabDef } from "../_components/tab-bar";
import { AlbumsTab } from "./_components/albums-tab";
import { SmartTab } from "./_components/smart-tab";
import { ProjectsTab } from "./_components/projects-tab";
import { StacksTab } from "./_components/stacks-tab";

const TABS: TabDef[] = [
  { key: "albums", label: "Albums", icon: FolderOpen },
  { key: "smart", label: "Smart", icon: Zap },
  { key: "projects", label: "Projects", icon: Folder },
  { key: "stacks", label: "Stacks", icon: Layers },
];

const DEFAULT_TAB = "albums";

function CollectionsContent() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const active = TABS.some((t) => t.key === raw) ? (raw as string) : DEFAULT_TAB;

  return (
    <div className="space-y-3">
      <TabBar
        tabs={TABS}
        active={active}
        defaultKey={DEFAULT_TAB}
        label="Collections sections"
      />
      {active === "albums" && <AlbumsTab />}
      {active === "smart" && <SmartTab />}
      {active === "projects" && <ProjectsTab />}
      {active === "stacks" && <StacksTab />}
    </div>
  );
}

export default function CollectionsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <CollectionsContent />
    </Suspense>
  );
}
