// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.7 — render a PDF's first page to a PNG via poppler's `pdftoppm`,
// and read its page count via `pdfinfo`. Used for document assets (the
// mobile ML Kit scanner uploads multi-page PDFs).
//
// Renders to an explicit temp PNG and reads it back. pdftoppm's "-" stdout
// sink is unreliable across poppler builds: poppler 25.x treats "-" as a file
// root and writes a literal "-.png" into the process cwd (which is read-only
// in the worker image), failing with exit 1 / "Could not write image to
// -.png". Writing to an absolute temp prefix sidesteps both the stdout
// ambiguity and the cwd-writability problem. `-singlefile` drops the
// page-number suffix so the output is exactly `<prefix>.png`.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export async function renderPdfFirstPage(
  file: string,
  options: { dpi?: number } = {}
): Promise<Buffer> {
  const dpi = options.dpi ?? 150;
  const outPrefix = path.join(
    os.tmpdir(),
    `fonto-pdf-render-${crypto.randomBytes(8).toString("hex")}`
  );
  const outPath = `${outPrefix}.png`;
  const args = [
    "-png",
    "-f", "1",
    "-l", "1",
    "-r", String(dpi),
    "-singlefile",
    file,
    outPrefix,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("pdftoppm", args);
      let err = "";
      // poppler emits non-fatal "Syntax Warning" lines on stderr even on
      // success, so key the outcome off the exit code, not stderr presence.
      p.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      p.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`pdftoppm exit ${code}: ${err.trim().slice(-400)}`));
          return;
        }
        resolve();
      });
      p.on("error", reject);
    });
    return await fs.promises.readFile(outPath);
  } finally {
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

// Extracts the embedded text layer of a PDF via poppler's `pdftotext`.
// Digital PDFs (exported from apps) return their full text; image-only
// scans return empty/whitespace, which the caller treats as the signal to
// fall back to OCR. Writes to a temp file and reads it back for the same
// cwd-safety reason as renderPdfFirstPage. Returns "" on any failure.
export async function pdfExtractText(file: string): Promise<string> {
  const outPath = path.join(
    os.tmpdir(),
    `fonto-pdf-text-${crypto.randomBytes(8).toString("hex")}.txt`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("pdftotext", ["-enc", "UTF-8", "-layout", file, outPath]);
      let err = "";
      p.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      p.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`pdftotext exit ${code}: ${err.trim().slice(-300)}`));
          return;
        }
        resolve();
      });
      p.on("error", reject);
    });
    return await fs.promises.readFile(outPath, "utf8");
  } catch {
    return "";
  } finally {
    await fs.promises.unlink(outPath).catch(() => {});
  }
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
