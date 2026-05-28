# Fonto Mobile CI Runbook

## Overview

CI runs on Codemagic (`codemagic.yaml` at repo root). Single workflow: `android-release`.
Steps: `flutter pub get` → `flutter analyze` → `flutter test` → `flutter build appbundle --release`.
Artifact: `app-release.aab`. Triggers on push + PR to `main`.

## Keystore rotation

Current keystore expires **2053-10-11** (alias: `fonto-upload`). To rotate:

1. On NAS, generate a new keystore:
   ```
   keytool -genkeypair -v -keystore fonto-upload.jks \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias fonto-upload
   ```
2. Store at `/data/_secrets/fonto-keystore/fonto-upload.jks`.
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
