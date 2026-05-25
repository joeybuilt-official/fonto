// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// PAT + base URL persistence. Mirrors the CLI's `conf`-based store:
// the user mints a PAT in the web UI (/app/settings/tokens) and
// pastes it into the login form. SharedPreferences is the simplest
// cross-platform key/value bucket; secure-storage upgrade is a
// follow-up once we add biometric gating.

import "package:shared_preferences/shared_preferences.dart";

class AuthStore {
  AuthStore._(this._prefs);

  static const _kPat = "fonto.pat";
  static const _kBaseUrl = "fonto.baseUrl";
  static const defaultBaseUrl = "https://myfonto.com";

  final SharedPreferences _prefs;

  static Future<AuthStore> load() async {
    final prefs = await SharedPreferences.getInstance();
    return AuthStore._(prefs);
  }

  String? get pat => _prefs.getString(_kPat);
  String get baseUrl => _prefs.getString(_kBaseUrl) ?? defaultBaseUrl;
  bool get isConfigured => (pat ?? "").isNotEmpty;

  Future<void> save({required String pat, required String baseUrl}) async {
    await _prefs.setString(_kPat, pat);
    await _prefs.setString(_kBaseUrl, baseUrl);
  }

  Future<void> clear() async {
    await _prefs.remove(_kPat);
    await _prefs.remove(_kBaseUrl);
  }
}
