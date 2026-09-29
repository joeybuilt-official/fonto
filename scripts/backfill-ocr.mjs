#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Convenience wrapper: backfill OCR text via the vision sidecar.
process.argv.push("--ocr");
await import("./backfill-perceptual.mjs");
