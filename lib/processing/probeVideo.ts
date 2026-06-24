// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ffprobe wrapper. Returns duration (sec), video codec, container width
// / height, and bit rate. Used by processAsset for video assets to seed
// duration_seconds + video_codec columns.

import { spawn } from "node:child_process";

export interface VideoProbe {
  durationSec: number | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  bitRate: number | null;
  // M13 / ADR 0054 — copy-if-compatible + HDR gate inputs. Additive; existing
  // callers (generateThumbnails, generateSpriteSheet) ignore these.
  vProfile: string | null; // video stream `profile` ("High", "Main", "Constrained Baseline")
  vPixFmt: string | null; // `pix_fmt` ("yuv420p", "yuv420p10le", …)
  vLevel: number | null; // ffprobe int level (40 == L4.0, 31 == L3.1)
  colorPrimaries: string | null;
  colorTransfer: string | null; // PRIMARY HDR signal (smpte2084 / arib-std-b67)
  colorSpace: string | null;
  aCodec: string | null; // audio stream codec_name ("aac", …)
  aChannels: number | null;
}

interface FfprobeRaw {
  format?: { duration?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    profile?: string;
    pix_fmt?: string;
    level?: number;
    color_primaries?: string;
    color_transfer?: string;
    color_space?: string;
    channels?: number;
  }>;
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const raw = await runFfprobe(file);
  const video = raw.streams?.find((s) => s.codec_type === "video");
  const audio = raw.streams?.find((s) => s.codec_type === "audio");
  return {
    durationSec: raw.format?.duration ? Number.parseFloat(raw.format.duration) : null,
    codec: video?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    bitRate: raw.format?.bit_rate ? Number.parseInt(raw.format.bit_rate, 10) : null,
    vProfile: video?.profile ?? null,
    vPixFmt: video?.pix_fmt ?? null,
    vLevel: typeof video?.level === "number" ? video.level : null,
    colorPrimaries: video?.color_primaries ?? null,
    colorTransfer: video?.color_transfer ?? null,
    colorSpace: video?.color_space ?? null,
    aCodec: audio?.codec_name ?? null,
    aChannels: typeof audio?.channels === "number" ? audio.channels : null,
  };
}

function runFfprobe(file: string): Promise<FfprobeRaw> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ];
    const p = spawn("ffprobe", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => { out += c.toString(); });
    p.stderr.on("data", (c) => { err += c.toString(); });
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exit ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as FfprobeRaw);
      } catch (e) {
        reject(new Error(`ffprobe JSON parse failed: ${(e as Error).message}`));
      }
    });
    p.on("error", reject);
  });
}
