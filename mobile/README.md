# fonto_mobile — Phase 6.2 scaffold

Flutter client for Fonto. Talks to `/api/v1` via the same PAT auth the
CLI uses. This commit lands the Dart sources + `pubspec.yaml`; the
platform shells (`android/`, `ios/`) are generated on first run.

## Bootstrap

This scaffold ships without the platform host code so the repo doesn't
carry generated Gradle/Xcode bytes. On a machine with the Flutter SDK
installed:

```bash
cd mobile
flutter create --project-name fonto_mobile --platforms=ios,android .
flutter pub get
flutter run            # device / simulator must already be paired
```

`flutter create .` is non-destructive — it only adds the missing
platform dirs and skips files that already exist (so `lib/`,
`pubspec.yaml`, and `analysis_options.yaml` survive).

## Layout

```
mobile/
  pubspec.yaml             # http, flutter_secure_storage, image_picker,
                           # cached_network_image
  analysis_options.yaml
  lib/
    main.dart              # MaterialApp + login-vs-home swap
    src/
      api/
        fonto_client.dart  # PAT-auth HTTP client w/ keyset paging
        models.dart        # Asset, AssetPage, AssetCursor,
                           # WorkspaceStats, FolderTree, FolderLeaf
      state/
        auth_store.dart    # flutter_secure_storage (iOS Keychain /
                           # Android Keystore) PAT + base URL
      screens/
        login_screen.dart  # PAT form, validates against /api/v1/stats
        home_screen.dart   # stats bar + paginated grid + drawer rail
                           # + camera FAB + pull-to-refresh
        search_screen.dart # text search over filename / description /
                           # OCR
```

## What works after bootstrap

- PAT login (hardware-backed across launches via
  `flutter_secure_storage` — iOS Keychain, Android Keystore).
- Stats bar + workspace assets w/ cached thumbnails.
- Keyset pagination — infinite scroll, no offset drift when uploads
  land mid-session.
- Pull-to-refresh.
- Folder rail (drawer) — pick any folder to filter the grid by that
  subtree prefix; "(root)" picks NULL-`directoryPath` assets.
- Camera-roll capture + multipart upload via the FAB (uploads into
  the currently selected folder).
- Text search (filename / description / OCR).
- Sign out (clears the PAT).

## What's stubbed / out-of-scope for the scaffold

- **Background upload queue** — captures fail if the app backgrounds
  mid-upload. Wire Workmanager once we have platform shells to test
  lifecycle behaviour.
- **Asset detail view** — tile tap is a no-op today.
- **Search pagination** — `/api/v1/search` doesn't cursor yet.
- **CI on real devices** — separate session; needs a macOS runner for
  iOS, plus signing certs + provisioning profiles set up out-of-band.
- **Theme + branding** — using the Material 3 default seed.
- **Tests** — `flutter_test` is in dev deps but no specs yet.

## Auth notes

PATs are minted in the web UI at `/app/settings/tokens`. The mobile
client never speaks to `/api/v1/tokens` directly — session auth is the
only path that can mint a PAT, which keeps PAT → PAT escalation
impossible.

## Next sessions

Each of these is independently shippable:

1. **Background upload queue** so camera shots survive backgrounding
   (Workmanager — needs platform shells to test lifecycle).
2. **Asset detail view** — tap a tile → full-size + metadata + share /
   trash / favorite actions.
3. **Search pagination** — needs `/api/v1/search` to grow a cursor;
   trivial server change once it does.
4. **iOS / Android CI** — GitHub macOS runner; needs signing certs +
   provisioning profiles set up out-of-band. Android already builds on
   pushd (`.pushd.yaml`).
