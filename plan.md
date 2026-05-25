# Fonto → Immich parity — Phases 6.2 finish + 7 + 8 + 9

## Goal

Close the remaining Fonto → Immich parity gap across mobile (6.2 finish
line), collaboration (7), video (8), and ops (9) over ~10 phases.
S3 import (#13) is explicitly excluded pending AWS account confirmation.

## Audit findings (overriding the request as written)

1. **Phase 9 ops is NOT greenfield.** `lib/metrics.ts` already exports a
   Prometheus registry; `/api/metrics` route + worker side-listener
   exist. Scope shrinks to dashboards / alerts / autoscale / backups.
2. **Phase 7 collab is partially started.** Workspace members,
   invitations, and shares APIs already exist (`app/api/v1/workspace/*`,
   `app/api/v1/shares/*`). Roles are text+CHECK (`owner|editor|viewer`).
   Comments + activity feed + cross-workspace sharing are the gaps.
3. **Phase 8 video is fully greenfield.** No ffmpeg / transcode anywhere.
   The existing `lib/processing/` chain handles images only.
4. **Phase 6.2 mobile follow-ups from `mobile/README.md` "next sessions"**
   are the right starting point but are missing: asset detail view,
   tests, share-from-mobile sheet.

## Cross-phase decisions captured in ADRs

- `adr/0001-video-pipeline-gpu-isolation.md` — default CPU-only ffmpeg
  worker. Resolves C3 (Diego vs Lin).
- `adr/0002-mobile-ci-signing.md` — Codemagic default; cert provisioning
  is a hard one-way door before Phase 6.2c can execute.
- `adr/0003-notification-policy.md` — daily-digest default. Resolves C4
  (Tess vs Priya).

## Operator-gated conflicts (still need a call)

- C1 — iOS Keychain accessibility: `first_unlock` (default in current
  scaffold) vs `unlocked_this_device_only`. Aisha vs Hiroshi.
- C2 — Autoscale signal: queue-depth vs CPU%. Marcus vs Lin.
- C5 — Cross-workspace sharing model: copy-on-write vs reference. Aisha
  vs Tess.
- C6 — Mobile platform shells in-repo vs out-of-repo. Yuki vs Hiroshi.
- C7 — Video HLS: single-bitrate first vs ladder day-one. Marcus vs Diego.

Each is a sign-off gate before the phase that consumes it.

---

## Phase 6.2a — Mobile asset detail + share sheet

- Scope: tap-a-tile → full-screen detail view (zoom, pan, swipe between
  assets). Action bar: favorite, trash, share. Share sheet uses native
  iOS/Android share intent for the original-URL link.
- Deps: none (current mobile state is the baseline).
- Subagents: none (small, focused mobile edits).
- Exit: tile tap opens detail; swipe works; trash + favorite roundtrip
  to server; share sheet opens with a valid `https://myfonto.com/share/...`
  URL.
- Status: pending

## Phase 6.2b — Mobile background upload queue

- Scope: queue camera + picked uploads in a local DB (sqflite). Drain
  via Workmanager on Android, BGTaskScheduler on iOS. Survive app
  backgrounding, retry on failure, dedupe via sha256.
- Deps: 6.2a (need a place to surface "queued" badge in the grid).
- Subagents: none.
- Exit: lock the phone mid-upload — upload completes; opening the app
  shows the now-uploaded asset; queue is empty.
- Status: pending

## Phase 6.2c — Mobile tests + CI ⚠ (one-way door: signing certs)

- Scope: widget tests for login, home grid, search, asset detail.
  Integration tests for upload flow. Codemagic config for iOS + Android
  builds on push to main. See `adr/0002`.
- Deps: 6.2b. ⚠ Operator must complete signing-cert provisioning checklist
  in ADR 0002 BEFORE this phase can execute.
- Subagents: none.
- Exit: PR pipeline runs widget + integration tests on iOS sim + Android
  emulator; signed IPA + APK artifact produced per push.
- Status: pending — BLOCKED on operator gate

---

## Phase 7a — Comments + activity feed

- Scope: `comments` table (assetId, userId, body, createdAt, parentId
  nullable for threading); `activity_events` table (workspace-scoped
  feed). Routes: GET/POST/DELETE `/api/v1/assets/:id/comments`, GET
  `/api/v1/workspace/activity`. Web UI: comments panel in asset detail
  drawer; activity feed page at `/app/activity`. Daily-digest worker
  job per ADR 0003.
- Deps: ADR 0003 finalised. C4 confirmed by operator.
- Subagents: Explore for "find every place we render asset metadata"
  (needs comments-count badge there).
- Exit: user A comments on asset; user B sees it in-app immediately,
  in the daily digest the next morning.
- Status: pending — BLOCKED on C4

## Phase 7b — Cross-workspace sharing + commenter/contributor roles ⚠ (CHECK migration)

- Scope: extend `workspace_members.role` CHECK to add `commenter`
  (read + comment only) and `contributor` (read + comment + upload, no
  delete). Add `shared_assets` table (assetId, sourceWorkspaceId,
  targetWorkspaceId, accessLevel) per ADR'd model (reference, not
  copy — see C5). Web UI: "Share with another workspace" action in
  asset detail.
