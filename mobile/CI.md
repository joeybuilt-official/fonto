# Fonto Mobile CI Runbook

## Overview

CI runs on **pushd** (`.pushd.yaml` at repo root). Two entries:

| Entry | Trigger | Produces |
|---|---|---|
| `android-release` | `v*` tag | signed `app-release.apk` (emailed) |
| `android-publish` | `release-v*` tag | signed APK + AAB (emailed, and pushed to Play internal as a draft) |

Both run in a Docker executor on `ghcr.io/cirruslabs/flutter:stable`, which ships
the Flutter SDK + Android SDK. The build clones `main`, decodes the keystore,
runs `flutter pub get`, then `flutter build apk --release` (and
`flutter build appbundle --release` for `android-publish`).

### Build trigger — tag-gated

`android-release` fires on a `v*` tag push; `android-publish` on a `release-v*`
tag push. To cut a build:

```bash
# land code on main as usual (no build fires)
git push origin main
# cut a build deliberately:
git tag v1.0.17        # pick the next version
git push origin v1.0.17
```

The tag globs live in each entry's `on:` block. A manual
`POST /builds {projectId, repoUrl, branch}` bypasses `on:` entirely, so an APK
can be built from any branch on demand.

The APK/AAB are emailed by the build's `deliver:` step; `android-publish`
additionally pushes an AAB to the Play internal track as a draft.

## Keystore rotation

Current keystore expires **2053-10-11** (alias: `fonto-upload`). To rotate:

1. Generate a new keystore:
   ```
   keytool -genkeypair -v -keystore fonto-upload.jks \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias fonto-upload
   ```
2. Store the `.jks` with the other deploy secrets (`chmod 600`). Never commit it.
3. Re-seed the four signing secrets in the fonto project's pushd secret store
   (`build.project_secrets`, AES-256-GCM at rest — the same four names in
   `ANDROID_KEYSTORE_SECRETS`):
   - `ANDROID_KEYSTORE_BASE64` — `base64 -w0 < fonto-upload.jks`
   - `ANDROID_KEYSTORE_PASSWORD` — keystore store password
   - `ANDROID_KEY_ALIAS` — signing key alias
   - `ANDROID_KEY_PASSWORD` — key password
4. Sign and publish a new release build to verify the chain before the old cert expires.

`ANDROID_KEYSTORE_PATH` is not a stored secret — it is a runtime path set inline
on the build steps (the decoded `.jks` in the build container's `/tmp`).

## 30-day cert monitor

N/A for Android upload keystores — the `fonto-upload` key does not expire until **2053-10-11**. No automated rotation reminder needed at this time.

## Build failure triage

| Symptom | Likely cause | Fix |
|---|---|---|
| Signing error / debug-signed APK | Keystore env vars missing or the secret did not resolve | Verify the four `ANDROID_KEYSTORE_*` / `ANDROID_KEY_*` secrets exist in the pushd project store and are all listed under `secrets:` |
| Keystore fails to decode | `ANDROID_KEYSTORE_BASE64` not valid base64 | Re-generate with `base64 -w0` and re-seed the secret |
| AAB not in artifacts | Wrong path in `.pushd.yaml` `artifacts:` | Globs are relative to the repo root (`mobile/build/app/outputs/...`); `**` does not recurse |
| `kotlin.jvm.target.validation.mode` warning noise | Builder image ships a JDK newer than the app's pinned Java 17 | Expected — the build relaxes the check to a warning (see `.pushd.yaml`) |
| Gradle sync error | AGP / Gradle version mismatch | Bump `build.gradle` `classpath` + `gradle-wrapper.properties` in tandem |

## Adding iOS CI (deferred)

`type: android` requires `executor: docker`, so iOS cannot reuse the flows above.
When iOS is undeferred it needs a macOS runner plus provisioning profiles and a
p12 signing cert set up out-of-band:

1. Provision the profile + p12 cert in the runner's keychain.
2. Script: `flutter build ipa --release --export-options-plist=ios/ExportOptions.plist`.
3. Artifact: `build/ios/ipa/*.ipa`.
4. Add an `ios/` directory with `Runner.xcodeproj`, `Podfile`, `Info.plist` (use
   `flutter create --platforms=ios` output as baseline).
