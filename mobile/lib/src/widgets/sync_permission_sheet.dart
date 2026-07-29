// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Bottom sheet that explains + requests the two Android reliability gates
// needed for sync to keep running in the background:
//   1. Notifications  — the foreground-service notification (Android 13+).
//   2. Battery optimization exemption — without it, Doze kills the service.
// Each "Enable" button opens the relevant system dialog/settings via the
// flutter_foreground_task helpers.

import "package:flutter/material.dart";

import "../state/sync_service.dart";

class SyncPermissionSheet extends StatefulWidget {
  const SyncPermissionSheet({super.key});

  /// Show the sheet only when something still needs enabling. Returns when the
  /// sheet is dismissed. Safe to call from any screen.
  static Future<void> maybePrompt(BuildContext context) async {
    if (await SyncService.isFullyEnabled()) return;
    if (!context.mounted) return;
    await show(context);
  }

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => const SyncPermissionSheet(),
    );
  }

  @override
  State<SyncPermissionSheet> createState() => _SyncPermissionSheetState();
}

class _SyncPermissionSheetState extends State<SyncPermissionSheet> {
  bool _notif = false;
  bool _battery = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final notif = await SyncService.hasNotificationPermission();
    final battery = await SyncService.isBatteryOptimizationExempt();
    if (!mounted) return;
    setState(() {
      _notif = notif;
      _battery = battery;
      _loading = false;
    });
  }

  Future<void> _enableNotif() async {
    await SyncService.requestNotificationPermission();
    await _refresh();
  }

  Future<void> _enableBattery() async {
    await SyncService.requestBatteryOptimizationExempt();
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text("Keep sync running in the background",
                style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              "Android needs two permissions so your photo backups and Drive "
              "imports keep going when Fonto is closed or in the background.",
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 20),
            if (_loading)
              const Center(child: Padding(
                padding: EdgeInsets.all(16), child: CircularProgressIndicator()))
            else ...[
              _Gate(
                icon: Icons.notifications_active_outlined,
                title: "Notifications",
                subtitle:
                    "Shows the sync progress notification while it runs.",
                enabled: _notif,
                onEnable: _enableNotif,
              ),
              const SizedBox(height: 12),
              _Gate(
                icon: Icons.battery_saver_outlined,
                title: "Unrestricted battery",
                subtitle:
                    "Stops Android from pausing sync to save battery. This is "
                    "the important one for background reliability.",
                enabled: _battery,
                onEnable: _enableBattery,
              ),
            ],
            const SizedBox(height: 20),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: Text(_notif && _battery ? "Done" : "Not now"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Gate extends StatelessWidget {
  const _Gate({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.enabled,
    required this.onEnable,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool enabled;
  final Future<void> Function() onEnable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: theme.colorScheme.primary),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: theme.textTheme.titleMedium),
              const SizedBox(height: 2),
              Text(subtitle,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            ],
          ),
        ),
        const SizedBox(width: 12),
        if (enabled)
          const Icon(Icons.check_circle, color: Colors.green)
        else
          FilledButton.tonal(onPressed: onEnable, child: const Text("Enable")),
      ],
    );
  }
}
