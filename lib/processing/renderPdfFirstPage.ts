// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.7 — render a PDF's first page to a PNG via poppler's `pdftoppm`,
// and read its page count via `pdfinfo`. Used for document assets (the
// mobile ML Kit scanner uploads multi-page PDFs).
//
// `pdftoppm ... -` streams the PNG to stdout; `-singlefile` drops the
// page-number suffix. Output: PNG bytes (Buffer), handed straight to the
// same sharp/R2 encode pipeline image thumbnails use.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export async function renderPdfFirstPage(
  file: string,
  options: { dpi?: number } = {}
): Promise<Buffer> {
  const dpi = options.dpi ?? 150;
  const args = [
    "-png",
    "-f", "1",
    "-l", "1",
    "-r", String(dpi),
    "-singlefile",
    file,
    "-",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn("pdftoppm", args);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pdftoppm exit ${code}: ${err.trim().slice(-400)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    p.on("error", reject);
  });
}

// Returns the page total, or null if pdfinfo fails / can't parse — callers
// treat a null count as "unknown" and leave the column NULL.
export async function pdfPageCount(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn("pdfinfo", [file]);
    let out = "";
    p.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    p.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const m = out.match(/^Pages:\s+(\d+)/m);
      resolve(m ? parseInt(m[1], 10) : null);
    });
    p.on("error", () => resolve(null));
  });
}
