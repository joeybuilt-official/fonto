// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Inline (non-modal) document renderer for the lightbox media area: a PDF via a
// signed original-file iframe, an optional OCR/extracted-text panel, and a
// download fallback for types that can't preview. This is the reason a document
// asset opens the library lightbox instead of the broken image path (M2
// canonical parity — the /app/documents PreviewPane brought into Library).
//
// The modal sibling with its own full-screen chrome is
// components/document-viewer.tsx (used by Search); this one is chromeless so it
// nests inside the lightbox's existing media frame.

"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2, Download } from "lucide-react";

export function DocPreview({
  assetId,
  filename,
  mimeType,
  text,
}: {
  assetId: string;
  filename: string;
  mimeType: string;
  text?: string | null;
}) {
  // The lightbox's own `url` is a preview *variant* (webp); a PDF iframe needs
  // the original signed file, so fetch it here (same endpoint DocumentViewer
  // uses) rather than reusing the variant URL.
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"preview" | "text">("preview");

  const hasText = Boolean(text?.trim());
  const isPdf = mimeType === "application/pdf";

  // The lightbox mounts this with key={assetId}, so a new document remounts
  // fresh (url=null, loading=true, tab="preview") — no synchronous reset here,
  // state is only touched in the async callbacks.
  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/assets/${assetId}/url`)
      .then((r) => (r.ok ? r.json() : { url: null }))
      .then((d: { url?: string | null }) => {
        if (alive) setUrl(d.url ?? null);
      })
      .catch(() => {
        if (alive) setUrl(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [assetId]);

  return (
    <div className="flex h-full max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-lowest)]">
      {/* Header — filename + preview/text toggle (text only when OCR exists). */}
      <div className="flex h-11 shrink-0 items-center gap-[var(--ft-space-2)] border-b border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] px-[var(--ft-space-3)]">
        <FileText className="h-4 w-4 shrink-0 text-[var(--ft-color-on-surface-variant)]" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-surface)]">
          {filename}
        </span>
        {hasText && (
          <div className="flex shrink-0 items-center gap-[var(--ft-space-1)]" role="tablist" aria-label="Document view">
            {(["preview", "text"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-[var(--ft-shape-full)] px-[var(--ft-space-3)] py-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium transition-colors ${
                  tab === t
                    ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                    : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
                }`}
              >
                {t === "preview" ? "Preview" : "Text"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body. */}
      {tab === "text" && hasText ? (
        <div className="flex-1 overflow-y-auto p-[var(--ft-space-5)]">
          <pre className="whitespace-pre-wrap font-mono text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
            {text}
          </pre>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--ft-color-on-surface-variant)]/50" />
        </div>
      ) : url && isPdf ? (
        <iframe
          src={url}
          title={filename}
          className="min-h-0 flex-1 border-0 bg-[var(--ft-color-surface-container-lowest)]"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-[var(--ft-space-3)] p-[var(--ft-space-6)] text-center text-[var(--ft-color-on-surface-variant)]">
          <FileText className="h-12 w-12" />
          <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]">
            {url ? "Preview isn't available for this file type." : "Couldn't load this document."}
          </p>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] px-[var(--ft-space-4)] py-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-primary)]"
            >
              <Download className="h-4 w-4" />
              Open file
            </a>
          )}
        </div>
      )}
    </div>
  );
}
