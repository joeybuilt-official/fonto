// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Google Takeout import — its own screen (web parity for /app/imports/google).
// Paste a Google Drive link (or bare file ID) of the Takeout archive; we
// extract the ID and kick a server-side import.

import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../util/drive_link.dart";

class TakeoutImportScreen extends StatefulWidget {
  const TakeoutImportScreen({
    super.key,
    required this.client,
    required this.googleConnected,
  });

  final FontoClient client;
  final bool googleConnected;

  @override
  State<TakeoutImportScreen> createState() => _TakeoutImportScreenState();
}

class _TakeoutImportScreenState extends State<TakeoutImportScreen> {
  final _controller = TextEditingController();
  bool _busy = false;
  String? _msg;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    if (_busy) return;
    final id = parseDriveFileId(_controller.text);
    if (id == null) {
      setState(() => _msg =
          "That doesn't look like a Google Drive link or file ID. Paste the link to your Takeout archive in Drive.");
      return;
    }
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await widget.client.startGoogleTakeoutImport(id);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _msg = "Failed: $e";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final id = parseDriveFileId(_controller.text);
    return Scaffold(
      appBar: AppBar(title: const Text("Google Takeout")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (!widget.googleConnected)
            const Text(
              "Connect Google on the Imports screen first, then come back here.",
              style: TextStyle(fontSize: 13),
            )
          else ...[
            const Text(
              "How to get the link",
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            const Text(
              "1. In Google Takeout, choose \"Add to Drive\" as the destination.\n"
              "2. Open the archive in Google Drive and copy its link "
              "(Share → Copy link, or the address bar URL).\n"
              "3. Paste it below.",
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              enabled: !_busy,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                labelText: "Google Drive link",
                hintText: "https://drive.google.com/file/d/…",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _controller.text.trim().isNotEmpty && id == null
                  ? "Couldn't find a Drive file ID in that text."
                  : id != null
                      ? "Detected file ID: $id"
                      : " ",
              style: const TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: (!_busy && id != null) ? _start : null,
              child: Text(_busy ? "Starting…" : "Start import"),
            ),
            if (_msg != null) ...[
              const SizedBox(height: 8),
              Text(_msg!, style: const TextStyle(fontSize: 12)),
            ],
          ],
        ],
      ),
    );
  }
}
