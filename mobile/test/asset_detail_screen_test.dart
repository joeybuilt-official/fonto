// SPDX-License-Identifier: MIT
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/api/models.dart";
import "package:fonto_mobile/src/screens/asset_detail_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://myfonto.com",
    });
  });

  testWidgets("shows asset filename", (tester) async {
    final auth = await AuthStore.load();
    final client = FontoClient(
      auth,
      httpClient: MockClient((_) async => throw UnimplementedError()),
    );
    final fakeAsset = Asset(
      id: "asset-1",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      createdAt: DateTime.utc(2026, 1, 1),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: AssetDetailScreen(
          client: client,
          assets: [fakeAsset],
          initialIndex: 0,
        ),
      ),
    );

    expect(find.text("photo.jpg"), findsOneWidget);
    client.close();
  });
}
