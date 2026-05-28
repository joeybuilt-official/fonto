// SPDX-License-Identifier: AGPL-3.0-only
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/search_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://myfonto.com",
    });
  });

  testWidgets("shows search field", (tester) async {
    final auth = await AuthStore.load();
    final client = FontoClient(
      auth,
      httpClient: MockClient((_) async => throw UnimplementedError()),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: SearchScreen(client: client),
      ),
    );

    expect(find.byType(TextField), findsOneWidget);
    client.close();
  });
}
