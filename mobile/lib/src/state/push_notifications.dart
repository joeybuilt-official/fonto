// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.4 — FCM token lifecycle. Requests notification permission, fetches
// the device's FCM token, registers it with the backend (POST
// /notifications/push-token), and keeps it fresh on rotation. Deregisters on
// sign-out. All methods are best-effort and never throw — push is a
// nice-to-have, not a blocker for any user flow.

import "dart:async";
import "dart:math";

import "package:firebase_messaging/firebase_messaging.dart";
import "package:shared_preferences/shared_preferences.dart";

import "../api/fonto_client.dart";
import "auth_store.dart";

class PushNotifications {
  static const _kDeviceId = "fonto.device_id";

  /// The single live onTokenRefresh subscription. register() is called on every
  /// launch and after login; each call would otherwise add a fresh listener to
  /// the broadcast stream, so a single token rotation fired N duplicate POSTs.
  /// We cancel any prior subscription before re-listening, keeping exactly one
  /// (bound to the latest auth/deviceId).
  static StreamSubscription<String>? _tokenRefreshSub;

  /// Stable per-install id so the backend upserts by (user, device) instead
  /// of piling up a new row every token rotation.
  static Future<String> _deviceId() async {
    final p = await SharedPreferences.getInstance();
    var id = p.getString(_kDeviceId);
    if (id == null) {
      final r = Random.secure();
      id = List.generate(
        16,
        (_) => r.nextInt(256).toRadixString(16).padLeft(2, "0"),
      ).join();
      await p.setString(_kDeviceId, id);
    }
    return id;
  }

  /// Request permission (no-op if already granted/denied), fetch the token,
  /// register it, and subscribe to refreshes. Safe to call on every launch
  /// and right after login.
  static Future<void> register(AuthStore auth) async {
    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;
      final token = await messaging.getToken();
      if (token == null) return;
      final deviceId = await _deviceId();
      await _send(auth, deviceId, token);
      // Re-register whenever FCM rotates the token. Cancel any prior listener
      // first so repeated register() calls don't stack duplicate subscriptions.
      await _tokenRefreshSub?.cancel();
      _tokenRefreshSub =
          messaging.onTokenRefresh.listen((t) => _send(auth, deviceId, t));
    } catch (_) {
      // Missing config (e.g. unconfigured platform), permission edge cases,
      // or transient network — none should surface to the user.
    }
  }

  static Future<void> _send(AuthStore auth, String deviceId, String token) async {
    final client = FontoClient(auth);
    try {
      await client.registerPushToken(deviceId: deviceId, token: token);
    } catch (_) {
    } finally {
      client.close();
    }
  }

  /// Deregister this device. Call BEFORE clearing auth — the DELETE needs the
  /// PAT. Also drops the local FCM token so a fresh one is minted next login.
  static Future<void> deregister(AuthStore auth) async {
    try {
      // Stop listening first: after sign-out a token rotation must not re-POST
      // with the auth we're about to clear.
      await _tokenRefreshSub?.cancel();
      _tokenRefreshSub = null;
      final deviceId = await _deviceId();
      final client = FontoClient(auth);
      try {
        await client.deregisterPushToken(deviceId: deviceId);
      } catch (_) {
      } finally {
        client.close();
      }
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }
}
