# Categorization v2 — catch screenshots/graphics hiding in Moments

Follow-up to categorization-audit.md (v1 deterministic fix, shipped a6dc813).

## Audit result (2026-06-10, browser + DB)
v1 reduced screenshots 5392→2062 and cleaned Documents. Remaining problem: screenshots/graphics CLIP mislabeled `photo` now sit in Moments.

- Suspect bucket: `kind='moment' AND classification='photo' AND no camera EXIF` ≈ **3,148** images.
- Visual audit (thumbnail montages of random / square / phone-portrait subsets): the bucket is MOSTLY real photos (selfies, cropped social photos, EXIF-stripped camera shots) with a minority of graphics/screenshots (e.g. an Invicta watch ad, occasional UI/text tiles).
- **Deterministic geometry can't separate them** — selfies are 9:16 (same as phone screenshots); real photos are cropped square (same as graphics). Proven by montages. This is why v1 correctly dropped the aspect-ratio screenshot signal.
- classify_method on the suspects: **2,782 null + 58 clip** = ~2,840 NEVER judged by the vision-LLM; 347 were (`llm-fallback`) and it said photo.

**Conclusion:** only the accurate vision-LLM (content understanding) can fix this. ~2,840 images need a real vision pass.

## The two prompt surfaces ("tune prompt then run")
1. **Fonto TAXONOMY CLIP anchors** — `lib/classify/taxonomy.ts`. Already has screenshot (chat/webpage/app-ui/error-dialog/receipt-screenshot) + graphics (logo/meme/art/sticker/wallpaper/diagram/...) top categories with prompts. CLIP cosine (`lib/classify/classify.ts`) compares `clip_vec` to these. Re-running these is FREE (classify-only-rerun, ~92s, no GPU) but limited — the suspects already scored closest to the `photo` anchor.
2. **Plexo Core vision prompt** — the real lever. Fonto's `lib/plexo-analyze.ts` only POSTs `{imageUrl, mimeType, filename, hints}` to Plexo `/api/v1/vision/analyze-image`; the classification PROMPT + label logic live in **Plexo Core** (`plexo-api` on the host, repo joeybuilt-official/plexo). Tuning it to emphasize screenshot/graphic/meme/logo-vs-photo is a Plexo-side edit + redeploy.

## Plan
1. Tune Plexo Core's analyze-image prompt (screenshot/graphic/meme/logo distinction) + optionally tighten Fonto's `photo` anchor. Deploy Plexo.
2. Build a Fonto runner: force `analyzeImageUnified` (vision-LLM) on the suspect bucket (resumable, rate-limited; ~11/min per the fonto-worker throughput → multi-hour for ~2,840). Re-derive kind from the new classification (deriveKind already correct from v1).
3. Run as a background job; monitor; re-verify the Moments/Screenshots/Graphics lenses via thumbnail montages + DB distribution.

## Entry points
- Suspect query: `kind='moment' AND classification='photo' AND classify_method IS NULL/clip AND no camera EXIF` (workspace 9d4a122f-…).
- Vision call: `lib/plexo-analyze.ts` `analyzeImageUnified`. Reclassify-from-clip_vec script: `scripts/classify-only-rerun.ts` (CLIP path; would need a `--force-llm` mode or a new script for the vision path).
- Thumbnail montage harness: `/tmp/montage.mjs` (fetch /api/v1/assets/urls variant=thumb → HTML grid → screenshot).
- Verify distribution: `SELECT kind,count(*) ... GROUP BY kind`.

## Cost/runtime note
~2,840 vision-LLM calls on the host GPU (Plexo). Multi-hour background job + inference cost. Vision models aren't perfect either (the 347 already-vision-judged "photo" prove a ceiling) — expect "much better," not literally 100%.
