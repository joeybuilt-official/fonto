# Fonto Mobile CI Runbook

## Overview

CI runs on Codemagic (`codemagic.yaml` at repo root). Single workflow: `android-release`.
Steps: `flutter pub get` → `flutter analyze` → `flutter test` → `flutter build appbundle --release`.
Artifact: `app-release.aab` + `app-release.apk`.

### Build trigger — tag-gated (since 2026-05-29)

Builds fire **only** when a `v*` git tag is pushed — not on plain commits.
This stops intermediate sub-phase pushes from burning CI minutes. Workflow:

```bash
# land code on main as usual (no build fires)
git push origin main
# cut a build deliberately:
git tag v1.0.17        # pick the next version
git push origin v1.0.17
```

After the green build, republish the APK to `<YOUR_APP_ORIGIN>/fonto.apk` per
the recipe in `docs/claude/platform/hive-deploy-runbook.md`. To go back to push-triggered,
restore the `events: [push, pull_request]` + `changeset: mobile/**` block
in `codemagic.yaml`.

## Keystore rotation

Current keystore expires **2053-10-11** (alias: `fonto-upload`). To rotate:

1. On NAS, generate a new keystore:
   ```
   keytool -genkeypair -v -keystore fonto-upload.jks \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias fonto-upload
   ```
2. Store at `<host-path>/secrets/fonto-keystore/fonto-upload.jks` (`chmod 600`).
3. In Codemagic → App Settings → Code signing → Android, upload the new `.jks` under the reference name `fonto_upload_keystore`.
4. Update `CM_STORE_PASSWORD`, `CM_KEY_ALIAS`, `CM_KEY_PASSWORD` environment variables in Codemagic to match.
5. Sign and publish a new release build to verify the chain before the old cert expires.

## 30-day cert monitor

N/A for Android upload keystores — the `fonto-upload` key does not expire until **2053-10-11**. No automated rotation reminder needed at this time.

## Build failure triage

| Symptom | Likely cause | Fix |
|---|---|---|
| `flutter analyze` fails | Lint error in `lib/` | Run `flutter analyze` locally, fix errors |
| `flutter test` fails | Widget test regression | Check `flutter test --reporter=expanded` output |
| Signing error | Keystore env vars missing | Verify `CM_KEYSTORE_PATH` etc. in Codemagic env |
| AAB not in artifacts | Wrong `working_directory` | Confirm path relative to repo root |
| Gradle sync error | AGP / Gradle version mismatch | Bump `build.gradle` `classpath` + `gradle-wrapper.properties` in tandem |

## Adding iOS CI (deferred)

When iOS is undeferred:

1. Add provisioning profile + p12 cert to Codemagic code signing.
2. Add `ios-release` workflow to `codemagic.yaml` with `xcode: latest` + `cocoapods: default`.
3. Script: `flutter build ipa --release --export-options-plist=ios/ExportOptions.plist`.
4. Artifact: `build/ios/ipa/*.ipa`.
5. Add `ios/` directory with `Runner.xcodeproj`, `Podfile`, `Info.plist` (use `flutter create --platforms=ios` output as baseline).
