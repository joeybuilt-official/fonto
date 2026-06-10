// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports — import hub. Each provider gets its own page (one provider per
// screen reads cleaner than stacking every importer on one page); this hub
// links out to them and shows the shared imports-progress list.
import Link from "next/link";
import { ChevronRight, Cloud, Package } from "lucide-react";
import { ImportsList } from "./_components/imports-list";

const PROVIDERS = [
  {
    href: "/app/imports/google",
    title: "Google Takeout",
    desc: "Import a Takeout archive from your Google Drive.",
    Icon: Cloud,
  },
  {
    href: "/app/imports/amazon",
    title: "Amazon Photos",
    desc: "Upload a ZIP exported from Amazon Photos.",
    Icon: Package,
  },
];

export default function ImportsHubPage() {
  return (
    <div className="space-y-6 max-w-xl md:max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Imports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Bring your existing photo library into Fonto. Pick a source to begin.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map(({ href, title, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
          >
            <span className="shrink-0 rounded-md bg-muted p-2 text-foreground">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">
                {title}
              </span>
              <span className="block text-xs text-muted-foreground">{desc}</span>
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>

      <ImportsList />
    </div>
  );
}
