// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import Link from "next/link";
import {
  Camera,
  HardDrive,
  Brain,
  Search,
  Clock,
  FolderOpen,
  ShieldCheck,
  RefreshCw,
  Download,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const features = [
  {
    icon: Camera,
    title: "Universal Capture",
    description: "Photos, documents, scans -- every file type, one intake.",
  },
  {
    icon: HardDrive,
    title: "R2 Storage",
    description: "Cloudflare R2 backend. Fast, durable, egress-free.",
  },
  {
    icon: Brain,
    title: "AI Classification",
    description: "Automatic tagging, categorization, and metadata extraction.",
  },
  {
    icon: Search,
    title: "Unified Search",
    description: "Find anything across photos and documents in one query.",
  },
  {
    icon: Clock,
    title: "Timeline",
    description: "Chronological view of everything you have stored.",
  },
  {
    icon: FolderOpen,
    title: "Collections",
    description: "Group assets your way. Manual or AI-suggested.",
  },
];

const trustPoints = [
  {
    icon: ShieldCheck,
    title: "SHA-256 Verification",
    description: "Every file checksummed on ingest. Integrity guaranteed.",
  },
  {
    icon: RefreshCw,
    title: "Sync State Visibility",
    description: "Always know what is synced, pending, or failed.",
  },
  {
    icon: Download,
    title: "Export Always Available",
    description: "Your data. Your files. Download everything, anytime.",
  },
];

// Masonry tiles for the hero mock. Gradients use --ft-*-container role tokens,
// which are defined for both light and dark, so the mock is theme-aware with
// zero image assets. `ratio` varies the tile height for a real photo-wall feel.
const heroTiles: { gradient: string; ratio: string }[] = [
  { gradient: "from-[var(--ft-color-primary-container)] to-[var(--ft-color-tertiary-container)]", ratio: "aspect-[4/5]" },
  { gradient: "from-[var(--ft-color-tertiary-container)] to-[var(--ft-color-secondary-container)]", ratio: "aspect-square" },
  { gradient: "from-[var(--ft-color-secondary-container)] to-[var(--ft-color-primary-container)]", ratio: "aspect-[4/3]" },
  { gradient: "from-[var(--ft-color-surface-container-high)] to-[var(--ft-color-tertiary-container)]", ratio: "aspect-[3/4]" },
  { gradient: "from-[var(--ft-color-primary-container)] to-[var(--ft-color-surface-container-high)]", ratio: "aspect-square" },
  { gradient: "from-[var(--ft-color-tertiary-container)] to-[var(--ft-color-primary-container)]", ratio: "aspect-[4/5]" },
  { gradient: "from-[var(--ft-color-secondary-container)] to-[var(--ft-color-surface-container-highest)]", ratio: "aspect-[4/3]" },
  { gradient: "from-[var(--ft-color-primary-container)] to-[var(--ft-color-secondary-container)]", ratio: "aspect-square" },
  { gradient: "from-[var(--ft-color-surface-container-high)] to-[var(--ft-color-primary-container)]", ratio: "aspect-[3/4]" },
];

function HeroMock() {
  return (
    <div className="relative rounded-2xl border border-border bg-card p-2 shadow-[var(--ft-elev-2)]">
      {/* faux app chrome */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--ft-color-tertiary)]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-primary/60" />
        <div className="ml-2 flex h-6 flex-1 items-center gap-1.5 rounded-full bg-muted px-2.5">
          <Search className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">Search everything…</span>
        </div>
      </div>
      {/* masonry photo wall */}
      <div className="relative overflow-hidden rounded-xl">
        <div className="columns-3 gap-2 [&>*]:mb-2">
          {heroTiles.map((t, i) => (
            <div
              key={i}
              className={`${t.ratio} w-full break-inside-avoid rounded-lg border border-border/40 bg-gradient-to-br ${t.gradient}`}
            />
          ))}
        </div>
        {/* bottom fade so the wall reads as "more below" */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
      </div>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
  gradient,
}: {
  icon: typeof Camera;
  title: string;
  description: string;
  gradient: string;
}) {
  return (
    <div className="group overflow-hidden rounded-xl border border-border bg-card shadow-[var(--ft-elev-1)] transition-shadow hover:shadow-[var(--ft-elev-2)]">
      {/* screenshot-style preview strip */}
      <div className={`relative h-24 bg-gradient-to-br ${gradient}`}>
        <div className="absolute left-3 top-3 flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
          <span className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
          <span className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
        </div>
        <div className="absolute -bottom-5 left-4 grid h-10 w-10 place-items-center rounded-lg border border-border bg-card shadow-[var(--ft-elev-1)]">
          <Icon className="h-5 w-5 text-primary-text" />
        </div>
      </div>
      <div className="space-y-1.5 px-4 pb-4 pt-7">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

const featureGradients = [
  "from-[var(--ft-color-primary-container)] to-[var(--ft-color-tertiary-container)]",
  "from-[var(--ft-color-tertiary-container)] to-[var(--ft-color-secondary-container)]",
  "from-[var(--ft-color-secondary-container)] to-[var(--ft-color-primary-container)]",
  "from-[var(--ft-color-primary-container)] to-[var(--ft-color-surface-container-high)]",
  "from-[var(--ft-color-tertiary-container)] to-[var(--ft-color-primary-container)]",
  "from-[var(--ft-color-secondary-container)] to-[var(--ft-color-tertiary-container)]",
];

export default function MarketingPage() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-secondary/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <Link href="/" className="font-heading text-lg font-semibold tracking-tight text-foreground">
            <span className="text-primary">_</span>fonto
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/login"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        {/* soft ambient wash */}
        <div className="pointer-events-none absolute -top-24 right-0 h-72 w-72 rounded-full bg-[var(--ft-color-primary-container)] opacity-40 blur-3xl" />
        <div className="mx-auto grid w-full max-w-5xl items-center gap-12 px-6 pt-20 pb-20 lg:grid-cols-2 lg:gap-10">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
              Self-hosted · AI-organized
            </span>
            <h1 className="mt-5 font-heading text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              Everything flows here.
            </h1>
            <p className="mt-4 max-w-lg text-lg text-muted-foreground">
              Photos and documents, unified. AI-organized, stored reliably,
              searchable instantly.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="rounded-[var(--ft-shape-full)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Get Started
              </Link>
              <a
                href="https://github.com/joeybuilt-official/fonto"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--ft-shape-full)] border border-border bg-secondary px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                Self-Host &rarr;
              </a>
            </div>
          </div>
          <div className="lg:pl-4">
            <HeroMock />
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border bg-secondary py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-heading text-2xl font-semibold text-foreground">
            What you get
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => (
              <FeatureCard
                key={f.title}
                icon={f.icon}
                title={f.title}
                description={f.description}
                gradient={featureGradients[i % featureGradients.length]}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="border-t border-border py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-heading text-2xl font-semibold text-foreground">
            Trust, built in
          </h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-3">
            {trustPoints.map((t) => (
              <div
                key={t.title}
                className="rounded-xl border border-border bg-card p-5 shadow-[var(--ft-elev-1)]"
              >
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--ft-color-primary-container)]">
                  <t.icon className="h-5 w-5 text-[var(--ft-color-on-primary-container)]" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-foreground">
                  {t.title}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border bg-secondary py-20">
        <div className="mx-auto max-w-5xl px-6 text-center">
          <h2 className="font-heading text-2xl font-semibold text-foreground">
            Ready to unify your files?
          </h2>
          <p className="mt-2 text-muted-foreground">
            Start free. Self-host anytime.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link
              href="/login"
              className="rounded-[var(--ft-shape-full)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Get Started
            </Link>
            <a
              href="https://github.com/joeybuilt-official/fonto"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[var(--ft-shape-full)] border border-border bg-secondary px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Self-Host &rarr;
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6">
          <span className="font-heading text-sm font-semibold text-foreground">
            <span className="text-primary">_</span>fonto
          </span>
          <span className="text-xs text-muted-foreground">
            Built by Joeybuilt
          </span>
        </div>
      </footer>
    </div>
  );
}
