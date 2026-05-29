# Fonto parity checklist

Derived from `plan.md`. Tick boxes as items complete. This file is the
durable source of truth for in-flight execution; do not duplicate to
TaskCreate while in phased-plan flow.

## Phase 6.2a — Mobile asset detail + share sheet
- [x] AssetDetailScreen w/ PhotoView (pinch-zoom)
- [x] Swipe between assets (PageView over current list)
- [x] Action bar — favorite, trash, share
- [x] Favorite/trash roundtrip via existing /api/v1/assets/:id PATCH
- [x] Share sheet via share_plus package — emits /share/<token> URL
- [x] Wire tile tap from home_screen + search_screen
- [x] Commit + push

## Phase 6.2b — Mobile background upload queue
- [x] sqflite-backed upload queue table
- [x] Enqueue on capture/pick instead of immediate upload
- [x] Workmanager (Android) periodic task — drain queue
- [x] BGTaskScheduler (iOS) — register + drain on opportunity (via workmanager plugin)
- [x] sha256 dedupe (UNIQUE on sha256, INSERT OR IGNORE)
- [x] Retry — max 5 attempts; Workmanager native backoff on `return false`
- [x] "Queued: N" badge in home_screen app bar
- [ ] Background test — DEFERRED to operator (needs real device + sleeping screen)
- [x] Commit + push

