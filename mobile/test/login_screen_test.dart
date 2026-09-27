// SPDX-License-Identifier: MIT
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
    // The URL field is pre-filled with the default base URL, and its
    // hintText is the same string — find.text would match both the
    // EditableText value and the (hidden) hint. Assert the controller
    // value directly to stay unambiguous.
    final urlField = tester.widget<TextField>(find.byType(TextField).first);
    expect(urlField.controller?.text, AuthStore.defaultBaseUrl);
  });

  testWidgets("shows error on empty submit", (tester) async {
    await pumpLogin(tester);
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    expect(find.text("Both fields are required."), findsOneWidget);
  });
}
