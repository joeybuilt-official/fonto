// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Amazon Photos import — its own screen (web parity for /app/imports/amazon).
// Pick a .zip via file_picker and stream it to the raw-body upload endpoint.

import "dart:io";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";

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
  int _sent = 0;
  int _total = 0;
  UploadCancelToken? _cancelToken;

  Future<void> _pickAndUpload() async {
    if (_busy) return;
    HapticFeedback.mediumImpact();
    setState(() {
      _busy = true;
      _msg = null;
      _sent = 0;
      _total = 0;
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
      final token = UploadCancelToken();
      if (mounted) setState(() => _cancelToken = token);
      final workspaceId = await widget.client.workspaceId();
      await widget.client.uploadAmazonZip(
        File(path),
        workspaceId,
        cancelToken: token,
        onProgress: (sent, total) {
          if (!mounted) return;
          setState(() {
            _sent = sent;
            _total = total;
          });
        },
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      final cancelled = e is ApiException && e.status == 499;
      setState(() {
        _busy = false;
        _cancelToken = null;
        _msg = cancelled ? "Upload cancelled." : "Upload failed: $e";
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
          if (_busy) ...[
            const SizedBox(height: 16),
            UploadProgress(
              sent: _sent,
              total: _total,
              onCancel: _cancelToken?.cancel,
            ),
          ],
          if (_msg != null) ...[
            const SizedBox(height: 8),
            Text(
              _msg!,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Determinate ZIP-upload progress: percent + bytes + Cancel. Shared by the
/// Amazon and Takeout import screens. Shows an indeterminate bar until the
/// first byte-count arrives (total known).
class UploadProgress extends StatelessWidget {
  const UploadProgress({
    super.key,
    required this.sent,
    required this.total,
    this.onCancel,
  });

  final int sent;
  final int total;
  final VoidCallback? onCancel;

  static String _fmtBytes(int b) {
    if (b < 1024) return "$b B";
    if (b < 1024 * 1024) return "${(b / 1024).toStringAsFixed(0)} KB";
    if (b < 1024 * 1024 * 1024) {
      return "${(b / (1024 * 1024)).toStringAsFixed(1)} MB";
    }
    return "${(b / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB";
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final fraction = total > 0 ? (sent / total).clamp(0.0, 1.0) : null;
    final label = total > 0
        ? "${((fraction ?? 0) * 100).toStringAsFixed(0)}% · "
            "${_fmtBytes(sent)} / ${_fmtBytes(total)}"
        : "Preparing…";
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(value: fraction),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            if (onCancel != null)
              TextButton(onPressed: onCancel, child: const Text("Cancel")),
          ],
        ),
      ],
    );
  }
}
