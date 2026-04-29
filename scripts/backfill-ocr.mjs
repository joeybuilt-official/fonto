#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Convenience wrapper: backfill OCR text via Plexo's vision endpoint.
process.argv.push("--ocr");
await import("./backfill-perceptual.mjs");
