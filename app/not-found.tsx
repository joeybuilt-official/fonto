// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Custom 404 — uses the app theme tokens so it doesn't render as
// bare black-on-white when the user has dark mode on. The default
// Next.js not-found page ships its own inline styling and ignores
// our globals.css palette.

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="text-4xl font-semibold text-foreground">404</p>
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t find that page. The URL may be out of date or the
          item may have been moved.
        </p>
        <Link
          href="/app/home"
          className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
