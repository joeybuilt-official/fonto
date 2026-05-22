# RAW and HEIC Format Support

Reference table for the decoder dispatcher in `lib/processing/decode.ts`.
This is the canonical source-of-truth for which formats Fonto can render
thumbnails for, which decoder backend handles each, and which test fixtures
have been verified (or still need verifying — most of them, as of this
file's creation).

## Decoder dispatch table

| Mime | Common extensions | Backend | EXIF backend | Verified? |
|---|---|---|---|---|
| `image/jpeg` | `.jpg`, `.jpeg` | sharp (passthrough) | exifr | yes (Phase 0) |
| `image/png` | `.png` | sharp (passthrough) | exifr | yes (Phase 0) |
| `image/webp` | `.webp` | sharp (passthrough) | exifr | yes (Phase 0) |
| `image/gif` | `.gif` | sharp (passthrough) | exifr | yes (Phase 0) |
| `image/tiff` | `.tif`, `.tiff` | sharp (passthrough) | exifr | yes (Phase 0) |
| `image/avif` | `.avif` | sharp (libheif) | exifr | TODO: verify against sample files |
| `image/heic` | `.heic` | sharp (libheif), fallback `heif-convert` | exifr | TODO: verify against sample files |
| `image/heif` | `.heif`, `.hif` | sharp (libheif), fallback `heif-convert` | exifr | TODO: verify against sample files |
| `image/heic-sequence` | `.heic` | sharp (libheif), fallback `heif-convert` | exifr | TODO: verify against sample files |
| `image/x-canon-cr2` | `.cr2` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-canon-cr3` | `.cr3` | `dcraw_emu -e` (embedded JPEG) | exiftool | TODO: verify against sample files |
| `image/x-adobe-dng` | `.dng` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-sony-arw` | `.arw`, `.srf`, `.sr2` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-nikon-nef` | `.nef` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-nikon-nrw` | `.nrw` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-panasonic-rw2` | `.rw2`, `.raw` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-olympus-orf` | `.orf` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-fuji-raf` | `.raf` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-pentax-pef` | `.pef` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-samsung-srw` | `.srw` | `dcraw_emu -e` (embedded JPEG) | exifr | TODO: verify against sample files |
| `image/x-sigma-x3f` | `.x3f` | `dcraw_emu -w` (demosaic — no embedded JPEG) | exiftool | TODO: verify against sample files |

## Decoder fallback chain (RAW)

1. **Embedded JPEG** — `dcraw_emu -e -c <file>` extracts the camera-written
   preview from the RAW container. Most consumer cameras embed a
   full-resolution JPEG; this is what the LCD displays. Fast (~50ms) and
   high-quality.
2. **Demosaic to TIFF** — `dcraw_emu -w -c <file>` falls back if no
   embedded JPEG is present (or extraction failed). Demosaics the raw
   sensor data using a fixed white-balance and writes a 16-bit linear TIFF.
   Slower (~1-3s per shot) but works for any LibRaw-supported camera.

Per-file time budget is `RAW_DECODE_TIMEOUT_MS` (default 30s). Exceeding
the budget kills the subprocess and surfaces the failure to the
thumbnail generator — the asset is recorded as unprocessable rather than
blocking the worker.

## Mime detection (uploads with bad Content-Type)

`lib/mime.ts:detectMime()` runs at upload time when the client supplied
`application/octet-stream`, an empty string, or no Content-Type at all
(Finder drag-drop on macOS does this for HEIC; many file managers do it
for camera RAW). Strategy:

1. Trust the client mime if it's specific.
2. Otherwise sniff with `file-type` (reads first ~4KiB).
3. Fall back to filename extension for RAW and HEIC mime mapping.
4. Last resort: keep `application/octet-stream` and let the decoder
   throw an "unsupported mime" error downstream.

## How to verify a new fixture

1. Drop a sample file into `test-fixtures/` (gitignored — never commit
   personal photos).
2. Run the upload against a local worker:
   ```bash
   curl -F "file=@test-fixtures/sample.cr3" \
        -F "workspaceId=<your-ws>" \
        http://localhost:3500/api/v1/assets
   ```
3. Check the worker logs for `sourceFormat=cr3-embedded-jpeg` and the
   resulting thumbnail in R2.
4. Update the "Verified?" column above with the camera model and the date
   verified.
