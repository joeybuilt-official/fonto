"use client";

import { useEffect, useState, useCallback } from "react";
import { Trash2, RotateCcw, File, Image as ImageIcon, FileText } from "lucide-react";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  deletedAt: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-5 w-5 text-blue-400" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/"))
    return <FileText className="h-5 w-5 text-orange-400" />;
  return <File className="h-5 w-5 text-muted-foreground" />;
}

export default function TrashPage() {
  const [items, setItems] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch("/api/v1/assets?lifecycle=trashed")
      .then((r) => r.json())
      .then((d) => setItems(d.assets ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function restore(assetId: string) {
    await fetch(`/api/v1/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restore: true }),
    });
    setItems((prev) => prev.filter((a) => a.id !== assetId));
  }

  async function deletePermanently(assetId: string) {
    if (!confirm("Permanently delete this asset? This cannot be undone.")) return;
    await fetch(`/api/v1/assets/${assetId}`, { method: "DELETE" });
    setItems((prev) => prev.filter((a) => a.id !== assetId));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Trash</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Trashed assets · restore or permanently delete
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Trash2 className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Trash is empty.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((asset) => (
            <div
              key={asset.id}
              className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 opacity-70 hover:opacity-100 transition-opacity"
            >
              <AssetIcon mimeType={asset.mimeType} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{asset.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(asset.sizeBytes)}
                  {asset.deletedAt && ` · Trashed ${new Date(asset.deletedAt).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => restore(asset.id)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </button>
                <button
                  onClick={() => deletePermanently(asset.id)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium border border-red-500/50 text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
