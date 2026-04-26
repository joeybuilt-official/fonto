import Link from "next/link";

export default function MarketingPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      <div className="flex max-w-lg flex-col items-center gap-8 px-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Fonto
        </h1>
        <p className="text-lg text-muted-foreground">
          Your digital asset manager. Store, organize, and access photos and documents — all in one place.
        </p>
        <div className="flex gap-4">
          <Link
            href="/login"
            className="rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get Started
          </Link>
        </div>
      </div>
    </div>
  );
}
