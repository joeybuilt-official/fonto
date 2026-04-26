"use client";

import { useEffect, useState } from "react";
import { Clock, File, Image as ImageIcon, FileText } from "lucide-react";
import Link from "next/link";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string | null;
  classification: string | null;
  processingState: string;
  capturedAt: string | null;
  createdAt: string;
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

function groupByDate(assets: Asset[]): [string, Asset[]][] {
  const map = new Map<string, Asset[]>();
  for (const a of assets) {
    const d = new Date(a.capturedAt ?? a.createdAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(a);
  }
  return Array.from(map.entries());
}

export default function TimelinePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [mimeFilter, setMimeFilter] = useState("");

  useEffect(() => {
    const url = mimeFilter ? `/api/v1/assets?mime=${encodeURIComponent(mimeFilter)}` : "/api/v1/assets";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        const sorted = (d.assets ?? []).sort(
          (a: Asset, b: Asset) =>
            new Date(b.capturedAt ?? b.createdAt).getTime() -
            new Date(a.capturedAt ?? a.createdAt).getTime()
        );
        setAssets(sorted);
      })
      .finally(() => setLoading(false));
  }, [mimeFilter]);

  const groups = groupByDate(assets);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Timeline</h1>
          <p className="text-sm text-muted-foreground mt-1">Chronological view of all assets</p>
        </div>
        <div className="flex gap-2">
          {["", "image/", "application/pdf", "text/"].map((filter) => (
            <button
              key={filter}
              onClick={() => setMimeFilter(filter)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                mimeFilter === filter
                  ? "bg-foreground text-background border-foreground"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              {filter === "" ? "All" : filter === "image/" ? "Photos" : filter === "application/pdf" ? "PDF" : "Text"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading timeline…</p>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Clock className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No assets yet. Upload something from the Dashboard.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([date, group]) => (
            <div key={date}>
              <div className="mb-3 flex items-center gap-3">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{date}</span>
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">{group.length}</span>
              </div>
              <div className="space-y-1.5">
                {group.map((asset) => (
                  <div
                    key={asset.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 hover:bg-muted/40 transition-colors"
                  >
                    <AssetIcon mimeType={asset.mimeType} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{asset.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {asset.classification ?? asset.mimeType} · {formatBytes(asset.sizeBytes)}
                        {asset.source && ` · ${asset.source}`}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(asset.capturedAt ?? asset.createdAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
