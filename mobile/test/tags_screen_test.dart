// SPDX-License-Identifier: MIT
// M10 / ADR 0013 — Manage tags tree screen.
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/tags_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

// Travel (root) → 2018 (child). Paths are id-based, trailing-slashed.
List<Map<String, dynamic>> _twoLevel() => [
      {"id": "travel", "name": "travel", "color": "#6366f1", "parentId": null, "path": "/travel/"},
      {"id": "y2018", "name": "2018", "color": "#6366f1", "parentId": "travel", "path": "/travel/y2018/"},
    ];

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://fonto.example.com",
    });
  });

  Future<FontoClient> client(List<Map<String, dynamic>> tags) async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        final h = {"content-type": "application/json"};
        if (req.url.path.endsWith("/api/v1/tags") && req.method == "GET") {
          return http.Response(jsonEncode({"tags": tags}), 200, headers: h);
        }
        return http.Response(jsonEncode({}), 200, headers: h);
      }),
    );
  }

  testWidgets("renders a nested tag tree", (tester) async {
    final c = await client(_twoLevel());
    await tester.pumpWidget(MaterialApp(home: TagsScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.text("travel"), findsOneWidget);
    expect(find.text("2018"), findsOneWidget);
    c.close();
  });

  testWidgets("collapsing a parent hides its children", (tester) async {
    final c = await client(_twoLevel());
    await tester.pumpWidget(MaterialApp(home: TagsScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.text("2018"), findsOneWidget);
    await tester.tap(find.byIcon(Icons.expand_more));
    await tester.pumpAndSettle();
    expect(find.text("2018"), findsNothing);
    expect(find.text("travel"), findsOneWidget);
    c.close();
  });

  testWidgets("empty state when there are no tags", (tester) async {
    final c = await client(const []);
    await tester.pumpWidget(MaterialApp(home: TagsScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.textContaining("No tags yet"), findsOneWidget);
    c.close();
  });
}
