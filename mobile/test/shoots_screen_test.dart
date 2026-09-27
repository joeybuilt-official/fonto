// SPDX-License-Identifier: MIT
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/shoots_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://fonto.example.com",
    });
  });

  Future<FontoClient> buildClient({required bool withShoots}) async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        if (req.url.path.contains("/api/v1/shoots")) {
          final body = withShoots
              ? {
                  "shoots": [
                    {
                      "id": "s1",
                      "name": "Smith Wedding",
                      "shootDate": "2025-06-01",
                      "clientId": null,
                      "kind": "wedding",
                      "counts": {"total": 42},
                    },
                  ],
                }
              : {"shoots": []};
          return http.Response(jsonEncode(body), 200,
              headers: {"content-type": "application/json"});
        }
        throw UnimplementedError(req.url.toString());
      }),
    );
  }

  testWidgets("lists shoots with name + count", (tester) async {
    final client = await buildClient(withShoots: true);
    await tester.pumpWidget(MaterialApp(home: ShootsScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.text("Smith Wedding"), findsOneWidget);
    expect(find.text("42"), findsOneWidget);
    client.close();
  });

  testWidgets("shows empty state when no shoots", (tester) async {
    final client = await buildClient(withShoots: false);
    await tester.pumpWidget(MaterialApp(home: ShootsScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.textContaining("No shoots"), findsOneWidget);
    client.close();
  });
}
