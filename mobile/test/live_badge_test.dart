// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — LIVE badge + motion-photo model widget tests.

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:fonto_mobile/src/api/models.dart";
import "package:fonto_mobile/src/widgets/live_badge.dart";

void main() {
  testWidgets("LiveBadge renders the LIVE label", (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: LiveBadge())),
    );
    expect(find.text("LIVE"), findsOneWidget);
    expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
  });

  testWidgets("LiveBadge compact variant still renders the label", (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: LiveBadge(compact: true))),
    );
    expect(find.text("LIVE"), findsOneWidget);
  });

  test("Asset.motionPhoto parses from JSON + defaults false", () {
    final on = Asset.fromJson({
      "id": "a1",
      "filename": "PXL_0001.MP.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 10,
      "createdAt": "2026-06-23T00:00:00.000Z",
      "motionPhoto": true,
    });
    expect(on.motionPhoto, isTrue);

    final off = Asset.fromJson({
      "id": "a2",
      "filename": "plain.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 10,
      "createdAt": "2026-06-23T00:00:00.000Z",
    });
    expect(off.motionPhoto, isFalse);
  });
}
