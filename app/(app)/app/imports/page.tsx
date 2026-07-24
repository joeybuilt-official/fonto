// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports — import hub. Each provider gets its own page (one provider per
// screen reads cleaner than stacking every importer on one page); this hub
// links out to them and shows the shared imports-progress list.
import Link from "next/link";
import { ChevronRight, Cloud, HardDrive, Image, Package, Server } from "lucide-react";
import { ImportsList } from "./_components/imports-list";
import { Card } from "@/components/ui/card";

const PROVIDERS = [
  {
    href: "/app/imports/google",
    title: "Google Takeout",
    desc: "Import a Takeout archive from your Google Drive.",
    Icon: Cloud,
  },
  {
    href: "/app/imports/google-drive",
    title: "Google Drive",
    desc: "Browse and import photos and documents from your Google Drive.",
    Icon: HardDrive,
  },
  {
    href: "/app/imports/google-photos",
    title: "Google Photos",
    desc: "Pick photos and videos from your Google Photos library.",
    Icon: Image,
  },
  {
    href: "/app/imports/amazon",
    title: "Amazon Photos",
    desc: "Upload a ZIP exported from Amazon Photos.",
    Icon: Package,
  },
  {
    href: "/app/imports/nextcloud",
    title: "Nextcloud",
    desc: "Import photos and documents from your Nextcloud server.",
    Icon: Server,
  },
];

export default function ImportsHubPage() {
  return (
    <div className="space-y-6 max-w-xl md:max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--ft-color-on-surface)]">Imports</h1>
        <p className="text-sm text-[var(--ft-color-on-surface-variant)] mt-1">
          Bring your existing photo library into Fonto. Pick a source to begin.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map(({ href, title, desc, Icon }) => (
          <Link key={href} href={href}>
            <Card
              variant="outlined"
              className="group flex flex-row items-center gap-3 p-4 transition-colors hover:bg-[var(--ft-color-surface-container-low)]"
            >
              <span className="shrink-0 rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)] p-2 text-[var(--ft-color-on-surface)]">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--ft-color-on-surface)]">
                  {title}
                </span>
                <span className="block text-xs text-[var(--ft-color-on-surface-variant)]">{desc}</span>
              </span>
              <ChevronRight
                className="h-4 w-4 shrink-0 text-[var(--ft-color-on-surface-variant)] transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Card>
          </Link>
        ))}
      </div>

      <ImportsList />
    </div>
  );
}
