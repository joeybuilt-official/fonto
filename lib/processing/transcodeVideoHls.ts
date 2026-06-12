// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 8b — HLS ladder transcoder.
//
// Downloads the source video from R2 to a temp dir, runs ONE ffmpeg
// invocation that emits all three renditions (360p / 720p / 1080p)
// plus per-rendition .m3u8 playlists and .ts segments, writes a master
// playlist that references them, then uploads everything to R2.
//
// One ffmpeg invocation > three serial calls — ffmpeg decodes the
// source once and forks the encoder per output. The bitrate ladder is
// fixed (C7 day-one decision); upgrading to per-source adaptive
// ladders later is a constants-table change.
//
// Idempotent: re-running overwrites the same R2 keys. The job handler
// flips hls_state to 'transcoding' before calling here and to 'ready'
// after; failures bubble and the job handler marks 'failed'.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hlsMasterKey,
  hlsRenditionKey,
  hlsSegmentKeyPrefix,
  assetStorageKey,
} from "@/lib/r2";
import { storage } from "@/lib/storage";

export interface RenditionSpec {
  // Used in the m3u8 filename + segment prefix.
  name: "360p" | "720p" | "1080p";
  height: number;
  // Total bitrate budget (video + audio + container). The encoder
  // splits ~90% to video, ~10% to audio.
  bitrateKbps: number;
  // Maximum allowed video bitrate (libx264 -maxrate). We size at
  // 1.5× target so VBV doesn't choke on motion-heavy scenes.
  maxBitrateKbps: number;
  // VBV buffer (libx264 -bufsize). 2× maxrate is the standard rule.
  bufSizeKbps: number;
  // H.264 profile/level. Stay broadly compatible: high@4.0 plays on
  // every browser the project supports.
  profile: "main" | "high";
  level: string;
}

export const HLS_LADDER: readonly RenditionSpec[] = [
  {
    name: "360p",
    height: 360,
    bitrateKbps: 800,
    maxBitrateKbps: 1200,
    bufSizeKbps: 2400,
    profile: "main",
    level: "3.0",
  },
  {
    name: "720p",
    height: 720,
    bitrateKbps: 2500,
    maxBitrateKbps: 3750,
    bufSizeKbps: 7500,
    profile: "main",
    level: "3.1",
  },
  {
    name: "1080p",
    height: 1080,
    bitrateKbps: 5000,
    maxBitrateKbps: 7500,
    bufSizeKbps: 15000,
    profile: "high",
    level: "4.0",
  },
];

export interface PersistedRendition {
  name: string;
  key: string;
  height: number;
  bitrateKbps: number;
  codec: "h264";
}

export interface HlsTranscodeResult {
  masterKey: string;
  renditions: PersistedRendition[];
  // Where to find the segments — caller may persist if they want to
  // do a key-prefix delete on cleanup. Derivable from (ws, asset).
  segmentPrefix: string;
}

export interface TranscodeOptions {
  workspaceId: string;
  assetId: string;
  filename: string;
}

