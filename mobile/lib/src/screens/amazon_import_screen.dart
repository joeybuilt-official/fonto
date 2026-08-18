// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Amazon Photos import — its own screen (web parity for /app/imports/amazon).
// Pick a .zip via file_picker and stream it to the raw-body upload endpoint.

import "dart:io";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";

class AmazonImportScreen extends StatefulWidget {
  const AmazonImportScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<AmazonImportScreen> createState() => _AmazonImportScreenState();
}

class _AmazonImportScreenState extends State<AmazonImportScreen> {
  bool _busy = false;
  String? _msg;

  Future<void> _pickAndUpload() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      final picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ["zip"],
        withData: false,
      );
      final path = picked?.files.single.path;
      if (path == null) {
        if (mounted) setState(() => _busy = false);
        return; // User cancelled the picker.
      }
      final workspaceId = await widget.client.workspaceId();
      await widget.client.uploadAmazonZip(File(path), workspaceId);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _msg = "Upload failed: $e";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Amazon Photos")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            "Upload a .zip exported from Amazon Photos. The file streams "
            "directly to the server.",
            style: TextStyle(fontSize: 13),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _busy ? null : _pickAndUpload,
            icon: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.upload_file),
            label: Text(_busy ? "Uploading…" : "Choose .zip & import"),
          ),
          if (_msg != null) ...[
            const SizedBox(height: 8),
            Text(_msg!, style: const TextStyle(fontSize: 12)),
          ],
        ],
      ),
    );
  }
}
