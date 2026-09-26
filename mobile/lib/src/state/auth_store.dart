// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// PAT + base URL persistence. Hardware-backed: iOS Keychain on iOS,
// Android Keystore on Android (via flutter_secure_storage). The PAT
// grants full /api/v1 access, so SharedPreferences (plain shared_prefs
// XML on Android, NSUserDefaults on iOS) was an unacceptable place to
// keep it. Load is async because every read decrypts; values are
// cached on the instance after load so screen builds stay sync.

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";

class AuthStore {
  AuthStore._(this._storage, this._pat, this._baseUrl);

  static const _kPat = "fonto.pat";
  static const _kBaseUrl = "fonto.baseUrl";
  /// Default instance the login form pre-fills.
  ///
  /// Supplied at BUILD time — `flutter build apk --dart-define=FONTO_BASE_URL=https://fonto.example.com`
  /// (see .pushd.yaml / mobile/CI.md). There is deliberately no production
  /// hostname compiled into the public repo: the fallback is localhost so an
  /// unconfigured build points at a dev server rather than somebody else's.
  static const defaultBaseUrl = String.fromEnvironment(
    "FONTO_BASE_URL",
    defaultValue: "http://localhost:3500",
  );

  // Android Documents Provider auth bridge. Best-effort; ignores errors
  // on non-Android platforms and if the channel is not yet registered.
  static const _kBridge =
      MethodChannel("com.joeybuilt.fonto/auth_bridge");

  static const _androidOpts = AndroidOptions(encryptedSharedPreferences: true);
  static const _iosOpts = IOSOptions(
    accessibility: KeychainAccessibility.first_unlock,
  );

  final FlutterSecureStorage _storage;
  String? _pat;
  String _baseUrl;

  static Future<AuthStore> load() async {
    const storage = FlutterSecureStorage(
      aOptions: _androidOpts,
      iOptions: _iosOpts,
    );
    final pat = await storage.read(key: _kPat);
    final baseUrl = await storage.read(key: _kBaseUrl);
    return AuthStore._(storage, pat, baseUrl ?? defaultBaseUrl);
  }

  String? get pat => _pat;
  String get baseUrl => _baseUrl;
  bool get isConfigured => (_pat ?? "").isNotEmpty;

  Future<void> save({required String pat, required String baseUrl}) async {
    await _storage.write(key: _kPat, value: pat);
    await _storage.write(key: _kBaseUrl, value: baseUrl);
    _pat = pat;
    _baseUrl = baseUrl;
    if (defaultTargetPlatform == TargetPlatform.android) {
      try {
        await _kBridge.invokeMethod<void>(
          "saveAuth",
          {"pat": pat, "baseUrl": baseUrl},
        );
      } catch (_) {}
    }
  }

  Future<void> clear() async {
    await _storage.delete(key: _kPat);
    await _storage.delete(key: _kBaseUrl);
    _pat = null;
    _baseUrl = defaultBaseUrl;
    if (defaultTargetPlatform == TargetPlatform.android) {
      try {
        await _kBridge.invokeMethod<void>("clearAuth");
      } catch (_) {}
    }
  }
}