export async function transcodeVideoHls(
  opts: TranscodeOptions
): Promise<HlsTranscodeResult> {
  const tmp = await mkdtemp(join(tmpdir(), "fonto-hls-"));
  const sourcePath = join(tmp, "source");
  const outDir = join(tmp, "out");
  await mkdir(outDir, { recursive: true });

  try {
    // 1. Download source.
    const sourceKey = assetStorageKey(opts.workspaceId, opts.assetId, opts.filename);
    const buf = await storage().getBuffer(sourceKey);
    await writeFile(sourcePath, buf);

    // 2. Build the ffmpeg argv. One invocation, N outputs.
    //
    // Filter graph:
    //   [0:v]split=N[v1][v2][v3]; [v1]scale=-2:360, [v2]scale=-2:720, …
    // The `-2` width forces even pixels (H.264 requires it) while
    // preserving aspect ratio at the requested height.
    const splits = HLS_LADDER.map((_, i) => `[v${i}]`).join("");
    const scaleChains = HLS_LADDER.map(
      (r, i) => `[v${i}]scale=trunc(oh*a/2)*2:${r.height}[vout${i}]`
    ).join(";");
    const filter = `[0:v]split=${HLS_LADDER.length}${splits};${scaleChains}`;

    const args: string[] = [
      "-y",
      "-i", sourcePath,
      "-filter_complex", filter,
    ];

    HLS_LADDER.forEach((r, i) => {
      args.push(
        "-map", `[vout${i}]`,
        "-map", "0:a?",                          // audio if present
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-profile:v", r.profile,
        "-level", r.level,
        "-pix_fmt", "yuv420p",
        "-sc_threshold", "0",
        "-g", "48",                              // GOP = 2s @ 24fps; keyframe-aligned across ladder
        "-keyint_min", "48",
        "-b:v", `${r.bitrateKbps}k`,
        "-maxrate", `${r.maxBitrateKbps}k`,
        "-bufsize", `${r.bufSizeKbps}k`,
        "-c:a", "aac",
        "-ar", "48000",
        "-b:a", "128k",
        "-ac", "2",
        "-hls_time", "4",
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", join(outDir, `${r.name}_%03d.ts`),
        "-f", "hls",
        join(outDir, `${r.name}.m3u8`)
      );
    });

    await runFfmpeg(args);

    // 3. Write the master playlist by hand. ffmpeg's hls muxer doesn't
    // emit one when invoked with multiple output streams in one run;
    // simpler + more predictable to assemble in JS.
    const masterLines = ["#EXTM3U", "#EXT-X-VERSION:3"];
    for (const r of HLS_LADDER) {
      // Bandwidth in the master playlist is the peak (maxrate), per
      // the HLS spec. Audio is folded in.
      const bw = (r.maxBitrateKbps + 128) * 1000;
      const widthApprox = Math.round((r.height * 16) / 9 / 2) * 2;
      masterLines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${widthApprox}x${r.height},CODECS="avc1.4d401e,mp4a.40.2"`,
        `${r.name}.m3u8`
      );
    }
    const masterContent = masterLines.join("\n") + "\n";
    await writeFile(join(outDir, "master.m3u8"), masterContent);

    // 4. Upload everything to R2. Master + per-rendition playlists +
    // every segment. Done sequentially so a partial upload doesn't
    // leave a torn playlist visible to clients before its segments.
    const files = await readdir(outDir);
    const masterR2 = hlsMasterKey(opts.workspaceId, opts.assetId);
    const segmentPrefix = hlsSegmentKeyPrefix(opts.workspaceId, opts.assetId);

    const renditionR2: PersistedRendition[] = HLS_LADDER.map((r) => ({
      name: r.name,
      key: hlsRenditionKey(opts.workspaceId, opts.assetId, r.name),
      height: r.height,
      bitrateKbps: r.bitrateKbps,
      codec: "h264",
    }));

    // Segments first (so a playlist pointing at them is always valid),
    // then per-rendition playlists, then the master last.
    for (const f of files) {
      if (f.endsWith(".ts")) {
        await storage().put(`${segmentPrefix}${f}`, await readFile(join(outDir, f)), {
          contentType: "video/MP2T",
        });
      }
    }
    for (const r of HLS_LADDER) {
      await storage().put(
        hlsRenditionKey(opts.workspaceId, opts.assetId, r.name),
        await readFile(join(outDir, `${r.name}.m3u8`)),
        { contentType: "application/vnd.apple.mpegurl" }
      );
    }
    await storage().put(masterR2, Buffer.from(masterContent), {
      contentType: "application/vnd.apple.mpegurl",
    });

    return {
      masterKey: masterR2,
      renditions: renditionR2,
      segmentPrefix,
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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg HLS exit ${code}: ${err.trim().slice(-800)}`));
      }
    });
    p.on("error", reject);
  });
}
