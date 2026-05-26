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
- [ ] OPERATOR GATE — Android keystore generated on the host + uploaded to Codemagic
- [ ] OPERATOR GATE — iOS signing certs + provisioning profiles uploaded to Codemagic (DEFERRED — operator is Android-only; build iOS-CI later if/when iOS distribution becomes relevant)
- [ ] Widget tests — login screen, home grid, search screen, asset detail
- [ ] Integration test — full upload flow via image_picker mock
- [ ] codemagic.yaml — iOS workflow (build + test + archive)
- [ ] codemagic.yaml — Android workflow (build + test + bundle)
- [ ] PR pipeline runs on push to main
- [ ] Signed IPA + APK artifacts uploaded per push
- [ ] mobile/CI.md runbook — cert rotation + 30-day expiry monitor
- [ ] Commit + push

## Phase 7a — Comments + activity feed
- [x] OPERATOR GATE — C4 = **daily digest** (operator confirmed 2026-05-25, ADR 0003 default stands)
- [ ] Schema: `comments` table (assetId, userId, body, parentId nullable, createdAt)
- [ ] Schema: `activity_events` table (workspaceId, kind, payload, createdAt)
- [ ] Hand-written migration under drizzle/migrations/
- [ ] POST /api/v1/assets/:id/comments
- [ ] GET /api/v1/assets/:id/comments (threaded)
- [ ] DELETE /api/v1/assets/:id/comments/:commentId (own or workspace-editor)
- [ ] GET /api/v1/workspace/activity (cursor-paginated)
- [ ] Web UI — comments drawer in asset detail
- [ ] Web UI — /app/activity page
- [ ] Per-share mute setting
- [ ] Daily-digest worker job (BullMQ scheduled)
- [ ] Digest email template
- [ ] Commit + push

## Phase 7b — Cross-workspace sharing + new roles ⚠
- [x] OPERATOR GATE — C5 = **reference** (operator confirmed 2026-05-25; shared rows point at source workspace's R2 object, no duplication)
- [ ] Migration — extend role CHECK to add `commenter` + `contributor`
- [ ] Schema: `shared_assets` table per chosen model
- [ ] requireWorkspaceAccessOrResponse — teach about new roles
- [ ] Audit every callsite of requireWorkspaceAccessOrResponse (Explore subagent)
- [ ] POST /api/v1/assets/:id/share — share to another workspace
- [ ] DELETE /api/v1/assets/:id/share/:targetWorkspaceId — revoke
- [ ] Web UI — "Share with workspace" action in asset detail
- [ ] Visibility — shared assets appear in target workspace's listings with badge
- [ ] Commit + push

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
- [ ] lib/processing/transcodeVideoHls.ts — single-bitrate H.264 HLS
- [ ] On-demand trigger — first play request enqueues transcode job
- [ ] R2 storage layout — `<assetId>/hls/playlist.m3u8` + segments
- [ ] GET /api/v1/assets/:id/hls — returns presigned playlist URL
- [ ] Sprite generator — 10s-interval thumbnail strip for hover-scrub
- [ ] Web UI — hls.js player in asset detail
- [ ] Web UI — hover-scrub preview via sprite
- [ ] Cleanup — orphan HLS purger (when asset trashed)
- [ ] Commit + push

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
- [ ] ops/autoscaler/ container — small reconciler (Node or Go)
- [ ] Signal reader — Valkey LLEN on BullMQ queue OR docker stats
- [ ] Compose API call — scale fonto-worker replicas
- [ ] Floor 1 / ceiling 4 / 60s dampening
- [ ] Dry-run flag — log decisions without acting
- [ ] Enqueue-100-jobs test — verify scale up + scale down
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
