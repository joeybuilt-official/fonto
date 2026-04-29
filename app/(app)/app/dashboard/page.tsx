"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Upload, File, Image as ImageIcon, FileText, CheckCircle,
  XCircle, Loader2, Clipboard, Check
} from "lucide-react";
import Link from "next/link";

const SUBTYPE_LABELS: Record<string, string> = {
  photo: "Photo",
  screenshot: "Screenshot",
  mockup: "Mockup",
  logo: "Logo",
  icon: "Icon",
  receipt: "Receipt",
  contract: "Contract",
  letter: "Letter",
  report: "Report",
  form: "Form",
  document: "Document",
  scan: "Scan",
};

const SUBTYPE_COLORS: Record<string, string> = {
  photo: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  screenshot: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  mockup: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  logo: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  receipt: "bg-green-500/10 text-green-600 dark:text-green-400",
  contract: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  letter: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  report: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  form: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  document: "bg-muted text-muted-foreground",
  scan: "bg-muted text-muted-foreground",
};

function ClassificationBadge({ classification }: { classification: string | null }) {
  if (!classification) return null;
  const label = SUBTYPE_LABELS[classification] ?? classification;
  const color = SUBTYPE_COLORS[classification] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {label}
    </span>
  );
}

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  syncState: string;
  processingState: string;
  classification: string | null;
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

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
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

// Simple thumbnail that lazy-fetches URL for image assets
function AssetThumbnail({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) return;
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => {});
  }, [asset.id, asset.mimeType]);

  return (
    <div className="aspect-square overflow-hidden rounded-lg bg-muted/30 flex items-center justify-center">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={asset.filename} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <AssetIcon mimeType={asset.mimeType} />
      )}
    </div>
  );
}

// Toast container
function ToastContainer({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg pointer-events-auto transition-all ${
            toast.type === "success"
              ? "border-green-500/30 bg-card text-foreground"
              : "border-destructive/30 bg-card text-destructive"
          }`}
        >
          {toast.type === "success" ? (
            <Check className="h-4 w-4 text-green-500 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive shrink-0" />
          )}
          {toast.message}
        </div>
      ))}
    </div>
  );
}

interface DuplicatePrompt {
  newAsset: Asset;
  match: {
    assetId: string;
    filename: string;
    capturedAt: string | null;
    createdAt: string;
    distance: number;
    thumbUrl: string;
  };
}

export default function DashboardPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [recentUploads, setRecentUploads] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [subtypeFilter, setSubtypeFilter] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [duplicatePrompts, setDuplicatePrompts] = useState<DuplicatePrompt[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function showToast(message: string, type: "success" | "error" = "success") {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }

  async function fetchAssets() {
    try {
      const url = subtypeFilter ? `/api/v1/assets?subtype=${subtypeFilter}` : "/api/v1/assets";
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { assets: Asset[] };
        setAssets(data.assets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function fetchRecentUploads() {
    try {
      const res = await fetch("/api/v1/assets?sort=newest");
      if (res.ok) {
        const data = (await res.json()) as { assets: Asset[] };
        setRecentUploads((data.assets ?? []).slice(0, 8));
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => { fetchAssets(); }, [subtypeFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRecentUploads(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        const data = (await res.json()) as {
          asset: Asset;
          possibleDuplicate?: {
            assetId: string;
            filename: string;
            capturedAt: string | null;
            createdAt: string;
            distance: number;
            thumbUrl: string;
          };
        };
        setUploadItems((prev) =>
          prev.map((i) => (i.id === itemId ? { ...i, state: "done", assetId: data.asset.id } : i))
        );
        // Surface a near-duplicate prompt if the server flagged one. The new
        // asset is already persisted; the user picks Keep both / Replace existing
        // (= trash existing) / Cancel upload (= trash the new one).
        if (data.possibleDuplicate) {
          setDuplicatePrompts((prev) => [
            ...prev,
            { newAsset: data.asset, match: data.possibleDuplicate! },
          ]);
        }
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
      setRecentUploads((prev) => [...uploaded, ...prev].slice(0, 8));
      showToast(
        uploaded.length === 1
          ? `${uploaded[0].filename} uploaded successfully`
          : `${uploaded.length} files uploaded successfully`,
        "success"
      );
    }
    const failed = results.filter((r) => r === null).length;
    if (failed > 0) {
      showToast(`${failed} file${failed > 1 ? "s" : ""} failed to upload`, "error");
    }
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files, "drag-drop");
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
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

      {/* Recent uploads thumbnails */}
      {recentUploads.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Recent Uploads</p>
            <Link href="/app/photos" className="text-xs text-primary hover:underline">
              View all
            </Link>
          </div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {recentUploads.map((asset) => (
              <AssetThumbnail key={asset.id} asset={asset} />
            ))}
          </div>
        </div>
      )}

      {/* Subtype filter */}
      {!loading && assets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSubtypeFilter(null)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              !subtypeFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          {Object.keys(SUBTYPE_LABELS).map((subtype) => (
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
              {asset.classification && (
                <ClassificationBadge classification={asset.classification} />
              )}
              <div className="flex items-center gap-1">
                <SyncBadge state={asset.syncState} />
                {asset.processingState !== "captured" && asset.processingState !== "ready" && (
                  <span className="text-[10px] text-muted-foreground">{asset.processingState}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} />

      {/* Perceptual duplicate prompts */}
      {duplicatePrompts.length > 0 && (
        <DuplicatePromptStack
          prompts={duplicatePrompts}
          onDismiss={(idx) => {
            setDuplicatePrompts((prev) => prev.filter((_, i) => i !== idx));
          }}
          onTrashAsset={async (assetId) => {
            await fetch(`/api/v1/assets/${assetId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trash: true }),
            });
            setAssets((prev) => prev.filter((a) => a.id !== assetId));
            setRecentUploads((prev) => prev.filter((a) => a.id !== assetId));
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/**
 * Modal stack for "possible duplicate" prompts surfaced after upload. Each
 * card shows the existing asset's thumbnail + capture date and offers three
 * resolutions: Keep both, Replace existing (trash existing), Cancel upload
 * (trash the new asset).
 */
