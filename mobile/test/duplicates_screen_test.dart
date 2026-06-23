// SPDX-License-Identifier: AGPL-3.0-only
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/duplicates_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

Map<String, dynamic> _asset(String id) => {
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

  Future<FontoClient> buildClient({required bool withGroups}) async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        final json = {"content-type": "application/json"};
        if (req.url.path.endsWith("/api/v1/duplicates")) {
          final body = withGroups
              ? {
                  "groups": [
                    {
                      "groupId": "g1",
                      "confidence": 0.95,
                      "members": [_asset("a1"), _asset("a2")],
                    },
                  ],
                }
              : {"groups": []};
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

  testWidgets("renders a duplicate group with actions", (tester) async {
    final client = await buildClient(withGroups: true);
    await tester.pumpWidget(MaterialApp(home: DuplicatesScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.text("2 similar items"), findsOneWidget);
    expect(find.text("Keep best, trash rest"), findsOneWidget);
    expect(find.text("Not dupes"), findsOneWidget);
    client.close();
  });

  testWidgets("shows empty state when no duplicates", (tester) async {
    final client = await buildClient(withGroups: false);
    await tester.pumpWidget(MaterialApp(home: DuplicatesScreen(client: client)));
    await tester.pumpAndSettle();

    expect(find.textContaining("No duplicate groups"), findsOneWidget);
    client.close();
  });
}
