// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto mobile client entry. Decides login vs home on boot by checking
// for a stored PAT + base URL. Auth state lives in SharedPreferences
// via AuthStore; screen swapping is just a Navigator replacement.
//
// Phase 6.5: AppLinks listener intercepts https://myfonto.com URIs:
//   /app/library?lb=<id>  → fetch asset by id → open AssetDetailScreen
//   /share/<token>        → resolve share → fetch asset → open AssetDetailScreen
// Ignored when user is not authenticated or asset is inaccessible.

import "dart:async";

import "package:app_links/app_links.dart";
import "package:firebase_core/firebase_core.dart";
import "package:firebase_messaging/firebase_messaging.dart";
import "package:flutter/material.dart";
import "package:flutter_foreground_task/flutter_foreground_task.dart";
import "package:flutter_local_notifications/flutter_local_notifications.dart";
import "package:shared_preferences/shared_preferences.dart";
import "package:url_launcher/url_launcher.dart";
import "package:workmanager/workmanager.dart";

import "src/api/fonto_client.dart";
import "src/api/models.dart";
import "src/screens/asset_detail_screen.dart";
import "src/screens/login_screen.dart";
import "src/screens/main_shell.dart";
import "src/state/auth_store.dart";
import "src/theme/app_theme.dart";
import "src/state/drive_download_queue.dart";
import "src/state/push_notifications.dart";
import "src/state/offline_prefetch.dart";
import "src/state/settings_store.dart";
import "src/state/sync_service.dart";
import "src/state/upload_queue.dart";
import "src/state/workmanager_dispatcher.dart";

// Must be top-level (FCM looks it up across the background isolate). The OS
// renders the notification itself; tap-routing happens via onMessageOpenedApp
// / getInitialMessage when the app comes to the foreground, so this is a no-op.
@pragma("vm:entry-point")
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {}

Future<void> _initLocalNotifications() async {
  final plugin = FlutterLocalNotificationsPlugin();
  await plugin.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings("@mipmap/ic_launcher"),
      iOS: DarwinInitializationSettings(),
    ),
  );
  // Pre-create the Drive import channel so its low-importance setting is
  // applied before the first notification fires (Android ignores importance
  // changes after a channel is created by a notification).
  await plugin
      .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>()
      ?.createNotificationChannel(
        const AndroidNotificationChannel(
          "fonto_drive_import",
          "Drive Import",
          description: "Background Google Drive import progress",
          importance: Importance.low,
          playSound: false,
          enableVibration: false,
        ),
      );
}

final _navigatorKey = GlobalKey<NavigatorState>();

// App-wide theme selection (system/light/dark). Persisted in SharedPreferences
// and surfaced live to MaterialApp via a ValueListenable so the Settings
// Appearance control flips the theme without a restart. Defaults to system.
final ValueNotifier<ThemeMode> themeModeNotifier =
    ValueNotifier<ThemeMode>(ThemeMode.system);
const _kThemeModeKey = "fonto.theme_mode";

ThemeMode _themeModeFromString(String? s) {
  switch (s) {
    case "light":
      return ThemeMode.light;
    case "dark":
      return ThemeMode.dark;
    default:
      return ThemeMode.system;
  }
}

String themeModeToString(ThemeMode m) => switch (m) {
      ThemeMode.light => "light",
      ThemeMode.dark => "dark",
      ThemeMode.system => "system",
    };

Future<ThemeMode> loadThemeMode() async {
  final p = await SharedPreferences.getInstance();
  return _themeModeFromString(p.getString(_kThemeModeKey));
}

Future<void> saveThemeMode(ThemeMode m) async {
  final p = await SharedPreferences.getInstance();
  await p.setString(_kThemeModeKey, themeModeToString(m));
  themeModeNotifier.value = m;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Cap decoded image cache at 60 MB. Default (100 MB) lets preview-size images
  // from AssetDetailScreen evict grid thumbnails, forcing reloads on back-nav.
  imageCache.maximumSizeBytes = 60 * 1024 * 1024;
  await UploadQueue.open();
  await DriveDownloadQueue.open();
  await _initLocalNotifications();
  // Foreground-service plumbing for reliable background sync (uploads + Drive
  // imports continue when the app is backgrounded/closed).
  FlutterForegroundTask.initCommunicationPort();
  SyncService.init();
  await Workmanager().initialize(callbackDispatcher);
  // Firebase init is best-effort: a platform without a config file (e.g. an
  // iOS build before GoogleService-Info.plist lands) must not brick startup.
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  } catch (_) {}
  themeModeNotifier.value = await loadThemeMode();
  final auth = await AuthStore.load();
  if (auth.isConfigured) {
    await registerUploadDrain();
    // Don't block first paint on permission dialogs / network.
    unawaited(PushNotifications.register(auth));
    // Populate the on-device offline cache (recent library + collections) so
    // the app has content with no internet. The metadata phase runs whenever
    // online regardless of the Wi-Fi-only setting; only image-byte warming is
    // Wi-Fi-gated. Best-effort, self-gated on connectivity, never blocks
    // startup, and re-triggered on reconnect/resume from home_screen.
    unawaited(OfflinePrefetch.run(auth));
  }
  runApp(FontoApp(auth: auth));
}

