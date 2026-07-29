// SPDX-License-Identifier: MIT
// Shared EXIF filter predicates. Consumed by the three asset-query surfaces
// that accept the same query params: /api/v1/search, /api/v1/assets, and
// smart-collection evaluation (/api/v1/smart-collections/:id/assets). Keeping
// the parsing in one place stops the three routes from drifting.
//
// Columns are the dedicated, indexed EXIF fields on fonto.assets
// (camera_make/model, lens_model, f_number, iso, focal_length). Free-text
// vendor strings vary wildly, so camera/lens match case-insensitive contains;
// the numeric fields match exactly (values come from facet dropdowns).
import { schema } from "@/lib/db";
import { eq, ilike, type SQL } from "drizzle-orm";

export const EXIF_FILTER_KEYS = [
  "cameraMake",
  "cameraModel",
  "lensModel",
  "iso",
  "fNumber",
  "focalLength",
] as const;

export function exifFilterConditions(searchParams: URLSearchParams): SQL[] {
  const conds: SQL[] = [];

  const cameraMake = searchParams.get("cameraMake")?.trim();
  if (cameraMake) conds.push(ilike(schema.assets.cameraMake, `%${cameraMake}%`));

  const cameraModel = searchParams.get("cameraModel")?.trim();
  if (cameraModel) conds.push(ilike(schema.assets.cameraModel, `%${cameraModel}%`));

  const lensModel = searchParams.get("lensModel")?.trim();
  if (lensModel) conds.push(ilike(schema.assets.lensModel, `%${lensModel}%`));

  const isoRaw = searchParams.get("iso");
  if (isoRaw != null && isoRaw.trim() !== "") {
    const iso = Number.parseInt(isoRaw, 10);
    if (Number.isInteger(iso)) conds.push(eq(schema.assets.iso, iso));
  }

  const fRaw = searchParams.get("fNumber");
  if (fRaw != null && fRaw.trim() !== "") {
    const f = Number.parseFloat(fRaw);
    if (Number.isFinite(f)) conds.push(eq(schema.assets.fNumber, f));
  }

  const focalRaw = searchParams.get("focalLength");
  if (focalRaw != null && focalRaw.trim() !== "") {
    const focal = Number.parseFloat(focalRaw);
    if (Number.isFinite(focal)) conds.push(eq(schema.assets.focalLength, focal));
  }

  return conds;
}
