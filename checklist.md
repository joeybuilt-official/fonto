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
- [x] codemagic.yaml — Android workflow (build + test + bundle, triggers push+PR to main, emails dustin@joeybuilt.com)
- [x] Android project shell — mobile/android/ scaffold (build.gradle, manifest, MainActivity.kt, signingConfigs via CM_* env vars)
- [ ] PR pipeline runs on push to main — **OPERATOR: connect Codemagic to fonto repo, enable android-release workflow**
- [ ] Signed AAB artifact uploaded per push — pending Codemagic keystore upload + repo connection
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
