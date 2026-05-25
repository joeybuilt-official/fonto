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
  pubspec.yaml             # http, shared_preferences, image_picker,
                           # cached_network_image
  analysis_options.yaml
  lib/
    main.dart              # MaterialApp + login-vs-home swap
    src/
      api/
        fonto_client.dart  # PAT-auth HTTP client
        models.dart        # Asset, WorkspaceStats
      state/
        auth_store.dart    # SharedPreferences-backed PAT + base URL
      screens/
        login_screen.dart  # PAT form, validates against /api/v1/stats
        home_screen.dart   # stats bar + 3-col asset grid + camera FAB
```

## What works after bootstrap

- PAT login (saved across launches via SharedPreferences).
- Stats bar + first 60 assets w/ cached thumbnails.
- Camera-roll capture + multipart upload via the FAB.
- Sign out (clears PAT).

## What's stubbed / out-of-scope for the scaffold

- **Pagination** — first page only. Wire `/api/v1/sync/assets?cursor=`
  next.
- **Folder browse** — flat grid. Add a left-drawer rail mirroring the
  web folder tree.
- **Search** — TextField + `/api/v1/search`.
- **Secure storage** — PAT lives in plain SharedPreferences. Move to
  `flutter_secure_storage` once we add biometric gate.
- **CI on real devices** — separate session; needs Codemagic or
  GitHub Actions w/ macOS runners for iOS.
- **Theme + branding** — using the Material 3 default seed.
- **Tests** — `flutter_test` is in dev deps but no specs yet.

## Auth notes

PATs are minted in the web UI at `/app/settings/tokens`. The mobile
client never speaks to `/api/v1/tokens` directly — session auth is the
only path that can mint a PAT, which keeps PAT → PAT escalation
impossible.

## Next sessions

Each of these is independently shippable:

1. **Cursor pagination + pull-to-refresh** on the asset grid.
2. **Folder rail** mirroring the web tree (`/api/v1/folders/tree`).
3. **Search bar + results screen** (`/api/v1/search?q=`).
4. **Background upload queue** so camera shots survive backgrounding.
5. **iOS / Android CI** — Codemagic or GitHub macOS runner; needs
   signing certs + provisioning profiles set up out-of-band.
