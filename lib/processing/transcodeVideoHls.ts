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
import { probeVideo, type VideoProbe } from "@/lib/processing/probeVideo";

// M13 / ADR 0054 — video transcode stays CPU-only on the host (GPUs reserved for
// ML inference). The wins here are CPU-side + config-gated:
//   FONTO_HLS_COPY_FASTPATH — stream-copy an already-web-playable H.264/AAC
//     source straight into HLS (no libx264 re-encode). Default ON.
//   FONTO_HLS_FMP4 — copy path emits fMP4/CMAF (.m4s + init); "0" → mpegts .ts.
//   FONTO_HLS_HDR_TONEMAP — tonemap PQ/HLG HDR → SDR on the transcode path so
//     HDR sources stop rendering washed-out. Default ON.
//   FONTO_HLS_COPY_MAX_BITRATE — source-bitrate ceiling (bytes/sec) above which
//     a source transcodes instead of copies (no ABR for a single copied rung).
const HLS_COPY_FASTPATH = process.env.FONTO_HLS_COPY_FASTPATH !== "0";
const HLS_FMP4 = process.env.FONTO_HLS_FMP4 !== "0";
const HLS_HDR_TONEMAP = process.env.FONTO_HLS_HDR_TONEMAP !== "0";
const HLS_COPY_MAX_BITRATE = Number(
  process.env.FONTO_HLS_COPY_MAX_BITRATE ?? "12000000"
);

const COPY_HLS_TIME = 4;

function isHdr(p: VideoProbe): boolean {
  return p.colorTransfer === "smpte2084" || p.colorTransfer === "arib-std-b67";
}

/**
 * M13 — a source qualifies for stream-copy (no re-encode) only when it is
 * ALREADY a strictly web-playable H.264 (8-bit 4:2:0, ≤High@4.0, ≤1080p,
 * ≤ceiling-bitrate, SDR) with AAC ≤2ch (or no) audio. The gate is deliberately
 * strict: a mis-copied incompatible stream silently breaks the player, whereas
 * a needless transcode is merely slow.
 */
export function canStreamCopy(p: VideoProbe): boolean {
  if (!HLS_COPY_FASTPATH) return false;
  if (p.codec !== "h264") return false;
  const prof = (p.vProfile ?? "").toLowerCase();
  if (!["constrained baseline", "baseline", "main", "high"].includes(prof)) {
    return false; // rejects "High 10", "High 4:2:2", "High 4:4:4"
  }
  if (p.vPixFmt !== "yuv420p") return false; // rejects 10-bit / 422 / 444
  if (p.vLevel == null || p.vLevel > 40) return false;
  if (isHdr(p)) return false;
  if ((p.colorPrimaries ?? "") === "bt2020") return false;
  if (p.width == null || p.height == null || p.width > 1920 || p.height > 1080) {
    return false;
  }
  if (p.bitRate == null || p.bitRate > HLS_COPY_MAX_BITRATE) return false;
  const hasAudio = p.aCodec != null;
  if (hasAudio && (p.aCodec !== "aac" || (p.aChannels ?? 99) > 2)) return false;
  return true;
}

/** Build the master-playlist CODECS attribute for a copied H.264 source. */
function avcCodecsString(p: VideoProbe): string {
  const prof = (p.vProfile ?? "main").toLowerCase();
  const profileByte = prof === "high" ? "6400" : prof.includes("baseline") ? "4240" : "4d40";
  const lvlHex = (p.vLevel ?? 30).toString(16).padStart(2, "0");
  const avc = `avc1.${profileByte}${lvlHex}`;
  return p.aCodec != null ? `${avc},mp4a.40.2` : avc;
}

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
  // M13 — optional pre-computed probe (the worker already needs one for the
  // sprite). When omitted, transcodeVideoHls probes the source itself.
  probe?: VideoProbe;
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

    // M13 — probe once. The copy gate + HDR detection both need it; the job
    // handler also re-uses duration/dims for the sprite, but probing here keeps
    // transcodeVideoHls self-sufficient + idempotent.
    const probe = opts.probe ?? (await probeVideo(sourcePath));

    // M13 — copy-if-compatible fast path: skip libx264 entirely for sources
    // that are already web-playable. Falls back to the ladder if the copy
    // produces pathological segments (sparse keyframes).
    if (canStreamCopy(probe)) {
      const copied = await streamCopyHls(opts, probe, sourcePath, outDir);
      if (copied) return copied;
      // else: fall through to the transcode ladder (clean outDir first).
      for (const f of await readdir(outDir)) {
        await rm(join(outDir, f), { force: true }).catch(() => undefined);
      }
    }

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
    // M13 — filter head. HDR (PQ/HLG) sources get a zscale→tonemap→zscale
    // chain so they map to SDR bt709 instead of rendering washed-out. Every
    // source (incl. 10-bit SDR HEVC/VP9/AV1) gets format=yuv420p so libx264
    // High-profile doesn't choke on a non-4:2:0 input.
    const head =
      HLS_HDR_TONEMAP && isHdr(probe)
        ? `[0:v]zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,split=${HLS_LADDER.length}${splits}`
        : `[0:v]format=yuv420p,split=${HLS_LADDER.length}${splits}`;
    const filter = `${head};${scaleChains}`;

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
        // M13 — tag output SDR/bt709 (matters once an HDR source is tonemapped).
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
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

