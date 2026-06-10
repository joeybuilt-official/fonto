# Fonto KIND categorization — audit + remediation spec

Audited 2026-06-10 against live myfonto.com (browser grids + SQL + code).

## Findings
Live distribution: moment 10,269 · **screenshot 5,392** · document 2,143 · video 412 · graphics 280 · null 21.

Root causes in `lib/classify/kind.ts` `deriveKind` (+ `lib/processing/classifyHelpers.ts`):

1. **Rule 9 default-to-screenshot** (`kind.ts:202`): any `image/*` without camera evidence → `screenshot`. Every EXIF-stripped photo (downloaded / messaging / social / edited / recovered) lands here. Largest false-positive source.
2. **Aspect-ratio screenshot heuristic** (`classifyHelpers.ts:30-39`, `isScreenshot`): a tall image (AR 0.40–0.66) or 16:9-ish (1.55–1.85) is flagged `screenshot` on shape alone. EXIF-stripped portrait photos → screenshot.
3. **OCR-document (rule 5) runs before screenshot (rule 7)** (`kind.ts:168` before `:187`): text-heavy screenshots (code editors, web listings, iMessage) hit `ocrLooksLikePaperDocument` keyword/money-density → `document`. Browser audit of the Documents grid confirmed: real receipts mixed with code/web/chat screenshots + text-bearing object photos.

## Operator policy (2026-06-10)
Trust the **content** (vision classification) first. An image with no screenshot/document content signal and no EXIF — including recovered images — is just a photo → **moment**. Hybrid: model decides; moment is the floor. Don't let shape (aspect ratio) or EXIF-absence alone force screenshot.

## Remediation spec (deriveKind new precedence)
1. video mime → video
2. document mime → document
3. classification ∈ DOCUMENT_CLASSIFICATIONS → document (trusted vision; beats EXIF — keep)
4. classification/sub == "whiteboard" → document (trusted vision)
5. classification == "screenshot" → screenshot (trusted vision)
6. screenshot-by-FILENAME (`SCREENSHOT_NAME_RE`) AND !looksLikeCameraPhoto → screenshot  ← moved ABOVE OCR-doc
7. ocrLooksLikePaperDocument → document (now only non-screenshot text images)
8. isWhiteboardCapture (OCR heuristic) → document
9. graphics classification (no camera, isPhotoOfArt guard) → graphics
10. looksLikeCameraPhoto → moment
11. image/* → **moment** (was screenshot)
12. unknown → moment

Key changes: (a) screenshot-by-filename + classification=screenshot move ahead of the OCR-document heuristic so content screenshots aren't documents; (b) the **aspect-ratio-only** signal no longer forces screenshot (shape ≠ content) — drop it from the kind decision AND from any processAsset override that sets classification='screenshot' when the model already classified the image as a photo/scene; (c) rule-11 default → moment.

Preserve: phone-photo-of-receipt → document (camera EXIF + rule 3 vision-document or rule 7 OCR-doc still applies because those have camera evidence, so the screenshot branches won't claim them).

## Rollout
Re-derive kind from STORED classification/exif/ocr (no model re-inference) via `scripts/classify-only-rerun.ts --scope=all-images` after deploying the new `deriveKind`. Then re-verify the Screenshots / Documents / Moments grids in the browser. Note: an import was actively processing (~1455 items) during the audit — let it settle or scope the rerun to avoid racing in-flight rows.
