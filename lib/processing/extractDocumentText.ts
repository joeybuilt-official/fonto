// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Document text extraction for the processing pipeline. Produces the
// `ocr_text` searchable layer (and the source text for LLM descriptions)
// for non-image assets:
//
//   - application/pdf : pdftotext for the embedded text layer; if the PDF is
//                       an image-only scan (no text), OCR the rendered
//                       preview derivative via the vision service.
//   - text/*          : decode the raw bytes as UTF-8 (capped).
//
// Image OCR stays in processAsset.runOcrForAsset (it presigns the original
// and hits the vision model directly). This module is the doc counterpart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { intelligence } from "@/lib/intelligence/client";
import { pdfExtractText } from "@/lib/processing/renderPdfFirstPage";

// Cap raw text reads so a multi-MB log/code file can't blow up memory or the
// downstream LLM prompt. 256 KB is ~40k words — far more than any
// description/embedding step needs.
const TEXT_BYTE_CAP = 256 * 1024;
// Below this many non-whitespace chars, treat a PDF's text layer as "empty"
// (an image-only scan) and fall back to OCR.
const MIN_PDF_TEXT_CHARS = 16;

export type DocTextMethod = "pdf-text" | "pdf-ocr" | "plain-text" | "none";

export interface DocTextResult {
  text: string;
  method: DocTextMethod;
}

async function downloadToBuffer(bucket: string, key: string): Promise<Buffer> {
  return storage().getBuffer(key);
}

export async function extractDocumentText(params: {
  workspaceId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  /** Rendered preview derivative key, used to OCR scanned PDFs. May be null
   *  if the thumbnail job hasn't run yet — scanned PDFs then yield no text. */
  previewKey: string | null;
}): Promise<DocTextResult> {
  const { workspaceId, assetId, filename, mimeType, previewKey } = params;
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return { text: "", method: "none" };
  const key = assetStorageKey(workspaceId, assetId, filename);

  if (mimeType === "application/pdf") {
    const tmp = path.join(
      os.tmpdir(),
      `fonto-doc-${crypto.randomBytes(8).toString("hex")}.pdf`
    );
    try {
      const buf = await downloadToBuffer(bucket, key);
      await fs.promises.writeFile(tmp, buf);
      const text = (await pdfExtractText(tmp)).trim();
      if (text.replace(/\s/g, "").length >= MIN_PDF_TEXT_CHARS) {
        return { text, method: "pdf-text" };
      }
      // Image-only scan: OCR the rendered preview derivative if it exists.
      if (previewKey) {
        const url = await storage().presignGet(previewKey, { expiresIn: 300 });
        const ocrText = await intelligence
          .ocr({ imageUrl: url })
          .then((r) => r.spans.map((s) => s.text).join("\n"))
          .catch(() => null);
        if (ocrText && ocrText.trim()) {
          return { text: ocrText.trim(), method: "pdf-ocr" };
        }
      }
      return { text: "", method: "none" };
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  if (mimeType.startsWith("text/")) {
    const buf = await downloadToBuffer(bucket, key);
    const text = buf.subarray(0, TEXT_BYTE_CAP).toString("utf8").trim();
    return text ? { text, method: "plain-text" } : { text: "", method: "none" };
  }

  return { text: "", method: "none" };
}
