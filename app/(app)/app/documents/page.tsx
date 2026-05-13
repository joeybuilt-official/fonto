// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState } from "react";
import { FileText, X, ExternalLink, Loader2 } from "lucide-react";

const DOC_SUBTYPES = ["receipt", "contract", "letter", "report", "form", "document", "scan"] as const;
const SUBTYPE_LABELS: Record<string, string> = {
  receipt: "Receipt", contract: "Contract", letter: "Letter",
  report: "Report", form: "Form", document: "Document", scan: "Scan",
};
const SUBTYPE_COLORS: Record<string, string> = {
  receipt: "bg-green-500/10 text-green-600 dark:text-green-400",
  contract: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  letter: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  report: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  form: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  document: "bg-muted text-muted-foreground",
  scan: "bg-muted text-muted-foreground",
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
  extractedText: string | null;
  classification: string | null;
  capturedAt: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DOC_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

function DocPreview({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => setUrl(null))
      .finally(() => setLoading(false));

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asset.id, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative flex flex-col w-[90vw] max-w-4xl h-[90vh] bg-background rounded-xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <FileText className="h-4 w-4 text-orange-400 shrink-0" />
          <span className="flex-1 truncate text-sm font-medium">{asset.filename}</span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : asset.mimeType === "application/pdf" && url ? (
            <iframe src={url} className="h-full w-full" title={asset.filename} />
          ) : asset.extractedText ? (
            <pre className="p-4 text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
              {asset.extractedText}
            </pre>
          ) : url ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
              <FileText className="h-16 w-16 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Preview not available for this file type.</p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <ExternalLink className="h-4 w-4" />
                Open File
              </a>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Could not load file.</p>
            </div>
          )}
        </div>

        {(asset.description || asset.extractedText) && (
          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {asset.description && <p>{asset.description}</p>}
            <p>{formatBytes(asset.sizeBytes)} · {asset.mimeType}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [subtypeFilter, setSubtypeFilter] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const url = subtypeFilter ? `/api/v1/assets?subtype=${subtypeFilter}` : "/api/v1/assets";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        const assets: Asset[] = d.assets ?? [];
        setDocs(
          subtypeFilter
            ? assets
            : assets.filter(
                (a) => DOC_MIME_TYPES.includes(a.mimeType) || a.mimeType.startsWith("text/")
              )
        );
      })
      .finally(() => setLoading(false));
  }, [subtypeFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Documents</h1>
        <p className="text-sm text-muted-foreground mt-1">PDFs, text files, and documents</p>
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
          {DOC_SUBTYPES.map((subtype) => (
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
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FileText className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No documents yet. Upload PDFs or text files from the Dashboard.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {docs.map((doc) => (
            <button
              key={doc.id}
              onClick={() => setPreview(doc)}
              className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-muted/40 transition-colors"
            >
              <FileText className="h-5 w-5 shrink-0 text-orange-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{doc.filename}</p>
                  <SubtypeBadge classification={doc.classification} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(doc.sizeBytes)}
                  {doc.description && ` · ${doc.description}`}
                </p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(doc.capturedAt ?? doc.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}

      {preview && <DocPreview asset={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
