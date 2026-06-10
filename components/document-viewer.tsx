// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, FileText, ZoomIn, ZoomOut } from "lucide-react";

type Props = {
  assetId: string;
  filename: string;
  mimeType: string;
  extractedText: string | null;
  onClose: () => void;
};

export function DocumentViewer({ assetId, filename, mimeType, extractedText, onClose }: Props) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [activeTab, setActiveTab] = useState<"preview" | "text">("preview");
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes; move focus into the modal on open and restore it on close.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [onClose]);

  async function loadUrl() {
    if (signedUrl || loadingUrl) return;
    setLoadingUrl(true);
    try {
      const res = await fetch(`/api/v1/assets/${assetId}/url`);
      if (res.ok) {
        const data = await res.json();
        setSignedUrl(data.url);
      }
    } finally {
      setLoadingUrl(false);
    }
  }

  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");
  const hasText = Boolean(extractedText?.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={`Document viewer: ${filename}`}
    >
      {/* Left panel — page/nav controls */}
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="truncate text-xs font-medium text-foreground">{filename}</span>
          <button ref={closeRef} onClick={onClose} aria-label="Close document viewer" className="rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-border">
          <button
            onClick={() => { setActiveTab("preview"); loadUrl(); }}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${activeTab === "preview" ? "text-foreground border-b-2 border-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Preview
          </button>
          {hasText && (
            <button
              onClick={() => setActiveTab("text")}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${activeTab === "text" ? "text-foreground border-b-2 border-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Text
            </button>
          )}
        </div>

        {/* Zoom controls (preview only) */}
        {activeTab === "preview" && (
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            <button
              onClick={() => setZoom((z) => Math.max(50, z - 10))}
              aria-label="Zoom out"
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="flex-1 text-center text-xs text-muted-foreground">{zoom}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(200, z + 10))}
              aria-label="Zoom in"
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* File info */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          <div className="rounded-lg bg-muted/30 p-2">
            <p className="text-xs text-muted-foreground">Type</p>
            <p className="text-xs font-medium text-foreground mt-0.5">{mimeType}</p>
          </div>
          {hasText && (
            <div className="rounded-lg bg-muted/30 p-2">
              <p className="text-xs text-muted-foreground">Extracted text</p>
              <p className="text-xs text-foreground mt-0.5 line-clamp-4">{extractedText}</p>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — content */}
      <div className="flex flex-1 flex-col min-w-0 bg-muted/10">
        {activeTab === "text" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <pre className="whitespace-pre-wrap text-sm text-foreground font-mono leading-relaxed">
              {extractedText}
            </pre>
          </div>
        ) : signedUrl ? (
          <div className="flex flex-1 items-center justify-center overflow-auto p-4">
            {isPdf ? (
              <iframe
                src={signedUrl}
                style={{ width: `${zoom}%`, height: "100%", minHeight: 600 }}
                className="rounded border border-border"
                title={filename}
              />
            ) : isImage ? (
              <img
                src={signedUrl}
                alt={filename}
                style={{ maxWidth: `${zoom}%`, maxHeight: "100%" }}
                className="rounded object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <FileText className="h-16 w-16" />
                <p className="text-sm">Preview not available for this file type.</p>
                <a
                  href={signedUrl}
                  download={filename}
                  className="rounded-lg bg-foreground px-4 py-2 text-sm text-background hover:bg-foreground/90"
                >
                  Download
                </a>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <button
              onClick={loadUrl}
              disabled={loadingUrl}
              className="rounded-lg bg-foreground px-4 py-2 text-sm text-background hover:bg-foreground/90 disabled:opacity-50"
            >
              {loadingUrl ? "Loading…" : "Load preview"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
