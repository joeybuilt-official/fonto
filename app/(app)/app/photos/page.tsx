"use client";

import { useEffect, useState, useCallback } from "react";
import { Image as ImageIcon, X, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const IMAGE_SUBTYPES = ["photo", "screenshot", "mockup", "logo", "icon"] as const;
const SUBTYPE_LABELS: Record<string, string> = {
  photo: "Photo", screenshot: "Screenshot", mockup: "Mockup", logo: "Logo", icon: "Icon",
};
const SUBTYPE_COLORS: Record<string, string> = {
  photo: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  screenshot: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  mockup: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  logo: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function SubtypeBadge({ classification }: { classification: string | null }) {
  if (!classification) return null;
  const label = SUBTYPE_LABELS[classification] ?? classification;
  const color = SUBTYPE_COLORS[classification] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>
  );
}

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  capturedAt: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PhotoCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => setUrl(null))
      .finally(() => setLoading(false));
  }, [asset.id]);

  return (
    <div
      onClick={onClick}
      className="cursor-pointer overflow-hidden rounded-lg border border-border bg-card hover:border-primary/50 transition-colors"
    >
      <div className="aspect-square bg-muted/30 flex items-center justify-center overflow-hidden">
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.description ?? asset.filename}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <div className="p-2">
        <p className="truncate text-xs font-medium text-foreground" title={asset.filename}>
          {asset.filename}
        </p>
        <div className="mt-1 flex items-center justify-between gap-1">
          <p className="text-[10px] text-muted-foreground">{formatBytes(asset.sizeBytes)}</p>
          <SubtypeBadge classification={asset.classification} />
        </div>
      </div>
    </div>
  );
}

function Lightbox({
  asset,
  url,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: {
  asset: Asset;
  url: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) onPrev();
      if (e.key === "ArrowRight" && hasNext) onNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 rounded-full p-2 bg-white/10 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>

      {hasPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className="absolute left-4 rounded-full p-2 bg-white/10 text-white hover:bg-white/20"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}

      {hasNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className="absolute right-4 rounded-full p-2 bg-white/10 text-white hover:bg-white/20"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}

      <div
        className="max-h-[90vh] max-w-[90vw] flex flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.description ?? asset.filename}
            className="max-h-[80vh] max-w-[85vw] rounded-lg object-contain"
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-muted">
            <ImageIcon className="h-16 w-16 text-muted-foreground" />
          </div>
        )}
        <div className="text-center text-sm text-white/80">
          <p className="font-medium">{asset.filename}</p>
          {asset.description && <p className="text-xs text-white/60">{asset.description}</p>}
        </div>
      </div>
    </div>
  );
}

export default function PhotosPage() {
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [subtypeFilter, setSubtypeFilter] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const url = subtypeFilter
      ? `/api/v1/assets?mime=image/&subtype=${subtypeFilter}`
      : "/api/v1/assets?mime=image/";
    fetch(url)
      .then((r) => r.json())
      .then((d) => setPhotos(d.assets ?? []))
      .finally(() => setLoading(false));
  }, [subtypeFilter]);

  const openLightbox = useCallback(
    async (index: number) => {
      setLightboxIndex(index);
      setLightboxUrl(null);
      const res = await fetch(`/api/v1/assets/${photos[index].id}/url`);
      if (res.ok) {
        const data = await res.json();
        setLightboxUrl(data.url);
      }
    },
    [photos]
  );

  async function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < photos.length) {
      await openLightbox(next);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Photos</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {photos.length} image{photos.length !== 1 ? "s" : ""}
        </p>
      </div>

      {!loading && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSubtypeFilter(null)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              !subtypeFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          {IMAGE_SUBTYPES.map((subtype) => (
            <button
              key={subtype}
              onClick={() => setSubtypeFilter(subtypeFilter === subtype ? null : subtype)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                subtypeFilter === subtype
                  ? "bg-primary text-primary-foreground"
                  : `${SUBTYPE_COLORS[subtype] ?? "bg-muted text-muted-foreground"} hover:opacity-80`
              }`}
            >
              {SUBTYPE_LABELS[subtype]}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading photos…</p>
      ) : photos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No photos yet. Upload images from the Dashboard.</p>
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
        >
          {photos.map((photo, index) => (
            <PhotoCard key={photo.id} asset={photo} onClick={() => openLightbox(index)} />
          ))}
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          asset={photos[lightboxIndex]}
          url={lightboxUrl}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < photos.length - 1}
        />
      )}
    </div>
  );
}