function DuplicatePromptStack({
  prompts,
  onDismiss,
  onTrashAsset,
  showToast,
}: {
  prompts: DuplicatePrompt[];
  onDismiss: (index: number) => void;
  onTrashAsset: (assetId: string) => Promise<void>;
  showToast: (message: string, type?: "success" | "error") => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-24 z-40 flex flex-col items-center gap-2 px-4 pointer-events-none">
      {prompts.map((p, idx) => (
        <DuplicatePromptCard
          key={p.newAsset.id}
          prompt={p}
          onDismiss={() => onDismiss(idx)}
          onTrashAsset={onTrashAsset}
          showToast={showToast}
        />
      ))}
    </div>
  );
}

function DuplicatePromptCard({
  prompt,
  onDismiss,
  onTrashAsset,
  showToast,
}: {
  prompt: DuplicatePrompt;
  onDismiss: () => void;
  onTrashAsset: (assetId: string) => Promise<void>;
  showToast: (message: string, type?: "success" | "error") => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(prompt.match.thumbUrl)
      .then((r) => (r.ok ? r.json() : { url: null }))
      .then((d: { url?: string }) => setThumbUrl(d.url ?? null))
      .catch(() => setThumbUrl(null));
  }, [prompt.match.thumbUrl]);

  async function handleKeepBoth() {
    onDismiss();
  }
  async function handleReplaceExisting() {
    setBusy(true);
    try {
      await onTrashAsset(prompt.match.assetId);
      showToast(`Replaced “${prompt.match.filename}”`, "success");
      onDismiss();
    } finally {
      setBusy(false);
    }
  }
  async function handleCancelUpload() {
    setBusy(true);
    try {
      await onTrashAsset(prompt.newAsset.id);
      showToast("Upload cancelled — duplicate avoided", "success");
      onDismiss();
    } finally {
      setBusy(false);
    }
  }

  const dateLabel = prompt.match.capturedAt
    ? new Date(prompt.match.capturedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : new Date(prompt.match.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted/30 flex items-center justify-center">
        {thumbUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">Possible duplicate of</p>
        <p className="truncate text-xs text-muted-foreground" title={prompt.match.filename}>
          {prompt.match.filename}
          <span className="ml-1">· {dateLabel}</span>
          <span className="ml-1">· d{prompt.match.distance}</span>
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          onClick={handleKeepBoth}
          disabled={busy}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          Keep both
        </button>
        <button
          onClick={handleReplaceExisting}
          disabled={busy}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          Replace
        </button>
        <button
          onClick={handleCancelUpload}
          disabled={busy}
          className="rounded-md border border-destructive/30 bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
