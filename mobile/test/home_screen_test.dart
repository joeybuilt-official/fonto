// SPDX-License-Identifier: MIT
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";

import "package:fonto_mobile/src/screens/home_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";
import "package:fonto_mobile/src/widgets/list_states.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      "fonto.pat": "test-pat",
      "fonto.baseUrl": "https://fonto.example.com",
    });
  });

  testWidgets("shows the grid skeleton on initial load", (tester) async {
    final auth = await AuthStore.load();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(auth: auth, onSignOut: () {}),
      ),
    );
    // Single pump — HomeScreen sets _loadingFirst = true synchronously in
    // initState and kicks off async I/O, so the cold-start branch is on
    // screen before any network response arrives. That branch now paints
    // placeholder tiles rather than a lone spinner (web parity, c917efd),
    // so the skeleton — not CircularProgressIndicator — is the assertion.
    expect(find.byType(SliverGridSkeleton), findsOneWidget);
  });
}
