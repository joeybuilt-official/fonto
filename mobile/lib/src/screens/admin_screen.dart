// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-admin console (parity with the web console).
// Server stats + users + workspaces with an inline quota editor. Reached from
// Settings only when `adminMe()` is true; the /api/v1/admin/* routes enforce
// the tier server-side regardless.

import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../widgets/list_states.dart";

String _fmtBytes(num n) {
  if (n < 1024) return "${n.toInt()} B";
  const u = ["KB", "MB", "GB", "TB"];
  double v = n / 1024;
  int i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return "${v.toStringAsFixed(1)} ${u[i]}";
}

class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key, required this.client});
  final FontoClient client;

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _stats = {};
  List<Map<String, dynamic>> _users = [];
  List<Map<String, dynamic>> _workspaces = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        widget.client.adminServerStats(),
        widget.client.adminUsers(),
        widget.client.adminWorkspaces(),
      ]);
      if (!mounted) return;
      setState(() {
        _stats = results[0] as Map<String, dynamic>;
        _users = results[1] as List<Map<String, dynamic>>;
        _workspaces = results[2] as List<Map<String, dynamic>>;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : "Failed to load";
        _loading = false;
      });
    }
  }

  Future<void> _editQuota(Map<String, dynamic> ws) async {
    final current = ws["quotaBytes"] as int?;
    final controller = TextEditingController(
      text: current == null ? "" : (current / 1024 / 1024 / 1024).toStringAsFixed(1),
    );
    final String? gb;
    try {
      gb = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text("Quota — ${ws["name"]}"),
          content: TextField(
            controller: controller,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: "Quota (GB)",
              hintText: "Leave blank for unlimited",
              suffixText: "GB",
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("Cancel")),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text),
              child: const Text("Save"),
            ),
          ],
        ),
      );
    } finally {
      controller.dispose();
    }
    if (gb == null) return;
    // Validate before sending: a non-numeric typo ("abc") or a negative would
    // otherwise silently set a workspace to 0 bytes (blocks uploads) or worse.
    final trimmed = gb.trim();
    int? quotaBytes;
    if (trimmed.isNotEmpty) {
      final v = double.tryParse(trimmed);
      if (v == null || v < 0) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text("Enter a valid quota in GB, or leave blank for unlimited."),
          ),
        );
        return;
      }
      quotaBytes = (v * 1024 * 1024 * 1024).round();
    }
    try {
      await widget.client.adminSetQuota(ws["id"] as String, quotaBytes);
      if (!mounted) return;
      setState(() {
        ws["quotaBytes"] = quotaBytes;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't set quota: ${e is ApiException ? e.message : e}")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text("Instance admin")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              // Keep the failure state scrollable + inside a RefreshIndicator so
              // pull-to-refresh (and the Retry button) can recover a transient
              // network failure without backing out of the screen.
              ? RefreshIndicator(
                  onRefresh: _load,
                  child: LayoutBuilder(
                    builder: (context, constraints) => SingleChildScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minHeight: constraints.maxHeight),
                        child: ListErrorState(onRetry: _load, message: _error!),
                      ),
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    children: [
                      _statsCard(),
                      const _SectionHeader("Workspaces"),
                      if (_workspaces.isEmpty)
                        _emptyRow(theme, "No workspaces")
                      else
                        ..._workspaces.map(_workspaceTile),
                      const _SectionHeader("Users"),
                      if (_users.isEmpty)
                        _emptyRow(theme, "No users")
                      else
                        ..._users.map(_userTile),
                    ],
                  ),
                ),
    );
  }

  Widget _emptyRow(ThemeData theme, String label) => ListTile(
        title: Text(
          label,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );

  Widget _statsCard() {
    final theme = Theme.of(context);
    Widget stat(String label, String value) => Expanded(
          child: Column(
            children: [
              Text(value, style: theme.textTheme.titleMedium),
              Text(
                label,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        );
    final userCount = _stats["userCount"];
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          stat("Users", userCount == null ? "—" : "$userCount"),
          stat("Workspaces", "${_stats["workspaceCount"] ?? 0}"),
          stat("Assets", "${_stats["activeAssets"] ?? 0}"),
          stat("Storage", _fmtBytes((_stats["usageBytes"] ?? 0) as num)),
        ],
      ),
    );
  }

  Widget _workspaceTile(Map<String, dynamic> ws) {
    final quota = ws["quotaBytes"] as int?;
    final usage = (ws["usageBytes"] ?? 0) as num;
    return ListTile(
      title: Text(ws["name"] as String? ?? "—"),
      subtitle: Text(
        "${ws["ownerEmail"] ?? "—"} · ${_fmtBytes(usage)} used"
        "${quota != null ? " / ${_fmtBytes(quota)}" : ""}",
      ),
      trailing: TextButton(
        onPressed: () => _editQuota(ws),
        child: Text(quota == null ? "Set quota" : "Edit"),
      ),
    );
  }

  Widget _userTile(Map<String, dynamic> u) {
    final theme = Theme.of(context);
    return ListTile(
      title: Text(u["email"] as String? ?? u["id"] as String),
      subtitle: u["name"] != null ? Text(u["name"] as String) : null,
      trailing: Text(
        "${u["workspaceCount"] ?? 0} ws · ${_fmtBytes((u["usageBytes"] ?? 0) as num)}",
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        title,
        style: theme.textTheme.titleSmall?.copyWith(
          color: theme.colorScheme.primary,
        ),
      ),
    );
  }
}
