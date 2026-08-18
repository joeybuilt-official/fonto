#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Convenience wrapper: backfill perceptual hashes + colors for image assets.
// Equivalent to: node scripts/backfill-perceptual.mjs --phash
process.argv.push("--phash");
await import("./backfill-perceptual.mjs");
