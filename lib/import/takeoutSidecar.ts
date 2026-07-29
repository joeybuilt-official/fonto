// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — Google Takeout JSON-sidecar matching + parsing.
//
// Google Photos Takeout ships each media file with a companion JSON sidecar
// carrying the authoritative `photoTakenTime`, `geoData` (lat/lng), and
// `description`. Matching a media filename to its sidecar is the hard 80% of a
// Takeout import: Google mangles the sidecar names in several documented ways.
// These heuristics are ported from immich-go (simulot/immich-go — the
// reference Takeout parser) rather than reinvented. The four cases this module
// handles, with examples:
//
//   (a) Plain pairing + name truncation. The base case is
//         IMG_1234.jpg  ->  IMG_1234.jpg.json
//       but Google truncates the *sidecar* base name to ~46 characters and,
//       for some exports, uses a ".supplemental-metadata" infix that is itself
//       truncated (".suppl", ".supplemen", …). So a long original may pair
//       with a sidecar whose name is a truncated prefix of `<media>.json` or
//       `<media>.supplemental-metadata.json` (any truncation of the suffix).
//
//   (b) Duplicate counters. When two files collide, Google appends a "(n)"
//       counter — but on the media it lands before the extension while on the
//       sidecar it lands after the *whole* media name:
//         IMG_1234(1).jpg  <->  IMG_1234.jpg(1).json
//
//   (c) Edited variants share the original's sidecar. Google never emits a
//       sidecar for the edited render; the "-edited" / "-modifié" (and other
//       localized) variant reuses the original's JSON:
//         IMG_1234-edited.jpg  ->  IMG_1234.jpg.json
//
//   (d) Extension-in-the-middle truncation. When the base name is already at
//       the ~46-char limit the extension can be clipped off the sidecar
//       entirely (the ".json" is appended to a truncated `<base>.<truncated
//       ext>`), e.g. a very long `<base>.jpg` whose sidecar is
//       `<base-truncated>.j.json`. We match by truncated-prefix comparison so
//       these still resolve to the right media.
//
// The matcher is a pure function over the *set of member names already seen in
// the archive*: given that index + one media name, it returns the best sidecar
// member name (or null). `parseSidecar` then turns the sidecar's JSON bytes
// into a `metadataOverride` for `createAssetRow` (epoch-seconds -> Date; 0/0
// geo dropped; blank description dropped).

/** Parsed, normalised view of a Takeout sidecar's interesting fields. */
export interface SidecarMetadata {
  capturedAt?: Date;
  latitude?: number;
  longitude?: number;
  description?: string;
}

// Google's sidecar base-name truncation length. Empirically ~46 characters of
// the `<media-name>.supplemental-metadata` (or `<media-name>`) string before
// the ".json" suffix. immich-go uses 46; we mirror it.
const TAKEOUT_NAME_CAP = 46;

// Localized "-edited" markers Google uses for the auto-enhanced render. The
// edited file reuses the *original's* sidecar, so we strip these before
// matching. Lower-cased; compared case-insensitively.
const EDITED_MARKERS = [
  "-edited",
  "-modifié", // fr
  "-bearbeitet", // de
  "-modificato", // it
  "-editado", // es / pt
  "-bewerkt", // nl
  "-redigerad", // sv
  "-effounea", // (immich-go's catch-all set)
];