- Deps: 7a. C5 confirmed by operator.
- Subagents: Explore for every place `requireWorkspaceAccessOrResponse`
  is called — those need to learn about the new roles.
- Exit: user A shares asset X from workspace Foo to workspace Bar; user B
  in Bar can view X but cannot delete; X still lives in Foo's storage.
- Status: pending — BLOCKED on C5

---

## Phase 8a — Video probe + thumbnail extraction

- Scope: extend `processAsset` chain for `video/*` mime: `ffprobe` for
  duration/codec/dimensions; ffmpeg to extract a thumbnail at the 10%
  mark (rounded to nearest keyframe); persist as the asset's preview.
  Build `ffmpeg-worker` image (CPU-only per ADR 0001).
- Deps: ADR 0001 finalised.
- Subagents: Explore for current image-processing dispatch — need to
  add a video branch.
- Exit: upload a `.mp4` → thumbnail appears in grid; metadata shows
  duration; processing state advances to `processed`.
- Status: pending

## Phase 8b — HLS transcode + player UI ⚠ (storage commitment)

- Scope: single-bitrate H.264 HLS transcode, triggered lazily on first
  play request (cached forever in R2 thereafter). Player UI uses
  hls.js w/ keyboard scrubber, hover-scrub preview using 10s-interval
  thumbnail sprite (also extracted in 8a as a one-time job). See C7.
- Deps: 8a. C7 confirmed by operator.
- Subagents: Explore for the grid renderer — needs a play icon overlay
  on video tiles.
- Exit: click a video tile → plays in-grid; hover the scrubber → sprite
  preview; seeking works without re-buffering.
- Status: pending — BLOCKED on C7

---

## Phase 9a — Dashboards as code + Alertmanager

- Scope: commit Grafana dashboard JSONs to `ops/grafana/dashboards/`
  (provisioned via grafana sidecar that watches the dir). Commit
  Alertmanager rules to `ops/alerts/rules.yml` (queue depth > N,
  asset processing p99 > T, error rate > X). Wire to existing
  prom-client. Email/Discord routing.
- Deps: none.
- Subagents: Explore for all currently-emitted metrics (need to know
  what's actually safe to alert on).
- Exit: open Grafana → see 4+ dashboards (overview, processing, queue
  depth, API latency); pull power on a worker → Alertmanager fires
  within 60s.
- Status: pending

## Phase 9b — Worker autoscale ⚠ (touches docker compose live)

- Scope: small reconciler container (`autoscaler`) reads queue depth
  from Valkey, scales `fonto-worker` replicas via `docker compose
  up -d --scale fonto-worker=N`. Signal choice per C2. Floor of 1,
  ceiling of 4. 60s dampening to avoid thrash.
- Deps: 9a (need dashboards to see if it's actually working). C2
  confirmed by operator.
- Subagents: none.
- Exit: enqueue 100 jobs → autoscaler scales worker to 4; queue drains
  → autoscaler scales back to 1 after dampening period.
- Status: pending — BLOCKED on C2

## Phase 9c — Backups + restore drill

- Scope: nightly cron — `pg_dump` of `pushd` db to offsite
  (Backblaze B2 or rsync.net), `rclone sync` of R2 to same offsite.
  Monthly restore-drill cron: spin up `service`, load
  last night's dump, run smoke queries, tear down. Alert if drill fails.
- Deps: 9a (alerts need to exist before we lean on them).
- Subagents: none.
- Exit: drill passes once on demand + once on schedule.
- Status: pending

---

## Sequencing summary

```
6.2a → 6.2b → 6.2c⚠
                 (mobile track done)

7a → 7b⚠
        (collab track done)

8a → 8b⚠
        (video track done)

9a → 9b⚠ + 9c
              (ops track done)
```

Mobile, collab, video, ops tracks are independent — sessions can pick
whichever is unblocked. ⚠ phases need operator sign-off before they
start.

## What's NOT in this plan

- S3 import (#13) — blocked on AWS account confirmation, explicitly
  excluded.
- Phase 8 multi-bitrate HLS ladder — deferred per C7 default.
- iOS / Android E2E encryption — out of parity scope per OSS deviation.
- ActivityPub federation — out of parity scope per OSS deviation.
- Second GPU purchase — out of plan scope.
