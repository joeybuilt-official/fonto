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
    description:
      "Photos, documents, scans -- every file type, one intake.",
  },
  {
    icon: HardDrive,
    title: "R2 Storage",
    description:
      "Cloudflare R2 backend. Fast, durable, egress-free.",
  },
  {
    icon: Brain,
    title: "AI Classification",
    description:
      "Automatic tagging, categorization, and metadata extraction.",
  },
  {
    icon: Search,
    title: "Unified Search",
    description:
      "Find anything across photos and documents in one query.",
  },
  {
    icon: Clock,
    title: "Timeline",
    description:
      "Chronological view of everything you have stored.",
  },
  {
    icon: FolderOpen,
    title: "Collections",
    description:
      "Group assets your way. Manual or AI-suggested.",
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
      <section className="mx-auto w-full max-w-5xl px-6 pt-24 pb-20">
        <h1 className="font-heading text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Everything flows here.
        </h1>
        <p className="mt-4 max-w-lg text-lg text-muted-foreground">
          Photos and documents, unified. AI-organized, stored reliably,
          searchable instantly.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/login"
            className="rounded bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#1D9089]"
          >
            Get Started
          </Link>
          <a
            href="https://github.com/joeybuilt-official/fonto"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-border bg-secondary px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Self-Host &rarr;
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border bg-secondary py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-heading text-2xl font-semibold text-foreground">
            What you get
          </h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="space-y-2">
                <f.icon className="h-5 w-5 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">
                  {f.title}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {f.description}
                </p>
              </div>
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
              <div key={t.title} className="space-y-2">
                <t.icon className="h-5 w-5 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">
                  {t.title}
                </h3>
                <p className="text-sm text-muted-foreground">
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
              className="rounded bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#1D9089]"
            >
              Get Started
            </Link>
            <a
              href="https://github.com/joeybuilt-official/fonto"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-border bg-secondary px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
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
