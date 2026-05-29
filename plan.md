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

## Operator-gated conflicts — RESOLVED 2026-05-25

- C1 — iOS Keychain: **first_unlock** (scaffold default stands; operator
  is Android-only so iOS class is not personally blocking).
- C2 — Autoscale signal: **queue-depth (Valkey BullMQ LLEN)**. Marcus wins.
- C4 — Notification policy: **daily digest** (ADR 0003 default confirmed).
- C5 — Cross-workspace sharing model: **reference (pointer, no copy)**.
  Tess wins. Source workspace's R2 object is the canonical bytes; shared
  rows in target workspace are FK references.
- C6 — Mobile shells: **in-repo** (mobile/ios, mobile/android alongside
  Flutter source). Yuki wins.
- C7 — Video HLS: **ladder day-one** (360p/720p/1080p H.264 renditions).
  Diego wins — overrides original Phase 8b "single-bitrate" scope.
- ADR 0002 cert provisioning: Android keystore to be generated on the host
  + scp'd off by operator. iOS signing deferred (Android-only operator).

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
- Status: see checklist.md

## Phase 6.2b — Mobile background upload queue

- Scope: queue camera + picked uploads in a local DB (sqflite). Drain
  via Workmanager on Android, BGTaskScheduler on iOS. Survive app
  backgrounding, retry on failure, dedupe via sha256.
- Deps: 6.2a (need a place to surface "queued" badge in the grid).
- Subagents: none.
- Exit: lock the phone mid-upload — upload completes; opening the app
  shows the now-uploaded asset; queue is empty.
- Status: see checklist.md

## Phase 6.2c — Mobile tests + CI ⚠ (one-way door: signing certs)

- Scope: widget tests for login, home grid, search, asset detail.
  Integration tests for upload flow. Codemagic config for iOS + Android
  builds on push to main. See `adr/0002`.
- Deps: 6.2b. ⚠ Operator must complete signing-cert provisioning checklist
  in ADR 0002 BEFORE this phase can execute.
- Subagents: none.
- Exit: PR pipeline runs widget + integration tests on iOS sim + Android
  emulator; signed IPA + APK artifact produced per push.
- Status: see checklist.md — BLOCKED on operator gate

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
- Status: see checklist.md — BLOCKED on C4

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
- Status: see checklist.md — BLOCKED on C5

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
- Status: see checklist.md

## Phase 8b — HLS transcode + player UI ⚠ (storage commitment)

- Scope: **3-rendition H.264 HLS ladder** (360p ~800kbps, 720p ~2.5Mbps,
  1080p ~5Mbps), triggered lazily on first play request (cached forever
  in R2 thereafter). Master playlist references all three. Player UI
  uses hls.js w/ keyboard scrubber, hover-scrub preview using
  10s-interval thumbnail sprite (also extracted in 8a as a one-time
  job). C7 RESOLVED — ladder day-one per operator 2026-05-25.
- Deps: 8a. C7 confirmed by operator.
- Subagents: Explore for the grid renderer — needs a play icon overlay
  on video tiles.
- Exit: click a video tile → plays in-grid; hover the scrubber → sprite
  preview; seeking works without re-buffering.
- Status: see checklist.md — BLOCKED on C7

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
- Status: see checklist.md

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
- Status: see checklist.md — BLOCKED on C2

## Phase 9c — Backups + restore drill

- Scope: nightly cron — `pg_dump` of `pushd` db to offsite
  (Backblaze B2 or rsync.net), `rclone sync` of R2 to same offsite.
  Monthly restore-drill cron: spin up `service`, load
  last night's dump, run smoke queries, tear down. Alert if drill fails.
- Deps: 9a (alerts need to exist before we lean on them).
- Subagents: none.
- Exit: drill passes once on demand + once on schedule.
- Status: see checklist.md

---

---

## Phase 6.3 — Google Play distribution + Codemagic publishing ⚠ (operator: Play listing + service account)

- Scope: Add `changeset:` path filter on Codemagic `android-release`
  workflow (trigger only on `mobile/**` changes — C8). Add Codemagic
  `publishing.google_play` stanza targeting `internal` track. Operator
  creates Play app listing + Google Play service account and wires it
  to Codemagic.
- Deps: 6.2c (Codemagic building clean AAB). ⚠ Operator must create
  Google Play app listing (package `com.joeybuilt.fonto`) + service
  account JSON per ADR 0006 checklist before the publishing stanza
  is usable.
- Subagents: none.
- Exit: push to `mobile/**` on main → AAB lands in Play Store internal
  track automatically; install on device from Play Console internal
  testing link.
- Status: pending

## Phase 6.4 — FCM push notifications ⚠ (operator: Firebase project + google-services.json)

- Scope: `push_tokens` table + migration. POST/DELETE
  `/api/v1/notifications/push-token` (register/deregister per-device
  FCM token). Backend notification dispatch: real-time FCM on new
  comment + workspace share received (C10 Option A). Mobile:
  `firebase_messaging` package, request permission, register token,
  handle notification tap → route to asset detail.