## Phase 6.2c — Mobile tests + CI ⚠
- [x] OPERATOR GATE — C6 = **in-repo** (mobile/ios, mobile/android shells live alongside Flutter source, confirmed 2026-05-25)
- [x] OPERATOR GATE — C1 = **first_unlock** (scaffold default stands; operator is Android-only, iOS Keychain class is not blocking — confirmed 2026-05-25)
- [x] OPERATOR GATE — Android keystore generated on the host (fonto-upload.jks, expires 2053-10-11, creds at /data/_secrets/fonto-keystore/creds.txt) — **OPERATOR: upload .jks to Codemagic Team → Code Signing Identities → Android keystores, reference name "fonto_upload_keystore"**
- [ ] OPERATOR GATE — iOS signing certs + provisioning profiles uploaded to Codemagic (DEFERRED — operator is Android-only; build iOS-CI later if/when iOS distribution becomes relevant)
- [x] Widget tests — login screen (2 tests), home grid (loading state), search screen (input field), asset detail (filename render)
- [x] Integration test — upload_queue_test.dart stub (skipped; note: add sqflite_ffi to dev_deps for on-host run)
- [ ] codemagic.yaml — iOS workflow (DEFERRED — operator is Android-only)
- [x] codemagic.yaml — Android workflow (build + test + bundle, triggers push+PR to main, emails user@example.com)
- [x] Android project shell — mobile/android/ scaffold (build.gradle, manifest, MainActivity.kt, signingConfigs via CM_* env vars)
- [x] Codemagic repo connected — operator connected GitHub + fonto repo to Codemagic 2026-05-28
- [x] Codemagic signing env vars set — CM_KEYSTORE/CM_KEY_ALIAS/CM_STORE_PASSWORD/CM_KEY_PASSWORD in android-signing group (via API 2026-05-28)
- [x] First build (#10) succeeded — signed APK + AAB produced (2026-05-28). Required webhook install + 9 latent build fixes: convert import, login test, declarative Gradle plugins, Gradle 8.11.1/AGP 8.9.1/Kotlin 2.1, compileSdk 36, res/ (icon+theme)+NDK 28.2, workmanager 0.9.0, isInDebugMode drop, JVM target 17
- [x] mobile/CI.md runbook — keystore rotation (2053 expiry), build failure triage, deferred iOS steps
- [x] Commit + push

## Phase 7a — Comments + activity feed
- [x] OPERATOR GATE — C4 = **daily digest** (operator confirmed 2026-05-25, ADR 0003 default stands)
- [x] Schema: `comments` table (assetId, userId, body, parentId nullable, createdAt)
- [x] Schema: `activity_events` table (workspaceId, kind, payload, createdAt)
- [x] Hand-written migration under drizzle/migrations/ (0027_comments_activity.sql)
- [x] POST /api/v1/assets/:id/comments
- [x] GET /api/v1/assets/:id/comments (threaded)
- [x] DELETE /api/v1/assets/:id/comments/:commentId (own or workspace-editor)
- [x] GET /api/v1/workspace/activity (cursor-paginated)
- [x] Web UI — comments drawer in asset detail (photo-lightbox 'c' shortcut)
- [x] Web UI — /app/activity page
- [x] Per-share mute setting (notification_mutes table + /api/v1/notifications/mutes routes)
- [x] Daily-digest worker job (BullMQ scheduled, maintenance queue, DIGEST_INTERVAL_MS default 24h)
- [x] Digest email template (stub matching invitations/email.ts pattern; transport deferred to Phase 7.3)
- [x] Commit + push (b077f29)

## Phase 7b — Cross-workspace sharing + new roles ⚠
- [x] OPERATOR GATE — C5 = **reference** (operator confirmed 2026-05-25; shared rows point at source workspace's R2 object, no duplication)
- [x] Migration — extend role CHECK to add `commenter` + `contributor` (0028; covers workspace_memberships + workspace_invitations)
- [x] Schema: `shared_assets` table per chosen model (reference; partial unique on (asset, target) WHERE revoked_at IS NULL)
- [x] requireWorkspaceAccessOrResponse — teach about new roles (WorkspaceRole + ROLE_RANK extended in lib/authz.ts)
- [x] Audit every callsite of requireWorkspaceAccessOrResponse — Explore subagent; 4 relaxed (assets POST + init + complete → contributor; comments POST → commenter); 39 stay put
- [x] POST /api/v1/assets/:id/share/workspaces — share to another workspace (path differs from plan to avoid public-share-LINK collision)
- [x] DELETE /api/v1/assets/:id/share/workspaces/:targetWorkspaceId — revoke (soft, sets revoked_at)
- [x] Web UI — "Share with workspace" action in asset detail (AssetWorkspaceShare popover in lightbox toolbar; hidden for shared-in assets)
- [x] Visibility — shared assets appear in target workspace's listings with badge (/app/shared page + Share2 badge on PhotoCard reading asset.sharedFrom; /api/v1/assets/:id/url extended via lib/assets/access.ts to serve shared previews)
- [x] Commit + push (f63c0b2)

## Phase 8a — Video probe + thumbnail extraction
- [x] OPERATOR GATE — taking ADR 0001 default (CPU-only ffmpeg) — operator can object at review
- [x] Dockerfile.worker — install ffmpeg (provides ffmpeg+ffprobe) — both deps and runtime stages
- [x] lib/processing/probeVideo.ts — ffprobe wrapper
- [x] lib/processing/extractVideoThumbnail.ts — ffmpeg seek-before-input keyframe-aligned
- [x] generateThumbnails dispatcher — video branch (probe → extract → encode via existing sharp pipeline)
- [x] processAsset — video classification = "video" w/o Plexo round-trip
- [x] Schema + migration 0026: duration_seconds, video_codec, video_width, video_height
- [ ] Backfill script — DEFERRED (no existing videos in prod; reprocess endpoint covers ad-hoc)
- [x] Grid renderer — play icon overlay + duration chip on video tiles
- [ ] Asset detail metadata pane — DEFERRED to 8b (lightbox refactor lands w/ player)
- [x] Commit + push

## Phase 8b — HLS transcode + player UI ⚠
- [x] OPERATOR GATE — C7 = **ladder day-one** (operator confirmed 2026-05-25; 360p/720p/1080p H.264 renditions per video, hls.js picks based on bandwidth — overrides plan.md's single-bitrate scope)
- [x] lib/processing/transcodeVideoHls.ts — 3-rendition H.264 HLS ladder (360p/720p/1080p, single ffmpeg invocation w/ split filter); master.m3u8 hand-assembled
- [x] On-demand trigger — GET /api/v1/assets/:id/hls flips hls_state=transcoding + enqueues VideoHlsTranscode job; idempotent
- [x] R2 storage layout — fonto/{ws}/{asset}/hls/{master.m3u8, 360p.m3u8, 360p_NNN.ts, 720p…, 1080p…, sprite.jpg}
- [x] GET /api/v1/assets/:id/hls — returns same-origin playback URL through auth-gated proxy (not direct R2 presigned, so segment access stays gated)
- [x] Sprite generator — 10s-interval (capped at 200 tiles), sharp-composited grid; sprite_meta { interval, columns, rows, tileWidth, tileHeight, totalFrames } persisted
- [x] Web UI — VideoPlayer w/ hls.js (native HLS fallback for Safari/iOS); auto-attaches in PhotoLightbox when mimeType starts with video/
- [x] Web UI — hover-scrub sprite preview tile above the scrubber band
- [x] Cleanup — purge-trashed cron extended to enumerate + delete every key under fonto/{ws}/{id}/hls/ via ListObjectsV2 + DeleteObjects
- [x] Commit + push (e8b70c2)

## Phase 9a — Dashboards + alerts as code
- [x] ops/grafana/dashboards/overview.json
- [x] ops/grafana/dashboards/processing.json
- [x] ops/grafana/dashboards/queue-depth.json
- [x] ops/grafana/dashboards/api-latency.json
- [x] ops/grafana/provisioning/{datasources,dashboards}/*.yaml — auto-load on boot
- [x] ops/alerts/rules.yml — queue depth, latency, error rate, stall
- [x] Alertmanager config — Discord (page) + email (warn + page) routing
- [ ] Compose service — DEFERRED to operator (compose file lives outside git; ops/README.md has the snippet to paste)
- [ ] Pull power test — DEFERRED to operator (needs the compose services up first)
- [x] Commit + push

## Phase 9b — Worker autoscale ⚠
- [x] OPERATOR GATE — C2 = **queue depth (Valkey)** (operator confirmed 2026-05-25; scale on BullMQ pending-job count, not CPU)
- [x] ops/autoscaler/ container — Node reconciler via tsx (shares bullmq/ioredis pins w/ worker)
- [x] Signal reader — BullMQ Queue.getJobCounts('wait','delayed') across throughput queues (asset-processing, thumbnails, clip-embedding, face-detect, ocr)
- [x] Compose API call — `docker compose -f $COMPOSE_FILE up -d --no-recreate --scale fonto-worker=N fonto-worker` via spawned docker-cli
- [x] Floor 1 / ceiling 4 / 60s dampening (all env-overridable)
- [x] Dry-run flag — AUTOSCALER_DRY_RUN=1 logs `would_scale` decisions without invoking compose
- [x] Enqueue-100-jobs test — `pnpm autoscaler:enqueue [N|drain]` script + verification recipe documented in ops/autoscaler/README.md (live compose-wired test DEFERRED to operator — needs the autoscaler container actually running)
- [x] Commit + push (c988536)

## Phase 6.3 — Google Play distribution + Codemagic publishing ⚠
- [ ] OPERATOR GATE — Create Google Play app listing (package: com.joeybuilt.fonto) in Play Console
- [ ] OPERATOR GATE — Create Google Cloud service account with releases.manager permission; download JSON
- [ ] OPERATOR GATE — Add service account to Codemagic (Team settings → Google Play)
- [ ] OPERATOR GATE — Note Play-managed signing cert SHA-256 after first publish (needed for 6.5 assetlinks.json)
- [x] DECISION C8 = **Option A** (path filter on mobile/** — operator confirmed 2026-05-28)
- [x] codemagic.yaml — changeset path filter (trigger only on mobile/**)
- [ ] codemagic.yaml — add publishing.google_play stanza (internal track, draft → review)
- [ ] Commit + push + first internal track release

## Phase 6.4 — FCM push notifications ⚠
- [x] DECISION C10 = **Option A** (FCM real-time for comments+shares, daily digest for summaries — operator confirmed 2026-05-28)
- [ ] OPERATOR GATE — Create Firebase project; add Android app (com.joeybuilt.fonto); download google-services.json
- [ ] OPERATOR GATE — Base64-encode google-services.json; add as GOOGLE_SERVICES_JSON secure env var in Codemagic
- [ ] OPERATOR GATE — Add FCM_SERVER_KEY to joeybuilt VPS env (service/.env or equivalent)
- [x] Schema + migration 0032: fonto.push_tokens (userId, deviceId, token, platform, created/updatedAt; UNIQUE userId+deviceId)
- [x] POST /api/v1/notifications/push-token — upsert by (userId, deviceId) via onConflictDoUpdate; platform ∈ android|ios|web
- [x] DELETE /api/v1/notifications/push-token — deregister by deviceId (idempotent)
- [x] Backend notification dispatch — lib/notifications/push.ts (guarded FCM legacy sender, no-op w/o FCM_SERVER_KEY; prunes dead tokens) + notifyWorkspaceMembers; wired fire-and-forget into comments POST (workspace minus actor — no per-asset owner in model) + share/workspaces POST (target workspace minus sharer). NOTE: legacy FCM HTTP — may need HTTP v1 swap at integration. DEPLOYED to NAS 2026-05-29 (commit ddd5f7a): migration 0032 applied (backup fonto-pushd-pre-0032-*), fonto rebuilt+recreated, push-token endpoint live (401 unauth); dispatch stays no-op until FCM_SERVER_KEY set.
- [ ] Mobile: add firebase_messaging to pubspec.yaml
- [ ] Mobile: decode + write google-services.json from GOOGLE_SERVICES_JSON env var in Codemagic build script
- [ ] Mobile: request notification permission on first launch
- [~] Mobile: register token via POST /api/v1/notifications/push-token on auth — FontoClient.registerPushToken/deregisterPushToken added (HTTP-only, no firebase dep, build-safe). Call site (on auth) + deviceId/token source pending firebase_messaging (Firebase gate). NOT YET BUILT (no tag cut — pairs with the firebase wiring).
- [ ] Mobile: notification tap handler — route to home?lb=<assetId> or /share/<token>
- [ ] Commit + push

## Phase 6.5 — Android App Links + in-app deep link routing
- [x] DECISION C9 = **Option A** (App Links only, no custom scheme; Android 5 → browser — operator confirmed 2026-05-28)
- [x] Backend: GET /.well-known/assetlinks.json route in Next.js (env-var fingerprint, not hardcoded)
- [x] Backend: GET /api/v1/shares/resolve?slug=<slug> — public endpoint for mobile share resolution
- [x] ASSETLINKS_SHA256 env var set on fonto (NAS compose, upload key fingerprint from ADR 0006; SWAP to Play key post-6.3) — compose backup at /data/_secrets/docker-compose-pre-assetlinks-20260528T195026Z.yml
- [x] Android: add intent-filter in AndroidManifest.xml for https://myfonto.com (autoVerify=true)
- [x] Mobile: add app_links + url_launcher packages to pubspec.yaml
- [x] Mobile: handle incoming URI in main.dart — /app/library?lb=<id> → open detail, /share/<token> → resolve + open detail; password-protected + collection shares fall back to url_launcher
- [x] Backend deployed + verified: /.well-known/assetlinks.json → 200/application/json, Google Digital Asset Links verifier parses statement cleanly (2026-05-28)
- [x] codemagic.yaml — APK artifact + single-shell keystore signing fix (pushed; APK at flutter-apk/app-release.apk, upload-key-signed)
- [ ] Smoke test: tap https://myfonto.com/share/<token> on Android 6+ device → app opens to asset (needs sideloaded APK)
- [ ] Commit + push + deploy assetlinks.json route — DONE for backend (9b48bcd); mobile artifact ships via Codemagic

## Bug fixes (found in use)
- [x] Asset trash returned 500 — [id] GET/PATCH serialized raw rows with bigint seq/phash; now use serializeAsset() (deployed to live 2026-05-28)
- [x] Mobile: confirmation dialog before trash (was unguarded one-tap)

## Phase 6.6 — Mobile nav parity (mirror web bottom-nav) ⚠
- [x] DECISION — nav parity before document scanner (operator confirmed 2026-05-28)
- [x] 6.6a: MainShell with Material 3 NavigationBar — 5 tabs: Library · Explore · Collections · Updates · Search; folder-tree drawer demoted from primary nav to a secondary drawer inside Library
- [x] 6.6a: Library + Search tabs wired to live data (existing screens); Explore/Collections/Updates are placeholder scaffolds
- [x] Commit + push (6.6a) → build #13 green, republished to myfonto.com/fonto.apk
- [x] OPERATOR GATE RESOLVED 2026-05-29 — C1 = match web (Places = geo grid via assets hasGeo param; Things = placeholder); C2 = uncropped cover thumb
- [x] 6.6b-1 Collections tab — client (listCollections/SmartCollections/Projects/Stacks) + models (Collection/SmartCollection/Project/AssetStack — renamed to dodge Flutter Stack widget) + CollectionsScreen w/ 4 TabBar sub-tabs (lazy initState load); build #14 green (1.0.14), republished to myfonto.com/fonto.apk
- [x] 6.6b-2 Updates tab — client listActivity(createdBefore,limit)→ActivityPage + sharedWithMe()→SharedAsset; models ActivityEvent/ActivityPage/SharedAsset; UpdatesScreen 3 TabBar sub-tabs (Uploads=newest listAssets grid; Activity=feed w/ human lines mirroring web summarize() + cursor load-more; Shared=grid w/ source-workspace badge); wired into main_shell; build #16 (1.0.16) green, republished to myfonto.com/fonto.apk (note: build numbering jumped 14→16, #15 produced no email)
- [x] 6.6b-3 Explore tab — backend: `hasGeo=1` query param on GET /api/v1/assets (isNotNull lat+lng, index-backed; also fixes web Places tile that already probed it); mobile: client listPersons()→Person model + listAssets(hasGeo:true); ExploreScreen 3 TabBar sub-tabs (People=cover-thumb grid uncropped per C2; Places=geo asset grid→detail; Things=coming-soon placeholder = web parity); wired into main_shell, removed _ComingSoon; committed — backend deploy + build + republish
- [x] 6.6b-4 Nav cleanups — sign-out moved to avatar/account menu (PopupMenuButton in Library appbar); dropped redundant search-push IconButton (Search is now a bottom-nav tab) + unused _openSearch/search_screen import from home_screen. Settings entry DEFERRED (no mobile settings surface exists yet; avatar menu has Sign out only). Committed — build + republish

## Phase 6.7 — Document scanner ⚠
- [x] DECISION C-scan = ML Kit Document Scanner (cunning_document_scanner / flutter_doc_scanner); output = PDF only (operator confirmed 2026-05-28)
- ENTRY POINTS (scoped 2026-05-29, no code yet):
  - Mobile FAB: mobile/lib/src/screens/home_screen.dart FloatingActionButton ~L280-283; capture handler _captureAndUpload() ~L159-189. Add a second action (PopupMenu/speed-dial) "Scan document" → new _scanDocument().
  - Upload queue: mobile/lib/src/state/upload_queue.dart enqueue({filePath, virtualPath, sha256Hex}) ~L128-142; static drain() ~L180. Scanner → write PDF to temp → hash → enqueue (same path as camera).
  - Upload is file-agnostic: FontoClient.uploadFile(File, {virtualPath}) mobile/lib/src/api/fonto_client.dart ~L180-198 (multipart, no mime restriction) → PDF uploads unchanged.
  - pubspec: mobile/pubspec.yaml — NO scanner pkg yet; image_picker/sqflite/crypto/path_provider already present.
  - Backend: lib/processing/processAsset.ts ~L48 DOCUMENT_TRIGGER_MIME already includes application/pdf but does NO binary extraction (no poppler/pdfium/mutool). Dockerfile.worker installs ffmpeg/libheif/libraw/exiftool — NO pdf tooling (add poppler-utils).
  - Schema: lib/db/schema.ts assets table has NO pageCount/page_count col — needs migration (next free number after 0028; verify with `ls drizzle/migrations/`).
- [x] Mobile: add scanner package (flutter_doc_scanner ^0.0.20, bundles ML Kit doc scanner 16.0.0; minSdk 21 already met); FAB now opens bottom sheet (Take photo / Scan document)
- [x] Mobile: native scan flow via ML Kit (auto edge detect, manual corner adjust, multi-page≤24, enhance) → PDF export — getScannedDocumentAsPdf(page:24) returns PdfScanResult{pdfUri (file://), pageCount}
- [x] Mobile: PDF → file path resolve (_pdfPathFromUri) → hash → enqueue via UploadQueue (reuses camera path; uploadFile is mime-agnostic) → drain. Page preview/reorder/name is handled by ML Kit's native scanner UI; no custom screen needed.
- [x] Backend: worker PDF first-page thumbnail (poppler pdftoppm → sharp) + page-count (pdfinfo) — lib/processing/renderPdfFirstPage.ts + generateThumbnails.ts PDF branch; Dockerfile.worker adds poppler-utils; migration 0031 + schema pageCount
- [x] Backend: extend thumbnail-enqueue eligibility (createAssetRow tryEnqueueThumbnail + reapStuckAssets) to image+video+pdf — multipart POST /api/v1/assets gated image-only before, so scanner PDFs would never have enqueued
- [x] Commit + push (6260363) + deploy: migration 0031 applied on the host; fonto + fonto-worker rebuilt + recreated (createAssetRow enqueue-gate fix runs in WEB, poppler in WORKER — both rebuilt); smoke /→200 /app/library→307, worker has pdftoppm+pdfinfo; tag v1.0.19 → Codemagic build #19 (1.0.19) green; APK republished to myfonto.com/fonto.apk
- [ ] Smoke test (operator, real device): scan a doc → PDF uploads → grid shows first-page thumb + page count

## Phase 6.8 — Google Photos import ⚠
- [ ] OPERATOR GATE — Create Google Cloud project; enable Photos Library API
- [ ] OPERATOR GATE — Create OAuth 2.0 Web application client; copy client ID into mobile/android/app/src/main/res/values/strings.xml as `default_web_client_id`
- [ ] OPERATOR GATE — Create OAuth 2.0 Android client (package com.joeybuilt.fonto + SHA-1 from keystore) in same Google Cloud project
- [x] pubspec.yaml — add google_sign_in: ^6.2.1
- [x] strings.xml — add default_web_client_id placeholder (REPLACE_WITH_YOUR_WEB_OAUTH_CLIENT_ID)
- [x] GooglePhotosImportScreen — OAuth sign-in CTA (signInSilently restore + signIn button)
- [x] GooglePhotosImportScreen — Albums tab (list w/ cover thumb + media count)
- [x] GooglePhotosImportScreen — All Photos tab (paginated grid via mediaItems:search)
- [x] GooglePhotosImportScreen — Multi-select overlay + Import action bar button
- [x] GooglePhotosImportScreen — Download + enqueue flow (baseUrl=d / =dv → tmp file → sha256 → UploadQueue → drain)
- [x] home_screen FAB sheet — "Import from Google Photos" third option; push GooglePhotosImportScreen; refresh grid on return
- [x] Commit + push + tag v1.0.20

## Phase 6.9 — Android Documents Provider
- [x] Kotlin FontoDocumentsProvider.kt — queryRoots (one root: "Fonto Library")
- [x] Kotlin FontoDocumentsProvider.kt — queryChildDocuments (fetch asset list via Fonto REST, map to cursor rows)
- [x] Kotlin FontoDocumentsProvider.kt — queryDocument (single asset metadata)
- [x] Kotlin FontoDocumentsProvider.kt — openDocument (stream bytes from presigned URL via HTTP)
- [x] Auth bridge — Flutter writes PAT + baseUrl to SharedPreferences on login (MethodChannel com.joeybuilt.fonto/auth_bridge)
- [x] AndroidManifest.xml — register <provider> with android:permission="android.permission.MANAGE_DOCUMENTS"
- [ ] Smoke test — attach file in Gmail → see "Fonto Library" → pick asset → attaches — DEFERRED to operator (needs real device)
- [x] Commit + push + tag

## Phase 6.10 — Camera roll auto-import
- [x] pubspec.yaml — add photo_manager: ^3.3.0 + shared_preferences: ^2.3.0
- [x] SettingsScreen — new screen pushed from avatar menu; "Auto-import camera roll" toggle
- [x] settings_store.dart — SharedPreferences wrapper (last_import_ts, auto_import_enabled)
- [x] camera_roll_scanner.dart — photo_manager query; createTimeCond filter; enqueue new assets
- [x] WorkManager task kCameraRollScanTask — periodic scan + drain in callbackDispatcher
- [x] Foreground scan on app open when auto-import enabled (HomeScreen._maybeScanCameraRoll)
- [x] Permission request — READ_MEDIA_IMAGES + READ_MEDIA_VIDEO on toggle-on; graceful deny path
- [x] Commit + push + tag

## Phase 6.11 — Additional import sources (stub)
- [ ] FAB import sheet — show all sources (Google Photos ✓ + Google Drive + Nextcloud + iCloud stubs)
- [ ] Google Drive stub — "Coming soon" entry in import sheet (reuses google_sign_in)
- [ ] Nextcloud stub — "Coming soon" entry in import sheet
- [ ] iCloud stub — "iOS only / coming soon" entry
- [ ] Commit + push + tag

## Phase 9c — Backups + restore drill
- [x] ops/backup/pg-dump.sh — pg_dump | gzip | rclone copy
- [x] ops/backup/r2-sync.sh — rclone sync R2 → offsite
- [x] Cron schedule — nightly 0300 UTC (ops/backup/crontab.example)
- [x] ops/backup/restore-drill.sh — spin up postgres-drill container, load, smoke, teardown
- [x] Drill cron schedule — monthly first Sunday 0500 UTC
- [x] Alertmanager rule — FontoRestoreDrillStale (>40 days since last drill success)
- [ ] Manual run — drill passes once on demand — DEFERRED to operator (needs rclone + offsite configured)
- [ ] Manual run — drill passes once on schedule — DEFERRED to operator
- [x] Commit + push
