// SPDX-License-Identifier: AGPL-3.0-only
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";

import "package:fonto_mobile/src/screens/home_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://myfonto.com",
    });
  });

  testWidgets("shows loading indicator on initial load", (tester) async {
    final auth = await AuthStore.load();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(auth: auth, onSignOut: () {}),
      ),
    );
    // Single pump — HomeScreen sets _loadingFirst = true synchronously in
    // initState and kicks off async I/O. The CircularProgressIndicator
    // is visible before any network response arrives.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
