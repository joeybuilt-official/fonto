"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

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

const DOC_MIME_TYPES = ["application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/assets")
      .then((r) => r.json())
      .then((d) => {
        const assets: Asset[] = d.assets ?? [];
        setDocs(assets.filter((a) => DOC_MIME_TYPES.includes(a.mimeType) || a.mimeType.startsWith("text/")));
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Documents</h1>
        <p className="text-sm text-muted-foreground mt-1">PDFs, text files, and word documents</p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FileText className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No documents yet. Upload PDFs or text files from the Dashboard.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted/40 transition-colors"
            >
              <FileText className="h-5 w-5 shrink-0 text-orange-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{doc.filename}</p>
                <p className="text-xs text-muted-foreground">{doc.mimeType} · {formatBytes(doc.sizeBytes)}</p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(doc.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
