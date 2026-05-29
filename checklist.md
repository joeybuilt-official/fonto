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
- [ ] Schema + migration: fonto.push_tokens (userId, deviceId, token, platform, updatedAt; UNIQUE userId+deviceId)
- [ ] POST /api/v1/notifications/push-token — upsert token for authenticated user+device
- [ ] DELETE /api/v1/notifications/push-token — deregister token
- [ ] Backend notification dispatch — send FCM on: new comment on user's asset, workspace share received
- [ ] Mobile: add firebase_messaging to pubspec.yaml
- [ ] Mobile: decode + write google-services.json from GOOGLE_SERVICES_JSON env var in Codemagic build script
- [ ] Mobile: request notification permission on first launch
- [ ] Mobile: register token via POST /api/v1/notifications/push-token on auth
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
- [x] 6.6b-2 Updates tab — client listActivity(createdBefore,limit)→ActivityPage + sharedWithMe()→SharedAsset; models ActivityEvent/ActivityPage/SharedAsset; UpdatesScreen 3 TabBar sub-tabs (Uploads=newest listAssets grid; Activity=feed w/ human lines mirroring web summarize() + cursor load-more; Shared=grid w/ source-workspace badge); wired into main_shell; committed — build + republish
- [ ] 6.6b-3 Explore tab — People (persons) + Places (geo grid; add assets hasGeo param) + Things (placeholder = web parity); build + republish
- [ ] 6.6b-4 Nav cleanups — sign-out → avatar/account menu; drop redundant Library search-push; build + republish

## Phase 6.7 — Document scanner ⚠
- [x] DECISION C-scan = ML Kit Document Scanner (cunning_document_scanner / flutter_doc_scanner); output = PDF only (operator confirmed 2026-05-28)
- [ ] Mobile: add scanner package; camera FAB → "Scan document" entry
- [ ] Mobile: native scan flow (auto edge detect, manual corner adjust, multi-page, enhance) → PDF export
- [ ] Mobile: page preview/reorder → name → upload PDF as asset
- [ ] Backend: worker PDF first-page thumbnail (poppler/pdfium) + page-count metadata
- [ ] Commit + push

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
