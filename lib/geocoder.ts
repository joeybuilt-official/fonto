// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.2 — offline reverse geocoder backed by the GeoNames `cities500`
// dataset (every populated place with ≥500 residents, ~190k entries, ~9 MB
// uncompressed TSV).
//
// The dataset is loaded once on first call, parsed into a flat array of
// `{ name, country, lat, lon }`, and indexed with KDBush so a nearest-
// neighbour lookup is O(log n) over a bbox-filtered candidate set. The
// in-memory footprint is ~30 MB; we keep it cached for the lifetime of the
// process (Next.js dev server, BullMQ worker, backfill script — all reuse).
//
// The dataset isn't committed in full — the bundled `data/geonames/cities500.tsv`
// is a placeholder containing the first ~50 rows so the code path runs in CI
// and dev. The production deploy step materialises the real file via
// `pnpm tsx scripts/fetch-geonames.ts`. If the file is missing or empty,
// `nearestPlace()` returns null rather than throwing.
//
// We DO NOT make HTTP calls at lookup time — privacy + offline-first.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import KDBush from "kdbush";

// Cap distance for a "useful" place name. Beyond this we return null rather
// than label, say, a mid-Atlantic ocean photo as "Reykjavík, IS, 980 km".
const MAX_MATCH_DISTANCE_KM = 200;

const EARTH_RADIUS_KM = 6371;

export interface NearestPlace {
  name: string;
  country: string;
  distanceKm: number;
}

interface GeoEntry {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

interface GeoIndex {
  entries: GeoEntry[];
  // KDBush is built over (lon, lat) — we keep the 2D points in degree-space
  // and use a bbox prefilter for candidate selection (haversine on the small
  // candidate set is cheap; doing geographic search across all 190k entries
  // brute-force is wasteful).
  index: KDBush;
}

let cached: GeoIndex | null | "missing" = null;
let loadingPromise: Promise<GeoIndex | null> | null = null;

/**
 * GeoNames `cities500.txt` is a tab-separated file with columns:
 *   0 geonameid       1 name             2 asciiname     3 alternatenames
 *   4 latitude        5 longitude        6 feature class 7 feature code
 *   8 country code    9 cc2             10 admin1 code  11 admin2 code
 *   12 admin3 code   13 admin4 code     14 population   15 elevation
 *   16 dem           17 timezone        18 modification date
 *
 * See https://download.geonames.org/export/dump/readme.txt for the full schema.
 * We only need name (col 1), latitude (col 4), longitude (col 5), and country
 * code (col 8).
 */
function parseTsv(raw: string): GeoEntry[] {
  const entries: GeoEntry[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 9) continue;
    const name = cols[1];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const country = cols[8];
    if (!name || !country) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    entries.push({ name, country, lat, lon });
  }
  return entries;
}

function geonamesPath(): string {
  // Resolved relative to the project root regardless of cwd (next dev, worker
  // bin, tsx scripts — all run from different working directories).
  return path.join(process.cwd(), "data", "geonames", "cities500.tsv");
}

async function buildIndex(): Promise<GeoIndex | null> {
  const filePath = geonamesPath();
  if (!existsSync(filePath)) {
    console.warn(
      `[fonto-geocoder] dataset missing at ${filePath} — reverse geocoding disabled. ` +
        `Run \`pnpm tsx scripts/fetch-geonames.ts\` to populate it.`
    );
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  const entries = parseTsv(raw);
  if (entries.length === 0) {
    console.warn(`[fonto-geocoder] dataset at ${filePath} parsed to zero entries.`);
    return null;
  }
  const index = new KDBush(entries.length);
  for (const e of entries) {
    index.add(e.lon, e.lat);
  }
  index.finish();
  console.log(`[fonto-geocoder] indexed ${entries.length} cities from ${filePath}`);
  return { entries, index };
}

/**
 * Load (and cache) the geocoder index. Returns null on missing-or-empty
 * dataset; callers degrade silently in that case. Concurrent calls share a
 * single load promise.
 */
async function getIndex(): Promise<GeoIndex | null> {
  if (cached === "missing") return null;
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const built = await buildIndex();
      if (built) {
        cached = built;
        return built;
      }
      cached = "missing";
      return null;
    } catch (err) {
      console.warn("[fonto-geocoder] failed to load dataset:", err);
      cached = "missing";
      return null;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/** Reset the cached index. Test/dev hook; never call from production code. */
export function _resetGeocoderCache(): void {
  cached = null;
  loadingPromise = null;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two WGS-84 points in kilometres. Haversine
 * formula — accurate to ~0.5% across the full sphere, which is more than
 * enough for "is this photo near a city" labelling.
 */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Degree-space bbox approximation for a `radiusKm` neighbourhood around the
 * query point. Latitude degrees are constant (111 km/deg); longitude degrees
 * shrink with cos(lat) so we widen the lon bound near the poles. This is
 * deliberately conservative — false positives are fine because we re-test
 * each candidate with haversine.
 */
function bboxForRadius(
  lat: number,
  lon: number,
  radiusKm: number
): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  const latDelta = radiusKm / 111;
  const cosLat = Math.max(Math.cos(toRad(lat)), 0.01); // avoid div-by-0 at poles
  const lonDelta = radiusKm / (111 * cosLat);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

/**
 * Reverse-geocode a coordinate pair to the nearest populated place (≥500
 * residents). Returns null when:
 *   - the dataset isn't loaded (placeholder or missing file),
 *   - the input is malformed (NaN, out of WGS-84 range),
 *   - no city sits within `MAX_MATCH_DISTANCE_KM` of the query point.
 *
 * Lookup cost: KDBush bbox query (O(log n)) + a haversine scan over the
 * filtered candidates (typically <100 entries for a continental query).
 */
export async function nearestPlace(
  lat: number,
  lon: number
): Promise<NearestPlace | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const idx = await getIndex();
  if (!idx) return null;

  const { minLat, maxLat, minLon, maxLon } = bboxForRadius(
    lat,
    lon,
    MAX_MATCH_DISTANCE_KM
  );
  const candidateIds = idx.index.range(minLon, minLat, maxLon, maxLat);
  if (candidateIds.length === 0) return null;

  let bestIdx = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of candidateIds) {
    const e = idx.entries[id];
    const d = haversineKm(lat, lon, e.lat, e.lon);
    if (d < bestDistance) {
      bestDistance = d;
      bestIdx = id;
    }
  }
  if (bestIdx < 0 || bestDistance > MAX_MATCH_DISTANCE_KM) return null;
  const e = idx.entries[bestIdx];
  return { name: e.name, country: e.country, distanceKm: bestDistance };
}

/**
 * Format a NearestPlace for storage in `assets.place_name`. Mirrors the
 * "City, CC" shape the timeline + map tooltip both render.
 */
export function formatPlaceName(p: NearestPlace): string {
  return `${p.name}, ${p.country}`;
}
