"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, File, Image as ImageIcon, FileText, CheckCircle, XCircle, Loader2, Clipboard } from "lucide-react";
import Link from "next/link";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  syncState: string;
  processingState: string;
  capturedAt?: string;
  createdAt: string;
}

interface UploadItem {
  id: string;
  filename: string;
  sizeBytes: number;
  state: "uploading" | "done" | "error";
  assetId?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-8 w-8 text-blue-400" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/"))
    return <FileText className="h-8 w-8 text-orange-400" />;
  return <File className="h-8 w-8 text-muted-foreground" />;
}

function SyncBadge({ state }: { state: string }) {
  if (state === "synced")
    return <CheckCircle className="h-3 w-3 text-green-500" aria-label="Synced" />;
  if (state === "error")
    return <XCircle className="h-3 w-3 text-red-500" aria-label="Error" />;
  return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Syncing" />;
}

export default function DashboardPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function fetchAssets() {
    try {
      const res = await fetch("/api/v1/assets");
      if (res.ok) {
        const data = (await res.json()) as { assets: Asset[] };
        setAssets(data.assets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAssets(); }, []);

  // Paste from clipboard
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) await handleFiles(files, "clipboard");
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  async function uploadFile(file: File, source: string): Promise<Asset | null> {
    const itemId = `${Date.now()}-${Math.random()}`;
    setUploadItems((prev) => [
      ...prev,
      { id: itemId, filename: file.name, sizeBytes: file.size, state: "uploading" },
    ]);

    const form = new FormData();
    form.append("file", file);
    form.append("source", source);

    try {
      const res = await fetch("/api/v1/assets", { method: "POST", body: form });
      if (res.ok) {
        const data = (await res.json()) as { asset: Asset };
        setUploadItems((prev) =>
          prev.map((i) => (i.id === itemId ? { ...i, state: "done", assetId: data.asset.id } : i))
        );
        return data.asset;
      } else {
        setUploadItems((prev) =>
          prev.map((i) => (i.id === itemId ? { ...i, state: "error" } : i))
        );
        return null;
      }
    } catch {
      setUploadItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, state: "error" } : i))
      );
      return null;
    }
  }

  async function handleFiles(files: File[] | FileList, source = "web-upload") {
    const results = await Promise.all(Array.from(files).map((f) => uploadFile(f, source)));
    const uploaded = results.filter(Boolean) as Asset[];
    if (uploaded.length > 0) {
      setAssets((prev) => [...uploaded, ...prev]);
    }
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files, "drag-drop");
    },
    []
  );

  const activeUploads = uploadItems.filter((i) => i.state === "uploading");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">All your assets · {assets.length} total</p>
        </div>
        <Link
          href="/api/export"
          className="text-xs text-muted-foreground border border-border rounded px-2 py-1 hover:text-foreground hover:border-foreground transition-colors"
        >
          Export JSON
        </Link>
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
          {activeUploads.length > 0
            ? `Uploading ${activeUploads.length} file${activeUploads.length > 1 ? "s" : ""}…`
            : "Drop files here or click to upload"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
          <Clipboard className="h-3 w-3" /> Paste (Ctrl+V) also works
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files, "file-picker")}
        />
      </div>

      {/* Per-file upload progress */}
      {uploadItems.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Uploads</p>
          {uploadItems.slice(-10).map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-xs">
              {item.state === "uploading" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              {item.state === "done" && <CheckCircle className="h-3 w-3 text-green-500" />}
              {item.state === "error" && <XCircle className="h-3 w-3 text-red-500" />}
              <span className="truncate max-w-48">{item.filename}</span>
              <span className="ml-auto text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
              <span className={
                item.state === "done" ? "text-green-500" :
                item.state === "error" ? "text-red-500" : "text-muted-foreground"
              }>
                {item.state}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Asset grid */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading assets…</p>
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-8 text-center space-y-4">
          <div className="text-4xl">👋</div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Welcome to Fonto!</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your personal archive for photos, documents, and everything else.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-left mt-4">
            {[
              { step: "1", title: "Upload anything", body: "Drag files, click to browse, or paste from clipboard." },
              { step: "2", title: "Auto-organize", body: "AI classifies and describes your assets automatically." },
              { step: "3", title: "Find anything", body: "Search by name, description, or extracted text." },
            ].map((s) => (
              <div key={s.step} className="rounded-lg border border-border bg-card p-4">
                <div className="text-xs font-bold text-primary mb-1">Step {s.step}</div>
                <p className="text-sm font-medium text-foreground">{s.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground pt-2">
            Start by dropping files in the upload zone above ↑
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center hover:bg-muted/40 transition-colors"
            >
              <AssetIcon mimeType={asset.mimeType} />
              <p
                className="w-full truncate text-xs font-medium text-foreground"
                title={asset.filename}
              >
                {asset.filename}
              </p>
              <p className="text-xs text-muted-foreground">{formatBytes(asset.sizeBytes)}</p>
              <div className="flex items-center gap-1">
                <SyncBadge state={asset.syncState} />
                {asset.processingState !== "captured" && (
                  <span className="text-[10px] text-muted-foreground">{asset.processingState}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
