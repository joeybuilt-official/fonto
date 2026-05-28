// SPDX-License-Identifier: AGPL-3.0-only
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

import "package:app_links/app_links.dart";
import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";
import "package:workmanager/workmanager.dart";

import "src/api/fonto_client.dart";
import "src/api/models.dart";
import "src/screens/asset_detail_screen.dart";
import "src/screens/home_screen.dart";
import "src/screens/login_screen.dart";
import "src/state/auth_store.dart";
import "src/state/upload_queue.dart";
import "src/state/workmanager_dispatcher.dart";

final _navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await UploadQueue.open();
  await Workmanager().initialize(callbackDispatcher);
  final auth = await AuthStore.load();
  if (auth.isConfigured) {
    await registerUploadDrain();
  }
  runApp(FontoApp(auth: auth));
}

/// Idempotent — Workmanager dedupes by uniqueName.
Future<void> registerUploadDrain() async {
  await Workmanager().registerPeriodicTask(
    kUploadDrainTask,
    kUploadDrainTask,
    frequency: const Duration(minutes: 15),
    constraints: Constraints(
      networkType: NetworkType.connected,
      requiresBatteryNotLow: true,
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

  Future<void> _handleDeepLink(Uri uri) async {
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
        _navigatorKey.currentState?.push(
          MaterialPageRoute(
            builder: (_) => AssetDetailScreen(
              client: client,
              assets: [asset!],
              initialIndex: 0,
            ),
          ),
        );
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
      if (!navigated) client.close();
      // If navigated, client lives with AssetDetailScreen; GC'd when screen pops.
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4)),
      useMaterial3: true,
    );
    return MaterialApp(
      title: "Fonto",
      theme: theme,
      navigatorKey: _navigatorKey,
      home: _auth.isConfigured
          ? HomeScreen(auth: _auth, onSignOut: _handleSignOut)
          : LoginScreen(auth: _auth, onLoggedIn: _handleLoggedIn),
    );
  }

  void _handleLoggedIn() => setState(() {
        _auth = widget.auth;
      });

  void _handleSignOut() => setState(() {
        _auth = widget.auth;
      });
}
