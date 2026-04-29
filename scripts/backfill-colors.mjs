#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Convenience wrapper: pHash + colors are computed in the same pass — colors
// alone has no separate code path.
process.argv.push("--phash");
await import("./backfill-perceptual.mjs");
