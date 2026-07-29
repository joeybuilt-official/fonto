// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, FileText, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";

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

  // Full-screen document viewer. Outer backdrop tokenizes the scrim; the
  // two inner panels (nav + content) sit on tokenized surface containers
  // — this isn't photo chrome so no on-black white-text exception.
  return (
    <div
      className="fixed inset-0 z-50 flex bg-[var(--ft-color-scrim)]/80"
      role="dialog"
      aria-modal="true"
      aria-label={`Document viewer: ${filename}`}
    >
      {/* Left panel — page/nav controls */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)]">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-3)]">
          <span className="truncate text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-surface)]">{filename}</span>
          <Button ref={closeRef} size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close document viewer">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-[var(--ft-color-outline-variant)]">
          <button
            onClick={() => { setActiveTab("preview"); loadUrl(); }}
            className={`flex-1 py-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium transition-colors ${activeTab === "preview" ? "text-[var(--ft-color-on-surface)] border-b-2 border-[var(--ft-color-primary)]" : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"}`}
          >
            Preview
          </button>
          {hasText && (
            <button
              onClick={() => setActiveTab("text")}
              className={`flex-1 py-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium transition-colors ${activeTab === "text" ? "text-[var(--ft-color-on-surface)] border-b-2 border-[var(--ft-color-primary)]" : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"}`}
            >
              Text
            </button>
          )}
        </div>

        {/* Zoom controls (preview only) */}
        {activeTab === "preview" && (
          <div className="flex items-center gap-[var(--ft-space-1)] border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-3)] py-[var(--ft-space-2)]">
            <Button size="icon-xs" variant="ghost" onClick={() => setZoom((z) => Math.max(50, z - 10))} aria-label="Zoom out">
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="flex-1 text-center text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">{zoom}%</span>
            <Button size="icon-xs" variant="ghost" onClick={() => setZoom((z) => Math.min(200, z + 10))} aria-label="Zoom in">
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* File info */}
        <div className="flex-1 overflow-y-auto px-[var(--ft-space-3)] py-[var(--ft-space-3)] space-y-[var(--ft-space-2)]">
          <div className="rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-2)]">
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">Type</p>
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-medium text-[var(--ft-color-on-surface)] mt-0.5">{mimeType}</p>
          </div>
          {hasText && (
            <div className="rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-2)]">
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">Extracted text</p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] mt-0.5 line-clamp-4">{extractedText}</p>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — content */}
      <div className="flex flex-1 flex-col min-w-0 bg-[var(--ft-color-surface-container-lowest)]">
        {activeTab === "text" ? (
          <div className="flex-1 overflow-y-auto p-[var(--ft-space-6)]">
            <pre className="whitespace-pre-wrap text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] font-mono">
              {extractedText}
            </pre>
          </div>
        ) : signedUrl ? (
          <div className="flex flex-1 items-center justify-center overflow-auto p-[var(--ft-space-4)]">
            {isPdf ? (
              <iframe
                src={signedUrl}
                style={{ width: `${zoom}%`, height: "100%", minHeight: 600 }}
                className="rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)]"
                title={filename}
              />
            ) : isImage ? (
              <img
                src={signedUrl}
                alt={filename}
                style={{ maxWidth: `${zoom}%`, maxHeight: "100%" }}
                className="rounded-[var(--ft-shape-small)] object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-[var(--ft-space-3)] text-[var(--ft-color-on-surface-variant)]">
                <FileText className="h-16 w-16" />
                <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]">Preview not available for this file type.</p>
                <Button variant="default" onClick={() => { window.open(signedUrl, "_blank"); }}>
                  Download
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Button onClick={loadUrl} disabled={loadingUrl}>
              {loadingUrl ? "Loading…" : "Load preview"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
