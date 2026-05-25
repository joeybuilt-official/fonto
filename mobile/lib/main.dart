// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto mobile client entry. Decides login vs home on boot by checking
// for a stored PAT + base URL. Auth state lives in SharedPreferences
// via AuthStore; screen swapping is just a Navigator replacement.

import "package:flutter/material.dart";
import "package:workmanager/workmanager.dart";

import "src/state/auth_store.dart";
import "src/state/upload_queue.dart";
import "src/state/workmanager_dispatcher.dart";
import "src/screens/login_screen.dart";
import "src/screens/home_screen.dart";

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Open the upload DB eagerly so the cache is warm + schema migrations
  // run before any screen tries to enqueue.
  await UploadQueue.open();
  await Workmanager().initialize(callbackDispatcher, isInDebugMode: false);
  final auth = await AuthStore.load();
  // Register the periodic drain only if we're already signed in;
  // LoginScreen re-registers after first successful login.
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
    existingWorkPolicy: ExistingWorkPolicy.keep,
  );
}

class FontoApp extends StatefulWidget {
  const FontoApp({super.key, required this.auth});

  final AuthStore auth;

  @override
  State<FontoApp> createState() => _FontoAppState();
}

class _FontoAppState extends State<FontoApp> {
  @override
  Widget build(BuildContext context) {
    final theme = ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4)),
      useMaterial3: true,
    );
    return MaterialApp(
      title: "Fonto",
      theme: theme,
      home: widget.auth.isConfigured
          ? HomeScreen(auth: widget.auth, onSignOut: _handleSignOut)
          : LoginScreen(auth: widget.auth, onLoggedIn: _handleLoggedIn),
    );
  }

  void _handleLoggedIn() => setState(() {});
  void _handleSignOut() => setState(() {});
}
