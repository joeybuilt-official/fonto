// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-admin console (parity with the web console).
// Server stats + users + workspaces with an inline quota editor. Reached from
// Settings only when `adminMe()` is true; the /api/v1/admin/* routes enforce
// the tier server-side regardless.

import "package:flutter/material.dart";

import "../api/fonto_client.dart";

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
    final gb = await showDialog<String>(
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
    if (gb == null) return;
    final quotaBytes =
        gb.trim().isEmpty ? null : (double.tryParse(gb.trim()) ?? 0) * 1024 * 1024 * 1024;
    try {
      await widget.client.adminSetQuota(ws["id"] as String, quotaBytes?.round());
      if (!mounted) return;
      setState(() {
        ws["quotaBytes"] = quotaBytes?.round();
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
    return Scaffold(
      appBar: AppBar(title: const Text("Instance admin")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    children: [
                      _statsCard(),
                      const _SectionHeader("Workspaces"),
                      ..._workspaces.map(_workspaceTile),
                      const _SectionHeader("Users"),
                      ..._users.map(_userTile),
                    ],
                  ),
                ),
    );
  }

  Widget _statsCard() {
    Widget stat(String label, String value) => Expanded(
          child: Column(
            children: [
              Text(value,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              Text(label, style: const TextStyle(fontSize: 12)),
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
    return ListTile(
      title: Text(u["email"] as String? ?? u["id"] as String),
      subtitle: u["name"] != null ? Text(u["name"] as String) : null,
      trailing: Text(
        "${u["workspaceCount"] ?? 0} ws · ${_fmtBytes((u["usageBytes"] ?? 0) as num)}",
        style: const TextStyle(fontSize: 12),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }
}
