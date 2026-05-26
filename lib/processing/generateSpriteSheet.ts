// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 8b — hover-scrub sprite sheet.
//
// Extracts one tile every `SPRITE_INTERVAL_SEC` from the source video,
// composites them all into a single JPEG, and uploads it to R2. The
// player UI reads `sprite_meta` from the asset row to derive the
// background-position for the tile under the user's hover percentage.
//
// Layout: rectangular grid, columns chosen to keep the resulting JPEG
// roughly square-ish. `interval` + `totalFrames` + `columns` are the
// only fields the client strictly needs; tileWidth/tileHeight are
// passed through for CSS sizing.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, hlsSpriteKey, assetStorageKey } from "@/lib/r2";

const SPRITE_INTERVAL_SEC = 10;
const TILE_HEIGHT = 90;        // px; tile aspect-ratio matches the source
const MAX_TILES = 200;         // cap so a 30-min video doesn't blow R2

export interface SpriteMeta {
  interval: number;            // seconds per tile
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  totalFrames: number;
}

export interface GenerateSpriteResult {
  spriteKey: string;
  meta: SpriteMeta;
}

export interface GenerateSpriteOptions {
  workspaceId: string;
  assetId: string;
  filename: string;
  // Source duration in seconds (from probeVideo) so we know how many
  // tiles to emit. Passed in so we don't re-probe.
  durationSec: number;
  // Source aspect ratio used to size each tile. Defaults to 16:9 if
  // unknown.
  sourceWidth?: number | null;
  sourceHeight?: number | null;
}

export async function generateSpriteSheet(
  opts: GenerateSpriteOptions
): Promise<GenerateSpriteResult> {
  if (opts.durationSec <= 0) {
    throw new Error(`generateSpriteSheet: durationSec must be > 0 (got ${opts.durationSec})`);
  }
  const bucket = process.env.R2_BUCKET!;
  const s3 = getS3Client();
  const tmp = await mkdtemp(join(tmpdir(), "fonto-sprite-"));
  const sourcePath = join(tmp, "source");
  const framesDir = join(tmp, "frames");
  await mkdir(framesDir, { recursive: true });

  try {
    // Download source.
    const sourceKey = assetStorageKey(opts.workspaceId, opts.assetId, opts.filename);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
    if (!obj.Body) throw new Error(`R2 GET ${sourceKey} returned no body`);
    const buf = Buffer.from(await obj.Body.transformToByteArray());
    await import("node:fs/promises").then((fs) => fs.writeFile(sourcePath, buf));

    // Compute tile width from source aspect.
    const aspect =
      opts.sourceWidth && opts.sourceHeight
        ? opts.sourceWidth / opts.sourceHeight
        : 16 / 9;
    const tileWidth = Math.max(2, Math.round((TILE_HEIGHT * aspect) / 2) * 2);

    // Total tiles capped at MAX_TILES — for very long videos this
    // effectively widens the sprite interval.
    const desiredTiles = Math.max(1, Math.floor(opts.durationSec / SPRITE_INTERVAL_SEC));
    const totalFrames = Math.min(desiredTiles, MAX_TILES);
    const intervalSec = opts.durationSec / totalFrames;
    // ffmpeg fps filter expression: 1 frame per `intervalSec` seconds.
    const fps = 1 / intervalSec;

    // Extract frames at the chosen rate to numbered JPEGs.
    await runFfmpeg([
      "-y",
      "-i", sourcePath,
      "-vf", `fps=${fps.toFixed(6)},scale=${tileWidth}:${TILE_HEIGHT}`,
      "-frames:v", String(totalFrames),
      "-q:v", "5",
      join(framesDir, "frame_%04d.jpg"),
    ]);

    const frames = (await readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (frames.length === 0) {
      throw new Error("generateSpriteSheet: ffmpeg emitted zero frames");
    }

    // Layout: ~square grid. ceil(sqrt(N)) columns is a tidy default.
    const columns = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
    const rows = Math.ceil(frames.length / columns);

    // Composite via sharp. Each tile is placed by (row, col) → pixel
    // position; sharp.composite handles compositing in one pass.
    const composites = await Promise.all(
      frames.map(async (file, i) => {
        const row = Math.floor(i / columns);
        const col = i % columns;
        return {
          input: await readFile(join(framesDir, file)),
          top: row * TILE_HEIGHT,
          left: col * tileWidth,
        };
      })
    );

    const spriteBuf = await sharp({
      create: {
        width: columns * tileWidth,
        height: rows * TILE_HEIGHT,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 70 })
      .toBuffer();

    const spriteKey = hlsSpriteKey(opts.workspaceId, opts.assetId);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: spriteKey,
        Body: spriteBuf,
        ContentType: "image/jpeg",
      })
    );

    return {
      spriteKey,
      meta: {
        interval: intervalSec,
        columns,
        rows,
        tileWidth,
        tileHeight: TILE_HEIGHT,
        totalFrames: frames.length,
      },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg sprite exit ${code}: ${err.trim().slice(-400)}`));
    });
    p.on("error", reject);
  });
}
