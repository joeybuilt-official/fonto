"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, File, Image as ImageIcon, FileText } from "lucide-react";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  syncState: string;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-8 w-8 text-blue-400" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return <FileText className="h-8 w-8 text-orange-400" />;
  return <File className="h-8 w-8 text-muted-foreground" />;
}

export default function DashboardPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function fetchAssets() {
    try {
      const res = await fetch("/api/v1/assets");
      if (res.ok) {
        const data = await res.json();
        setAssets(data.assets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAssets(); }, []);

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/v1/assets", { method: "POST", body: form });
    if (res.ok) {
      const data = await res.json();
      setAssets((prev) => [...prev, data.asset]);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(file);
      }
    } finally {
      setUploading(false);
    }
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">All your assets</p>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50 hover:bg-muted/40"
        }`}
      >
        <Upload className={`h-8 w-8 mb-3 ${dragOver ? "text-primary" : "text-muted-foreground"}`} />
        <p className="text-sm font-medium text-foreground">
          {uploading ? "Uploading…" : "Drop files here or click to upload"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Photos, documents, and more</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {/* Asset grid */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading assets…</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assets yet. Upload something to get started.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center hover:bg-muted/40 transition-colors"
            >
              <AssetIcon mimeType={asset.mimeType} />
              <p className="w-full truncate text-xs font-medium text-foreground" title={asset.filename}>
                {asset.filename}
              </p>
              <p className="text-xs text-muted-foreground">{formatBytes(asset.sizeBytes)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
