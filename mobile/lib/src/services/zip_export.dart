// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M8 — bulk zip export (ADR 0011). Downloads the server-streamed zip to a temp
// file via [FontoClient.downloadExportZip], then hands it to the native share
// sheet so the user can save it to Files/Drive or send it on. Pass either
// [ids] (multi-select) or [collectionId] (whole collection).

import "package:flutter/material.dart";
import "package:share_plus/share_plus.dart";

import "../api/fonto_client.dart";
import "../theme/tokens.dart";

Future<void> exportAndShareZip(
  BuildContext context,
  FontoClient client, {
  List<String>? ids,
  String? collectionId,
  // M14 / ADR 0057 — pass "workspace" to export the whole library (manifest +
  // every original), no entry cap.
  String? scope,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context, rootNavigator: true);

  // A whole-library export streams the entire library to disk with no progress
  // signal — for a multi-GB library that can take minutes. Hold a
  // non-dismissable progress dialog until the download resolves so the app
  // doesn't look frozen and the user can't fire a second export.
  var dialogOpen = true;
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => PopScope(
      canPop: false,
      child: AlertDialog(
        content: Row(
          children: [
            const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: FontoSpace.s4),
            Expanded(
              child: Text(
                scope == "workspace"
                    ? "Preparing full library export…"
                    : "Preparing export…",
              ),
            ),
          ],
        ),
      ),
    ),
  );
  void closeDialog() {
    if (dialogOpen) {
      dialogOpen = false;
      navigator.pop();
    }
  }

  try {
    final file = await client.downloadExportZip(
      ids: ids,
      collectionId: collectionId,
      scope: scope,
    );
    closeDialog();
    await Share.shareXFiles(
      [XFile(file.path, mimeType: "application/zip")],
      subject: "Fonto export",
    );
    // The zip lives in the temp dir; a multi-GB library export would otherwise
    // leave gigabytes behind on every run. Best-effort cleanup after sharing.
    try {
      await file.delete();
    } catch (_) {}
  } on ApiException catch (e) {
    closeDialog();
    messenger.showSnackBar(
      SnackBar(content: Text("Export failed: ${e.message}")),
    );
  } catch (_) {
    closeDialog();
    messenger.showSnackBar(
      const SnackBar(content: Text("Export failed")),
    );
  }
}
