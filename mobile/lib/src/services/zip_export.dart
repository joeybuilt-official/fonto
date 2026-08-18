// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M8 — bulk zip export (ADR 0011). Downloads the server-streamed zip to a temp
// file via [FontoClient.downloadExportZip], then hands it to the native share
// sheet so the user can save it to Files/Drive or send it on. Pass either
// [ids] (multi-select) or [collectionId] (whole collection).

import "package:flutter/material.dart";
import "package:share_plus/share_plus.dart";

import "../api/fonto_client.dart";

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
  messenger.showSnackBar(
    SnackBar(
      content: Text(
        scope == "workspace" ? "Preparing full library export…" : "Preparing export…",
      ),
    ),
  );
  try {
    final file = await client.downloadExportZip(
      ids: ids,
      collectionId: collectionId,
      scope: scope,
    );
    // The download is the part that can fail meaningfully; confirm it before
    // handing off, so a cancelled share sheet doesn't read as a failed export.
    // Without this the last thing the user ever saw was "Preparing export…".
    // hideCurrentSnackBar first: SnackBars queue, so otherwise this one waits
    // out the full 4s of "Preparing export…" and surfaces behind the native
    // share sheet, i.e. after the moment it was meant to describe.
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      const SnackBar(content: Text("Export ready — choose where to save it.")),
    );
    await Share.shareXFiles(
      [XFile(file.path, mimeType: "application/zip")],
      subject: "Fonto export",
    );
  } on ApiException catch (e) {
    messenger.showSnackBar(
      SnackBar(content: Text("Export failed: ${e.message}")),
    );
  } catch (_) {
    messenger.showSnackBar(
      const SnackBar(content: Text("Export failed")),
    );
  }
}
