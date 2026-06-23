// SPDX-License-Identifier: AGPL-3.0-only
// M8 — slideshow control on the asset detail screen.
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/api/models.dart";
import "package:fonto_mobile/src/screens/asset_detail_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

Map<String, dynamic> _assetJson(String id) => {
      "id": id,
      "filename": "$id.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 1000,
      "createdAt": "2022-05-24T10:00:00Z",
    };

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://myfonto.com",
    });
  });

  Future<FontoClient> buildClient() async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        final headers = {"content-type": "application/json"};
        if (req.url.path.contains("/api/v1/assets/urls")) {
          return http.Response(
            jsonEncode({
              "urls": {"a1": "https://x/a1", "a2": "https://x/a2"},
            }),
            200,
            headers: headers,
          );
        }
        if (req.url.path.contains("/faces")) {
          return http.Response(jsonEncode({"faces": []}), 200, headers: headers);
        }
        return http.Response(jsonEncode({}), 200, headers: headers);
      }),
    );
  }

  testWidgets("slideshow play/pause toggles with >1 asset", (tester) async {
    final client = await buildClient();
    final assets = [
      Asset.fromJson(_assetJson("a1")),
      Asset.fromJson(_assetJson("a2")),
    ];
    await tester.pumpWidget(MaterialApp(
      home: AssetDetailScreen(client: client, assets: assets, initialIndex: 0),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // Idle: play button is shown, pause is not.
    expect(find.byIcon(Icons.play_circle_outline), findsOneWidget);
    expect(find.byIcon(Icons.pause_circle_outline), findsNothing);

    // Start the slideshow → pause button appears.
    await tester.tap(find.byIcon(Icons.play_circle_outline));
    await tester.pump();
    expect(find.byIcon(Icons.pause_circle_outline), findsOneWidget);

    // Stop it again (also cancels the pending periodic timer for the test).
    await tester.tap(find.byIcon(Icons.pause_circle_outline));
    await tester.pump();
    expect(find.byIcon(Icons.play_circle_outline), findsOneWidget);

    client.close();
  });

  testWidgets("no slideshow control for a single asset", (tester) async {
    final client = await buildClient();
    final assets = [Asset.fromJson(_assetJson("a1"))];
    await tester.pumpWidget(MaterialApp(
      home: AssetDetailScreen(client: client, assets: assets, initialIndex: 0),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byIcon(Icons.play_circle_outline), findsNothing);
    client.close();
  });
}
