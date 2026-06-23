// SPDX-License-Identifier: AGPL-3.0-only
// M15.3 — Tidy Up reason-bucket review screen.
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:fonto_mobile/src/api/fonto_client.dart";
import "package:fonto_mobile/src/screens/tidy_up_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

Map<String, dynamic> _conflictBucket() => {
      "bucketId": "conflict:exif",
      "evidenceSource": "exif",
      "conflict": true,
      "reasonLabel": "From the photo's own info — disagrees with the saved date",
      "count": 1204,
      "confidenceTier": "high",
      "sample": [
        {
          "assetId": "a1",
          "filename": "a1.jpg",
          "capturedAt": "2019-03-01T00:00:00Z",
          "mapEstimate": "2018-07-01",
          "mapPrecision": "month",
        },
      ],
    };

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://myfonto.com",
    });
  });

  Future<FontoClient> client({
    required bool withBuckets,
    int bucketsStatus = 200,
  }) async {
    return FontoClient(
      await AuthStore.load(),
      httpClient: MockClient((req) async {
        final h = {"content-type": "application/json"};
        if (req.url.path.endsWith("/review-queue/buckets")) {
          if (bucketsStatus != 200) {
            return http.Response(jsonEncode({"error": "Forbidden"}), bucketsStatus, headers: h);
          }
          return http.Response(
            jsonEncode({
              "buckets": withBuckets ? [_conflictBucket()] : [],
              "totalReview": withBuckets ? 1204 : 0,
              "progress": {"sorted": 100, "total": 100},
            }),
            200,
            headers: h,
          );
        }
        if (req.url.path.contains("/assets/urls")) {
          return http.Response(jsonEncode({"urls": {"a1": "https://x/a1"}}), 200, headers: h);
        }
        if (req.url.path.endsWith("/confirm-bucket")) {
          return http.Response(jsonEncode({"enqueued": true}), 200, headers: h);
        }
        return http.Response(jsonEncode({}), 200, headers: h);
      }),
    );
  }

  testWidgets("renders a reason bucket with plain-language copy", (tester) async {
    final c = await client(withBuckets: true);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.text("The saved date looks wrong for these"), findsOneWidget);
    expect(find.text("Very likely right"), findsOneWidget);
    expect(find.text("Looks right — fix all 1204"), findsOneWidget);
    c.close();
  });

  testWidgets("applying a bucket hides it and offers undo", (tester) async {
    final c = await client(withBuckets: true);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    await tester.tap(find.text("Looks right — fix all 1204"));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text("The saved date looks wrong for these"), findsNothing);
    expect(find.text("Undo"), findsOneWidget);
    c.close();
  });

  testWidgets("Why these? expands a plain-language reason (P1-4)", (tester) async {
    final c = await client(withBuckets: true);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.textContaining("wrote the date inside"), findsNothing);
    await tester.tap(find.text("Why these?"));
    await tester.pumpAndSettle();
    expect(find.textContaining("wrote the date inside"), findsOneWidget);
    c.close();
  });

  testWidgets("session summary appears after a bucket apply (P1-5)", (tester) async {
    final c = await client(withBuckets: true);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.textContaining("This visit:"), findsNothing);
    await tester.tap(find.text("Looks right — fix all 1204"));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining("This visit: 1204 dates fixed"), findsOneWidget);
    c.close();
  });

  testWidgets("owner-only when the server forbids", (tester) async {
    final c = await client(withBuckets: false, bucketsStatus: 403);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.textContaining("workspace owner"), findsOneWidget);
    c.close();
  });

  testWidgets("all-clear when nothing to review", (tester) async {
    final c = await client(withBuckets: false);
    await tester.pumpWidget(MaterialApp(home: TidyUpScreen(client: c)));
    await tester.pumpAndSettle();

    expect(find.textContaining("Your library's tidy"), findsOneWidget);
    c.close();
  });
}