- Deps: 7a (comments + shares are the event sources). ⚠ Operator must
  create Firebase project + download `google-services.json` per ADR
  0006 checklist before mobile can build with Firebase.
- Subagents: Explore for "find every place a comment or share is
  created" (notification dispatch hooks go there).
- Exit: post a comment on an asset → device receives FCM notification
  within 5s; tap opens that asset's detail screen.
- Status: pending — BLOCKED on operator gate (Firebase project)

## Phase 6.5 — Android App Links + in-app deep link routing

- Scope: Serve `/.well-known/assetlinks.json` from Next.js (route, not
  static file, so cert fingerprint is env-configurable). Add
  `intent-filter` in `AndroidManifest.xml` for
  `https://myfonto.com`. Add `app_links` Flutter package; handle
  incoming URIs: `/app/library?lb=<id>` → open asset detail,
  `/share/<token>` → resolve + open asset detail (C9 Option A:
  App Links only — no custom scheme fallback).
- Deps: none (self-contained).
- Subagents: none.
- Exit: tap `https://myfonto.com/share/<token>` link on Android 6+
  → app opens directly to that asset's detail without touching browser.
- Status: pending

---

## Phase 6.6 — Mobile nav + tab content

6.6a (NavigationBar shell) shipped in build #13. 6.6b wires the three
placeholder tabs to live data — see ADR 0007 for scope decisions +
escalated conflicts C1 (Explore Places/Things scope) and C2 (People
crops). Each sub-phase ends with a Codemagic build + APK republish to
myfonto.com/fonto.apk (mobile-only; no backend except the C1 `hasGeo`
param if approved).

### Phase 6.6b-1 — Collections tab
- Scope: FontoClient.listCollections / listSmartCollections / listProjects
  / listStacks + models; CollectionsScreen with 4 Material TabBar sub-tabs
  (Albums/Smart/Projects/Stacks). Stacks render primary-asset thumb; others
  name + count rows. Lazy-load per sub-tab.
- Deps: none (6.6a done)
- Subagents: general-purpose for the screen if large
- Exit: Collections tab shows 4 live sub-tabs; analyze+build green; republished
- Status: DONE — build #14 (1.0.14) green, republished to myfonto.com/fonto.apk 2026-05-29

### Phase 6.6b-2 — Updates tab
- Scope: client.listActivity(cursor) + sharedWithMe(); reuse listAssets
  (newest) for Uploads; ActivityEvent model. UpdatesScreen with 3 sections
  (Uploads grid / Activity feed list with human-readable lines / Shared-with-me
  grid with source-workspace badge).
- Deps: none
- Exit: Updates tab 3 sections live; green; republished
- Status: DONE — build #16 (1.0.16) green, republished to myfonto.com/fonto.apk 2026-05-29

### Phase 6.6b-3 — Explore tab ⚠ (gated on C1)
- Scope: client.listPersons() → People grid (cover thumb per C2); Places =
  geo-filtered asset grid; Things = placeholder matching web. Per ADR 0007 C1.
- Deps: operator sign-off on C1 (Places/Things scope) + possible `hasGeo`
  param on /api/v1/assets
- ⚠ One small backend change (assets `hasGeo` query param) IF C1 = match-web
- Exit: Explore tab matches agreed scope; green; republished
- Status: DONE — backend hasGeo deployed to NAS; build #18 (1.0.18) green, republished 2026-05-29

### Phase 6.6b-4 — Nav parity cleanups
- Scope: avatar/account menu (move sign-out there; Settings entry); drop the
  redundant search-push icon from the Library appbar.
- Deps: none
- Exit: sign-out in avatar menu; Library appbar de-cluttered; green; republished
- Status: DONE — folded into build #18 (1.0.18), republished 2026-05-29. Settings entry deferred (no mobile settings surface yet).

---

## Phase 6.8 — Google Photos import ⚠ (operator: Google Cloud project + OAuth client)

- Scope: OAuth2 via `google_sign_in` package (`photoslibrary.readonly` scope). New
  `GooglePhotosImportScreen`: sign-in CTA, Albums tab (list w/ cover thumb + count),
  All Photos tab (paginated grid), multi-select → download each item (`baseUrl=d` /
  `=dv` for video) to tmp → sha256 → enqueue via UploadQueue → drain. FAB sheet gains
  a third option "Import from Google Photos". No backend changes — photos arrive as
  regular multipart uploads.
- Deps: 6.2b (UploadQueue).
- ⚠ Operator gate: create Google Cloud project → enable Photos Library API → create
  OAuth 2.0 Web application client → copy client ID into
  `mobile/android/app/src/main/res/values/strings.xml` as `default_web_client_id` →
  create Android OAuth 2.0 client (package `com.joeybuilt.fonto` + SHA-1 from keystore)
  in same project. No config file required in the app — the Web client ID in strings.xml
  is enough for the Android runtime.
