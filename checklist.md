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
- [ ] sqflite-backed upload queue table
- [ ] Enqueue on capture/pick instead of immediate upload
- [ ] Workmanager (Android) periodic task — drain queue
- [ ] BGTaskScheduler (iOS) — register + drain on opportunity
- [ ] sha256 dedupe (don't re-queue identical bytes)
- [ ] Retry w/ exponential backoff, max 5
- [ ] "Queued: N" badge in home_screen app bar
- [ ] Background test: lock phone mid-upload, verify completion
- [ ] Commit + push

## Phase 6.2c — Mobile tests + CI ⚠
- [ ] OPERATOR GATE — signing certs + provisioning profiles uploaded to Codemagic
- [ ] Widget tests — login screen, home grid, search screen, asset detail
- [ ] Integration test — full upload flow via image_picker mock
- [ ] codemagic.yaml — iOS workflow (build + test + archive)
- [ ] codemagic.yaml — Android workflow (build + test + bundle)
- [ ] PR pipeline runs on push to main
- [ ] Signed IPA + APK artifacts uploaded per push
- [ ] mobile/CI.md runbook — cert rotation + 30-day expiry monitor
- [ ] Commit + push

## Phase 7a — Comments + activity feed
- [ ] OPERATOR GATE — confirm C4 (digest vs per-comment vs off)
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
- [ ] OPERATOR GATE — confirm C5 (reference vs copy-on-write)
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
- [ ] OPERATOR GATE — confirm ADR 0001 default (CPU-only ffmpeg)
- [ ] worker/Dockerfile — install ffmpeg + ffprobe (CPU build)
- [ ] lib/processing/probeVideo.ts — ffprobe wrapper
- [ ] lib/processing/extractVideoThumbnail.ts — ffmpeg keyframe-aligned
- [ ] processAsset dispatcher — branch on mime
- [ ] Schema: assets.duration_seconds, assets.video_codec
- [ ] Backfill script for existing video uploads (if any)
- [ ] Grid renderer — play icon overlay on video tiles
- [ ] Asset detail — show duration + codec in metadata pane
- [ ] Commit + push

## Phase 8b — HLS transcode + player UI ⚠
- [ ] OPERATOR GATE — confirm C7 (single-bitrate vs ladder)
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
- [ ] ops/grafana/dashboards/overview.json
- [ ] ops/grafana/dashboards/processing.json
- [ ] ops/grafana/dashboards/queue-depth.json
- [ ] ops/grafana/dashboards/api-latency.json
- [ ] ops/grafana/provisioning.yaml — auto-load dashboards on Grafana boot
- [ ] ops/alerts/rules.yml — queue depth, p99 latency, error rate
- [ ] Alertmanager config — Discord + email routing
- [ ] Compose service — grafana + alertmanager containers
- [ ] Pull power test — verify alert fires within 60s
- [ ] Commit + push

## Phase 9b — Worker autoscale ⚠
- [ ] OPERATOR GATE — confirm C2 (queue depth vs CPU)
- [ ] ops/autoscaler/ container — small reconciler (Node or Go)
- [ ] Signal reader — Valkey LLEN on BullMQ queue OR docker stats
- [ ] Compose API call — scale fonto-worker replicas
- [ ] Floor 1 / ceiling 4 / 60s dampening
- [ ] Dry-run flag — log decisions without acting
- [ ] Enqueue-100-jobs test — verify scale up + scale down
- [ ] Commit + push

## Phase 9c — Backups + restore drill
- [ ] ops/backup/pg-dump.sh — pg_dump | gzip | rclone copy
- [ ] ops/backup/r2-sync.sh — rclone sync R2 → offsite
- [ ] Cron schedule — nightly 0300 UTC
- [ ] ops/backup/restore-drill.sh — spin up postgres-drill container, load, smoke, teardown
- [ ] Drill cron schedule — monthly first Sunday 0500 UTC
- [ ] Alertmanager — drill-failure alert
- [ ] Manual run — drill passes once on demand
- [ ] Manual run — drill passes once on schedule
- [ ] Commit + push
