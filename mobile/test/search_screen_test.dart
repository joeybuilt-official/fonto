// SPDX-License-Identifier: AGPL-3.0-only
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
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

  Future<FontoClient> buildClient() async {
    return FontoClient(
      // Only the tags endpoint is exercised by the filter sheet here; everything
      // else throws so an accidental network call surfaces loudly.
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        if (req.url.path.contains("/api/v1/tags/top")) {
          return http.Response(jsonEncode({"tags": []}), 200,
              headers: {"content-type": "application/json"});
        }
        throw UnimplementedError(req.url.toString());
      }),
    );
  }

  testWidgets("shows search field", (tester) async {
    final client = await buildClient();
    await tester.pumpWidget(MaterialApp(home: SearchScreen(client: client)));
    expect(find.byType(TextField), findsOneWidget);
    client.close();
  });

  testWidgets("shows semantic, OCR-only and filters chips", (tester) async {
    final client = await buildClient();
    await tester.pumpWidget(MaterialApp(home: SearchScreen(client: client)));

    expect(find.widgetWithText(FilterChip, "Semantic"), findsOneWidget);
    expect(find.widgetWithText(FilterChip, "OCR only"), findsOneWidget);
    expect(find.widgetWithText(ActionChip, "Filters"), findsOneWidget);
    client.close();
  });

  testWidgets("opening Filters reveals type/color/date/tag sections",
      (tester) async {
    final client = await buildClient();
    await tester.pumpWidget(MaterialApp(home: SearchScreen(client: client)));

    await tester.tap(find.widgetWithText(ActionChip, "Filters"));
    await tester.pumpAndSettle();

    expect(find.text("Type"), findsOneWidget);
    expect(find.text("Color"), findsOneWidget);
    expect(find.text("Date range"), findsOneWidget);
    expect(find.text("Tag"), findsOneWidget);
    expect(find.text("Camera"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, "Apply"), findsOneWidget);
    client.close();
  });
}