- Exit: tap "Import from Google Photos" in FAB sheet → OAuth consent → album/photo
  browser → select 3 photos → Import → photos queued and appear in grid.
- Status: see checklist.md

## Phase 6.9 — Android Documents Provider (Fonto in system file picker)

- Scope: Kotlin `DocumentsProvider` subclass at
  `mobile/android/app/src/main/kotlin/com/joeybuilt/fonto/FontoDocumentsProvider.kt`.
  Implements `queryRoots` (one root "Fonto Library"), `queryChildDocuments` (asset list
  via Fonto REST API — paged), `queryDocument` (single asset metadata),
  `openDocument` (stream bytes from presigned URL). Auth bridge: Flutter writes PAT +
  baseUrl to `SharedPreferences` on login; provider reads same prefs (same process,
  no IPC needed). Register in AndroidManifest as `<provider>` with
  `android:permission="android.permission.MANAGE_DOCUMENTS"`. No backend changes.
- Deps: 6.2c (Android shell). Phase 6.8 (confirms Google Cloud console familiarity).
- Exit: open Gmail attach-file picker → Files → see "Fonto Library" → browse → pick
  a photo → attaches to draft.
- Status: planned

## Phase 6.10 — Camera roll auto-import

- Scope: `photo_manager: ^3.3.0` package for MediaStore access. New
  `SettingsScreen` (pushed from avatar menu "Settings" entry). Toggle "Auto-import
  camera roll" (stored in `sqflite` `settings` table). WorkManager periodic task
  queries MediaStore for `DATE_ADDED > last_import_ts` (images + videos). Each new
  asset: read bytes → sha256 → dedup → enqueue. Update `last_import_ts` on success.
  Also add immediate foreground scan on app open when toggle is on.
  No backend changes.
- Deps: 6.2b (UploadQueue). 6.6b-4 (Settings entry placeholder in avatar menu).
- Exit: enable auto-import in Settings → take a photo with device camera → within
  15 min (WorkManager window) or next app open, photo appears in Fonto grid.
- Status: planned

## Phase 6.11 — Additional cloud import sources (stub + future)

- Scope: Design + stub only. Extend FAB import sheet to show all sources with
  placeholder states for unimplemented ones. Road-map:
  - **Google Drive** — Drive API v3, reuse `google_sign_in` from 6.8 with
    `drive.readonly` scope. Browse folders, select files, download → enqueue.
  - **Nextcloud** — WebDAV (`webdav_client` package), server URL + credentials
    stored in `flutter_secure_storage`. Browse dirs, select, download → enqueue.
  - **iCloud** — iOS-only (`PHPhotoLibrary`); defer until iOS distribution needed.
  Each stub shows a "Coming soon" bottom-sheet until its phase ships.
- Deps: 6.8 (import infrastructure pattern).
- Exit: import sheet lists all four sources; Google Drive + Nextcloud + iCloud
  entries show "Coming soon" snackbar; Google Photos works end-to-end (6.8).
- Status: planned (stubs ship with 6.11; full impls in future phases)

---

## Sequencing summary (updated 2026-05-28)

```
6.2a ✓ → 6.2b ✓ → 6.2c ✓ (Codemagic live, first build running)
         → 6.3⚠ (Play listing + service account) → 6.4⚠ (Firebase)
         → 6.5 (App Links — no gate, executable immediately)
                  (mobile track: 6.2 done; 6.3-6.5 pending)

7a ✓ → 7b ✓
           (collab track done)

8a ✓ → 8b ✓
           (video track done)

9a ✓ → 9b ✓ → 9c ✓
                   (ops track done — operator-deferred items noted in checklist)
```

All original 9 phases shipped + deployed. Mobile phases 6.3–6.11 added.
Phase 6.8 (Google Photos) is gate-free on first run; operator sets up
Google Cloud project + OAuth client. Phases 6.3 + 6.4 gate on Play Console
and Firebase respectively — see ADR 0006.

Conflicts C8, C9, C10 RESOLVED 2026-05-28 (all Option A — see ADR 0006):
- C8 — Codemagic path filter on `mobile/**`. Marcus wins.
- C9 — App Links only (https), no custom scheme. Android 5 → browser. Priya wins.
- C10 — FCM real-time for comments + shares; daily digest for summaries. Tess wins.

Execution order for next session (start with the gate-free phase):
1. **Phase 6.5** (App Links + deep links) — NO gate, execute first.
2. **Phase 6.3** (Play publishing) — needs operator Play Console + service account.
3. **Phase 6.4** (FCM) — needs operator Firebase project + google-services.json.

## What's NOT in this plan

- S3 import (#13) — blocked on AWS account confirmation, explicitly
  excluded.
- iOS distribution — deferred (operator is Android-only).
- iOS / Android E2E encryption — out of parity scope per OSS deviation.
- ActivityPub federation — out of parity scope per OSS deviation.
- Second GPU purchase — out of plan scope.
