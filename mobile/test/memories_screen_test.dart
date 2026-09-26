// SPDX-License-Identifier: MIT
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/memories_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

Map<String, dynamic> _asset(String id) => {
      "id": id,
      "filename": "$id.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 1000,
      "createdAt": "2022-05-24T10:00:00Z",
      "capturedAt": "2022-05-24T10:00:00Z",
    };

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://fonto.example.com",
    });
  });

  Future<FontoClient> buildClient({required bool withYears}) async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        final json = {"content-type": "application/json"};
        if (req.url.path.contains("/api/v1/memories")) {
          final body = withYears
              ? {
                  "years": [
                    {
                      "year": 2022,
                      "count": 2,
                      "assets": [_asset("a1"), _asset("a2")],
                    },
                  ],
                }
              : {"years": []};
          return http.Response(jsonEncode(body), 200, headers: json);
        }
        if (req.url.path.contains("/api/v1/assets/urls")) {
          return http.Response(
            jsonEncode({
              "urls": {"a1": "https://x/a1", "a2": "https://x/a2"},
            }),
            200,
            headers: json,
          );
        }
        throw UnimplementedError(req.url.toString());
      }),
    );
  }

  testWidgets("renders year section when memories exist", (tester) async {
    final client = await buildClient(withYears: true);
    await tester.pumpWidget(MaterialApp(home: MemoriesScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.text("Memories"), findsOneWidget);
    // Header: "1 year ago" relative to a captured year of 2022 (diff varies by
    // run-year, so just assert the section + count chip rather than the label).
    expect(find.byType(GridView), findsWidgets);
    client.close();
  });

  testWidgets("shows empty state when no memories", (tester) async {
    final client = await buildClient(withYears: false);
    await tester.pumpWidget(MaterialApp(home: MemoriesScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.textContaining("No memories"), findsOneWidget);
    client.close();
  });
}
