// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// On-device KIND resolution for camera-roll assets shown in the "On this
// device" library section. Mirrors the server-side `deriveKind` (lib/classify
// /kind.ts) at the level of detail that's actually knowable client-side, so
// the device strip respects the same Moments / Screenshots / Graphics /
// Documents / Videos lens tabs the web + server grid use.
//
// Why this exists: the device strip is rendered BEFORE the server can
// classify these assets (they may not even have uploaded yet). Without this
// resolver, every device thumb — phone screenshots, downloaded graphics,
// memes, real photos — lands in Moments because the strip is on the root
// view regardless of the active lens.
//
// Resolution mirrors `deriveKind` rules 1, 5, 6, 10.5, and 11 — the subset
// that doesn't require OCR / vision classification / EXIF parsing:
//
//   1. AssetType.video → video
//   5. iOS PHAssetMediaSubtype.photoScreenshot bit set → screenshot
//   6. isScreenshotByName(title) → screenshot
//   10.5. .png and no camera-roll signal → screenshot
//         .gif → graphics
//   11. default image → moment

import "package:photo_manager/photo_manager.dart";

const String kindMoment = "moment";
const String kindScreenshot = "screenshot";
const String kindGraphics = "graphics";
const String kindVideo = "video";

// Filename markers used by iOS / Android / Pixel / Samsung / 3rd-party tools.
// Mirrors lib/processing/classifyHelpers.ts:SCREENSHOT_NAME_RE.
final RegExp _screenshotNameRe = RegExp(
  r"screenshot|screen.?shot|^scrnli|^screen[_-]?recording",
  caseSensitive: false,
);

// Apple's PHAssetMediaSubtype.photoScreenshot is bit 4 (value = 1 << 2).
// Android does not surface this bit — `subtype` is 0 there, and we fall
// through to the filename + extension heuristics below.
const int _iosSubtypeScreenshot = 4;

class DeviceKind {
  /// Pure resolution for one camera-roll asset. Returns one of:
  /// `moment`, `screenshot`, `graphics`, `video`.
  static Future<String> resolve(AssetEntity e) async {
    if (e.type == AssetType.video) return kindVideo;

    if ((e.subtype & _iosSubtypeScreenshot) != 0) return kindScreenshot;

    final String title = await e.titleAsync;
    if (_screenshotNameRe.hasMatch(title)) return kindScreenshot;

    final String lower = title.toLowerCase();
    if (lower.endsWith(".gif")) return kindGraphics;
    // .png + no camera-roll filename ≈ screen capture whose original
    // "Screenshot..." name was lost (Drive re-encode, chat-app strip).
    if (lower.endsWith(".png")) return kindScreenshot;
    return kindMoment;
  }

  /// Batch resolver. Keyed by `AssetEntity.id` so callers can look kinds up
  /// without re-walking the list.
  ///
  /// [resolve] awaits `titleAsync`, a per-asset MethodChannel round-trip, so
  /// resolving sequentially made a ~120-item strip do 120 serial platform hops
  /// before its lens filtering was ready. Fan the round-trips out with
  /// [Future.wait] so they overlap.
  static Future<Map<String, String>> resolveAll(List<AssetEntity> es) async {
    final kinds = await Future.wait(es.map(resolve));
    final Map<String, String> out = <String, String>{};
    for (var i = 0; i < es.length; i++) {
      out[es[i].id] = kinds[i];
    }
    return out;
  }
}
