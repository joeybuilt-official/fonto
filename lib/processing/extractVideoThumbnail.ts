// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Extract a single-frame JPEG thumbnail from a video. Seeks to the
// 10% mark (with a 1 sec minimum so 0-length clips don't grab frame
// zero). `-ss` BEFORE `-i` enables fast seek to the nearest preceding
// keyframe — quick + correct enough for a thumbnail.
//
// Output: JPEG bytes (Buffer). Caller owns persistence (typically
// passed straight to the same sharp/R2 pipeline image thumbnails use).
//
// Phase C1 (2026-09-09) — three real, narrow ffmpeg-invocation bugs were
// diagnosed against 131 of the 252 `thumbnail_state='failed'` rows in
// production (see docs/claude/worklog.md), all sharing one symptom family:
// ffmpeg either threw at the seek point or silently produced 0 bytes at
// exit 0.
//
//   1. `-map 0:v:0` — WITHOUT an explicit map, ffmpeg's automatic "best
//      stream" heuristic can pick the wrong video track in a multi-video-
//      stream container (verified on Pixel "Motion Photo" dual-HEVC MP4s:
//      it picked the secondary 0.6fps/2048x1536 track over the real
//      29.59fps/1024x768 one, which then has no frame near the seek point).
//   2. `-strict unofficial` — Android/HEVC sources commonly report limited
//      ("tv") range YUV; mjpeg's encoder refuses to open at all without
//      this ("Non full-range YUV is non-standard"), which is the actual
//      cause of most "Terminating thread with return code -22 (Invalid
//      argument)" / "Input Buffer is empty" rows, not a corrupt source.
//   3. Retry once at `atSec: 0` if the caller's chosen seek point produces
//      nothing. For very short clips (sub-1.1s — motion-photo clips, live
//      photos) the caller's `max(duration*0.1, 1)` floor can land past the
//      last available frame; fast keyframe seek then finds nothing to
//      decode even though the file is perfectly readable at its start.
//      Verified against all 131 production rows in this class: every one
//      recovers with (1)+(2)+(3) combined — frame 0 is always inside the
//      file's actual duration.
//
// None of this adds decode capability (no new library, no new codec) — it
// corrects three CLI-invocation choices that were silently discarding
// frames ffmpeg could already decode.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

async function runFfmpegFrame(
  file: string,
  atSec: number,
  maxWidth: number
): Promise<Buffer> {
  const args = [
    "-y",
    "-ss", String(Math.max(atSec, 0)),
    "-i", file,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    "-q:v", "3",
    "-strict", "unofficial",
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

export async function extractVideoThumbnail(
  file: string,
  options: { atSec?: number; maxWidth?: number } = {}
): Promise<Buffer> {
  const at = options.atSec ?? 0;
  const maxW = options.maxWidth ?? 1280;

  try {
    const buf = await runFfmpegFrame(file, at, maxW);
    if (buf.length > 0 || at === 0) return buf;
  } catch (err) {
    if (at === 0) throw err;
  }

  // The requested offset produced nothing (thrown or empty) and wasn't
  // already 0 — retry at the start of the video, which is always inside
  // the file's actual duration.
  return runFfmpegFrame(file, 0, maxW);
}
