// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Extract a single-frame JPEG thumbnail from a video. Seeks to the
// 10% mark (with a 1 sec minimum so 0-length clips don't grab frame
// zero). `-ss` BEFORE `-i` enables fast seek to the nearest preceding
// keyframe — quick + correct enough for a thumbnail.
//
// Output: JPEG bytes (Buffer). Caller owns persistence (typically
// passed straight to the same sharp/R2 pipeline image thumbnails use).

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export async function extractVideoThumbnail(
  file: string,
  options: { atSec?: number; maxWidth?: number } = {}
): Promise<Buffer> {
  const at = options.atSec ?? 0;
  const maxW = options.maxWidth ?? 1280;
  const args = [
    "-y",
    "-ss", String(Math.max(at, 0)),
    "-i", file,
    "-frames:v", "1",
    "-vf", `scale='min(${maxW},iw)':-2`,
    "-q:v", "3",
    "-f", "image2pipe",
    "-c:v", "mjpeg",
    "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-400)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    p.on("error", reject);
  });
}
