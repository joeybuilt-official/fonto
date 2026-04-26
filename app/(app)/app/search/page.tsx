"use client";

import { useState, useCallback } from "react";
import { Search, File, Image as ImageIcon, FileText, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string | null;
  classification: string | null;
  description: string | null;
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

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [mimeFilter, setMimeFilter] = useState("");
  const [results, setResults] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const doSearch = useCallback(async (q: string, mime: string) => {
    if (!q.trim() && !mime) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (mime) params.set("mime", mime);
      const res = await fetch(`/api/v1/search?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.assets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    doSearch(val, mimeFilter);
  }

  function handleMimeChange(mime: string) {
    setMimeFilter(mime);
    doSearch(query, mime);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Search</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Search by filename, description, extracted text, or classification
        </p>
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search assets…"
            autoFocus
            className="w-full rounded-lg border border-border bg-background pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Mime type filters */}
      <div className="flex gap-2 flex-wrap">
        {[
          { label: "All", value: "" },
          { label: "Photos", value: "image/" },
          { label: "PDF", value: "application/pdf" },
          { label: "Text", value: "text/" },
        ].map(({ label, value }) => (
          <button
            key={value}
            onClick={() => handleMimeChange(value)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              mimeFilter === value
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {results === null ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          Type to search your assets
        </p>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No assets found.</p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{results.length} result{results.length !== 1 ? "s" : ""}</p>
          {results.map((asset) => (
            <button
              key={asset.id}
              onClick={() => {
                if (asset.mimeType.startsWith("image/")) router.push("/app/photos");
                else router.push("/app/documents");
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-muted/40 transition-colors"
            >
              <AssetIcon mimeType={asset.mimeType} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{asset.filename}</p>
                {asset.description && (
                  <p className="truncate text-xs text-muted-foreground">{asset.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {asset.classification ?? asset.mimeType} · {formatBytes(asset.sizeBytes)}
                </p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(asset.capturedAt ?? asset.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
