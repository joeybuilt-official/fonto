"use client";

import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PhotosPage() {
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/assets?mime=image/")
      .then((r) => r.json())
      .then((d) => setPhotos(d.assets ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Photos</h1>
        <p className="text-sm text-muted-foreground mt-1">All image assets</p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading photos…</p>
      ) : photos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No photos yet. Upload images from the Dashboard.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center hover:bg-muted/40 transition-colors"
            >
              <ImageIcon className="h-8 w-8 text-blue-400" />
              <p className="w-full truncate text-xs font-medium text-foreground" title={photo.filename}>
                {photo.filename}
              </p>
              <p className="text-xs text-muted-foreground">{formatBytes(photo.sizeBytes)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