/** Lower-case file extension *with* the leading dot, or "" if none. */
function extOf(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Base name without directory and without the final extension. */
function stem(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Directory portion (everything up to and including the last slash), or "". */
function dirOf(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash >= 0 ? name.slice(0, slash + 1) : "";
}

/**
 * Split a trailing "(n)" duplicate counter off a base name.
 * "IMG_1234(1)" -> { base: "IMG_1234", counter: "(1)" }
 * "IMG_1234"    -> { base: "IMG_1234", counter: "" }
 */
function splitCounter(base: string): { base: string; counter: string } {
  const m = base.match(/^(.*?)(\(\d+\))$/);
  if (m) return { base: m[1], counter: m[2] };
  return { base, counter: "" };
}

/**
 * Strip a localized "-edited" marker (case (c)). Returns the original stem so
 * an edited variant resolves to the source's sidecar. No-op when absent.
 */
function stripEditedMarker(base: string): string {
  const lower = base.toLowerCase();
  for (const marker of EDITED_MARKERS) {
    if (lower.endsWith(marker)) {
      return base.slice(0, base.length - marker.length);
    }
  }
  return base;
}

/**
 * Every plausible sidecar *file name* (no directory) for a given media file
 * name, most-specific first. We emit full forms; the matcher also does a
 * truncated-prefix pass for cases (a)/(d) where Google clipped the name.
 *
 * Given media `IMG_1234(1).jpg` we want, in order:
 *   IMG_1234.jpg(1).json                              (b: counter after ext)
 *   IMG_1234(1).jpg.json                              (counter kept in place)
 *   IMG_1234.jpg.json                                 (a: plain, counter dropped)
 *   IMG_1234.jpg.supplemental-metadata.json           (a: supplemental infix)
 *   IMG_1234.jpg.supplemental-metadata(1).json        (b+supplemental)
 */
function candidateSidecarNames(mediaFileName: string): string[] {
  const ext = extOf(mediaFileName); // ".jpg"
  const rawStem = stem(mediaFileName); // "IMG_1234(1)" or "IMG_1234-edited"
  const editedStem = stripEditedMarker(rawStem); // "IMG_1234(1)" / "IMG_1234"
  const { base, counter } = splitCounter(editedStem); // base "IMG_1234", counter "(1)"

  const fullMedia = `${base}${ext}`; // "IMG_1234.jpg"
  const out: string[] = [];

  // (b) counter relocated after the whole media name
  if (counter) {
    out.push(`${fullMedia}${counter}.json`); // IMG_1234.jpg(1).json
    out.push(`${base}${counter}${ext}.json`); // IMG_1234(1).jpg.json
    out.push(`${fullMedia}.supplemental-metadata${counter}.json`);
  }
  // (a) plain forms (counter dropped — Google sometimes only sidecars the first)
  out.push(`${fullMedia}.json`); // IMG_1234.jpg.json
  out.push(`${fullMedia}.supplemental-metadata.json`);
  // bare-stem fallbacks (some exports drop the media extension on the sidecar)
  out.push(`${base}.json`);
  if (counter) out.push(`${base}${counter}.json`);

  return out;
}

/**
 * Match one media member to its sidecar member within an archive.
 *
 * @param mediaName     Full archive path of the media member (dir + name).
 * @param memberNames   The set of *all* member paths present in the archive.
 *                      Caller may pass a Set for O(1) membership or an array.
 * @returns the sidecar member path, or null when nothing matches.
 *
 * Strategy:
 *   1. Build the ordered candidate names (cases a/b/c above) and try an exact
 *      hit in the same directory as the media. First hit wins (most specific).
 *   2. Truncated-prefix pass (cases a/d): Google clips the sidecar base name to
 *      ~46 chars. For any `.json` member in the same directory, compare its
 *      base (sans ".json") against the truncated prefix of each candidate's
 *      base. This recovers names Google clipped mid-extension.
 */
export function matchSidecar(
  mediaName: string,
  memberNames: Iterable<string>,
): string | null {
  const dir = dirOf(mediaName);
  const set =
    memberNames instanceof Set
      ? (memberNames as Set<string>)
      : new Set<string>(memberNames);

  const candidates = candidateSidecarNames(mediaName);

  // 1. Exact, most-specific-first.
  for (const cand of candidates) {
    const full = `${dir}${cand}`;
    if (set.has(full)) return full;
  }

  // 2. Truncated-prefix pass. Collect the same-directory .json members once.
  const jsonsInDir: string[] = [];
  for (const m of set) {
    if (!m.toLowerCase().endsWith(".json")) continue;
    if (dirOf(m) !== dir) continue;
    jsonsInDir.push(m);
  }
  if (jsonsInDir.length === 0) return null;

  // Truncated candidate bases: drop the trailing ".json", clip to the cap.
  const truncatedTargets = candidates.map((c) => {
    const baseNoJson = c.endsWith(".json") ? c.slice(0, -".json".length) : c;
    return baseNoJson.slice(0, TAKEOUT_NAME_CAP);
  });

  for (const jsonMember of jsonsInDir) {
    const jsonBaseRaw = jsonMember.slice(dir.length); // strip dir
    const jsonBase = jsonBaseRaw.endsWith(".json")
      ? jsonBaseRaw.slice(0, -".json".length)
      : jsonBaseRaw;
    const jsonBaseClipped = jsonBase.slice(0, TAKEOUT_NAME_CAP);
    for (const target of truncatedTargets) {
      // The sidecar base is Google's truncation of the candidate base, so the
      // two clipped-to-cap forms should be equal (case d) — or one is a prefix
      // of the other when the cap lands mid-word (case a).
      if (
        jsonBaseClipped === target ||
        target.startsWith(jsonBaseClipped) ||
        jsonBaseClipped.startsWith(target)
      ) {
        return jsonMember;
      }
    }
  }

  return null;
}

/** A media member name we consider sidecar-eligible (not itself a .json). */
export function isSidecarName(name: string): boolean {
  return name.toLowerCase().endsWith(".json");
}

/**
 * Parse a sidecar's JSON bytes into a normalised `metadataOverride`. Tolerant
 * of the several shapes Google has shipped over the years; never throws on
 * malformed JSON (returns an empty object so the caller falls back to EXIF).
 *
 *   - photoTakenTime.timestamp (epoch *seconds*, as a string) -> capturedAt.
 *     Falls back to creationTime.timestamp when photoTakenTime is absent.
 *   - geoData.{latitude,longitude} (and the legacy geoDataExif) -> lat/lng,
 *     dropping the 0/0 placeholder Google writes for geo-less photos.
 *   - description -> trimmed; blank dropped.
 */
export function parseSidecar(jsonBytes: Buffer | string): SidecarMetadata {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(
      typeof jsonBytes === "string" ? jsonBytes : jsonBytes.toString("utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }

  const out: SidecarMetadata = {};

  // --- capturedAt -----------------------------------------------------------
  const takenTs =
    readTimestamp(obj.photoTakenTime) ?? readTimestamp(obj.creationTime);
  if (takenTs != null) {
    // Epoch seconds -> ms. Guard against an already-ms value just in case.
    const ms = takenTs < 1e12 ? takenTs * 1000 : takenTs;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) out.capturedAt = d;
  }

  // --- geo ------------------------------------------------------------------
  const geo = readGeo(obj.geoData) ?? readGeo(obj.geoDataExif);
  if (geo) {
    out.latitude = geo.lat;
    out.longitude = geo.lng;
  }

  // --- description ----------------------------------------------------------
  if (typeof obj.description === "string") {
    const trimmed = obj.description.trim();
    if (trimmed.length > 0) out.description = trimmed;
  }

  return out;
}

/** Read a `{ timestamp: "1614556800" }`-shaped node -> number (seconds). */
function readTimestamp(node: unknown): number | null {
  if (typeof node !== "object" || node === null) return null;
  const ts = (node as { timestamp?: unknown }).timestamp;
  if (typeof ts === "string" && ts.trim() !== "") {
    const n = Number(ts);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  return null;
}

/** Read a `{ latitude, longitude }` node, dropping the 0/0 placeholder. */
function readGeo(node: unknown): { lat: number; lng: number } | null {
  if (typeof node !== "object" || node === null) return null;
  const g = node as { latitude?: unknown; longitude?: unknown };
  const lat = typeof g.latitude === "number" ? g.latitude : Number(g.latitude);
  const lng =
    typeof g.longitude === "number" ? g.longitude : Number(g.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Google writes 0/0 for photos with no location — treat as "no geo".
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}