/// Idempotent — Workmanager dedupes by uniqueName. The foreground service does
/// the real draining; this periodic task is only a backstop. No
/// requiresBatteryNotLow (it just made the backstop fire less). Honours the
/// "Wi-Fi only" setting so the backstop never spends cellular data either.
Future<void> registerUploadDrain() async {
  final wifiOnly = await SettingsStore.getSyncWifiOnly();
  final chargingOnly = await SettingsStore.getSyncChargingOnly();
  await Workmanager().registerPeriodicTask(
    kUploadDrainTask,
    kUploadDrainTask,
    frequency: const Duration(minutes: 15),
    constraints: Constraints(
      networkType: wifiOnly ? NetworkType.unmetered : NetworkType.connected,
      requiresCharging: chargingOnly,
    ),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
  );
}

class FontoApp extends StatefulWidget {
  const FontoApp({super.key, required this.auth});

  final AuthStore auth;

  @override
  State<FontoApp> createState() => _FontoAppState();
}

class _FontoAppState extends State<FontoApp> {
  late AuthStore _auth = widget.auth;

  @override
  void initState() {
    super.initState();
    _initDeepLinks();
    _initPushTaps();
  }

  void _initDeepLinks() {
    final appLinks = AppLinks();
    // Cold start — app launched via link tap.
    appLinks.getInitialLink().then((uri) {
      if (uri != null) _handleDeepLink(uri);
    });
    // Warm start — app already running.
    appLinks.uriLinkStream.listen(_handleDeepLink);
  }

  void _initPushTaps() {
    // Cold start — app launched by tapping a notification.
    FirebaseMessaging.instance.getInitialMessage().then((m) {
      if (m != null) _handlePushTap(m);
    });
    // Warm start — notification tapped while app was backgrounded.
    FirebaseMessaging.onMessageOpenedApp.listen(_handlePushTap);
  }

  // Comment/share pushes carry { type, assetId, ... } — route to that asset's
  // detail view, reusing the same fetch path as deep links.
  Future<void> _handlePushTap(RemoteMessage message) async {
    final assetId = message.data["assetId"];
    if (assetId == null || assetId.isEmpty || !_auth.isConfigured) return;
    final client = FontoClient(_auth);
    try {
      final asset = await client.getAsset(assetId);
      final route = _navigatorKey.currentState?.push(
        MaterialPageRoute(
          builder: (_) => AssetDetailScreen(
            client: client,
            assets: [asset],
            initialIndex: 0,
          ),
        ),
      );
      // AssetDetailScreen doesn't own the client's lifecycle, and GC won't
      // close its keep-alive sockets — close it deterministically once the
      // pushed route pops (or immediately if the navigator wasn't available).
      if (route == null) {
        client.close();
      } else {
        unawaited(route.whenComplete(client.close));
      }
    } catch (_) {
      client.close();
    }
  }

  Future<void> _handleDeepLink(Uri uri) async {
    // M14 / ADR 0056 — OIDC handoff: the web minted a PAT after IdP login and
    // deep-linked it back. Handle BEFORE the configured-guard (the app isn't
    // logged in yet). Save it like a manually-pasted token, verify, go home.
    if (uri.path == "/mobile/auth-callback") {
      final pat = uri.queryParameters["pat"];
      if (pat != null && pat.isNotEmpty) {
        await _auth.save(pat: pat, baseUrl: uri.origin);
        final client = FontoClient(_auth);
        try {
          await client.stats();
          await registerUploadDrain();
          if (!mounted) return;
          _handleLoggedIn();
        } catch (_) {
          await _auth.clear();
        } finally {
          client.close();
        }
      }
      return;
    }

    if (!_auth.isConfigured) return;
    final client = FontoClient(_auth);
    bool navigated = false;
    try {
      Asset? asset;
      final segments = uri.pathSegments;

      if (uri.path == "/app/library" && uri.queryParameters.containsKey("lb")) {
        asset = await client.getAsset(uri.queryParameters["lb"]!);
      } else if (segments.length == 2 && segments[0] == "share") {
        final resolved = await client.resolveShare(segments[1]);
        if (resolved.targetType == "asset") {
          asset = await client.getAsset(resolved.targetId);
        } else {
          // Collection / set shares — fall back to browser.
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        }
      }

      if (asset != null) {
        navigated = true;
        final route = _navigatorKey.currentState?.push(
          MaterialPageRoute(
            builder: (_) => AssetDetailScreen(
              client: client,
              assets: [asset!],
              initialIndex: 0,
            ),
          ),
        );
        // Close the client once the detail route pops — AssetDetailScreen
        // doesn't own it, and GC won't reliably close its keep-alive sockets.
        if (route == null) {
          client.close();
        } else {
          unawaited(route.whenComplete(client.close));
        }
      }
    } on ApiException catch (e) {
      if (e.status == 403) {
        // Password-protected share — open in browser.
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
      // 404 / 410 → stale link, silently ignore.
    } catch (_) {
      // Network error or unknown — ignore.
    } finally {
      // When navigated, the client is closed via the route's whenComplete
      // above (deterministically, on pop). Only close here when we never
      // pushed a screen.
      if (!navigated) client.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeModeNotifier,
      builder: (context, mode, _) => MaterialApp(
        title: "Fonto",
        theme: FontoTheme.light(),
        darkTheme: FontoTheme.dark(),
        themeMode: mode,
        navigatorKey: _navigatorKey,
        home: _auth.isConfigured
            ? MainShell(auth: _auth, onSignOut: _handleSignOut)
            : LoginScreen(auth: _auth, onLoggedIn: _handleLoggedIn),
      ),
    );
  }

  void _handleLoggedIn() {
    setState(() => _auth = widget.auth);
    unawaited(PushNotifications.register(_auth));
  }

  void _handleSignOut() => setState(() {
        _auth = widget.auth;
      });
}