/**
 * M13 — stream-copy a web-playable H.264 source into a single-rendition HLS
 * (no re-encode). Returns the result, or null when the copy produced
 * pathological segments (sparse keyframes → over-long first segment), in which
 * case the caller falls back to the transcode ladder.
 */
async function streamCopyHls(
  opts: TranscodeOptions,
  probe: VideoProbe,
  sourcePath: string,
  outDir: string
): Promise<HlsTranscodeResult | null> {
  const args: string[] = [
    "-y",
    "-i", sourcePath,
    "-map", "0:v:0",
    "-map", "0:a:0?", // optional audio — audio-less sources don't fail
    "-c", "copy",
    "-hls_time", String(COPY_HLS_TIME),
    "-hls_playlist_type", "vod",
  ];
  if (HLS_FMP4) {
    args.push(
      "-hls_segment_type", "fmp4",
      "-hls_fmp4_init_filename", "source_init.mp4",
      "-hls_segment_filename", join(outDir, "source_%03d.m4s")
    );
  } else {
    args.push(
      "-hls_segment_type", "mpegts",
      "-hls_segment_filename", join(outDir, "source_%03d.ts")
    );
  }
  args.push("-f", "hls", join(outDir, "source.m3u8"));

  await runFfmpeg(args);

  // Sparse-keyframe guard: stream-copy can only split at existing keyframes, so
  // a source with rare keyframes yields an over-long first segment. If so, bail
  // and let the caller transcode (slow-but-correct beats torn playback).
  const mediaPlaylist = await readFile(join(outDir, "source.m3u8"), "utf8");
  const firstExtinf = mediaPlaylist.match(/#EXTINF:([\d.]+)/);
  if (firstExtinf && Number.parseFloat(firstExtinf[1]) > COPY_HLS_TIME * 2) {
    return null;
  }

  // Master playlist — ONE stream, CODECS computed from the probe (never
  // hardcoded; the player negotiates from these).
  const bw = probe.bitRate ?? Math.round((probe.width ?? 1280) * (probe.height ?? 720) * 4);
  const res = `${probe.width ?? 0}x${probe.height ?? 0}`;
  const masterContent =
    [
      "#EXTM3U",
      `#EXT-X-VERSION:${HLS_FMP4 ? 7 : 3}`,
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${res},CODECS="${avcCodecsString(probe)}"`,
      "source.m3u8",
    ].join("\n") + "\n";

  const masterR2 = hlsMasterKey(opts.workspaceId, opts.assetId);
  const segmentPrefix = hlsSegmentKeyPrefix(opts.workspaceId, opts.assetId);

  // Segments + init first (so the playlist is always valid once visible), then
  // the media playlist, then the master last.
  const files = await readdir(outDir);
  for (const f of files) {
    if (f.endsWith(".m4s") || f === "source_init.mp4") {
      await storage().put(`${segmentPrefix}${f}`, await readFile(join(outDir, f)), {
        contentType: "video/mp4",
      });
    } else if (f.endsWith(".ts")) {
      await storage().put(`${segmentPrefix}${f}`, await readFile(join(outDir, f)), {
        contentType: "video/MP2T",
      });
    }
  }
  await storage().put(
    hlsRenditionKey(opts.workspaceId, opts.assetId, "source"),
    await readFile(join(outDir, "source.m3u8")),
    { contentType: "application/vnd.apple.mpegurl" }
  );
  await storage().put(masterR2, Buffer.from(masterContent), {
    contentType: "application/vnd.apple.mpegurl",
  });

  return {
    masterKey: masterR2,
    renditions: [
      {
        name: "source",
        key: hlsRenditionKey(opts.workspaceId, opts.assetId, "source"),
        height: probe.height ?? 0,
        bitrateKbps: probe.bitRate ? Math.round(probe.bitRate / 1000) : 0,
        codec: "h264",
      },
    ],
    segmentPrefix,
  };
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
