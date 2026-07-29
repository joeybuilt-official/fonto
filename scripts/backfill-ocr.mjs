#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Convenience wrapper: backfill OCR text via Plexo's vision endpoint.
process.argv.push("--ocr");
await import("./backfill-perceptual.mjs");
