// SPDX-License-Identifier: AGPL-3.0-only
import "package:flutter/material.dart";
import "package:flutter_secure_storage/flutter_secure_storage.dart";
import "package:flutter_test/flutter_test.dart";

import "package:fonto_mobile/src/screens/login_screen.dart";
import "package:fonto_mobile/src/state/auth_store.dart";

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  Future<void> pumpLogin(WidgetTester tester) async {
    final auth = await AuthStore.load();
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(auth: auth, onLoggedIn: () {}),
      ),
    );
  }

  testWidgets("renders url field and pat field", (tester) async {
    await pumpLogin(tester);
    expect(find.byType(TextField), findsNWidgets(2));
    expect(find.text("https://myfonto.com"), findsOneWidget);
  });

  testWidgets("shows error on empty submit", (tester) async {
    await pumpLogin(tester);
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    expect(find.text("Both fields are required."), findsOneWidget);
  });
}
