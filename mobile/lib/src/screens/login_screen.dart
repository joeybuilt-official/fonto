// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// First-run login. Two fields: base URL (defaulted to myfonto.com) and
// PAT. On submit we save tentatively, ping /api/v1/stats to confirm the
// PAT, then bounce up so the app can flip to HomeScreen. On failure
// we wipe the saved creds so the form stays on screen.

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../main.dart" show registerUploadDrain;
import "../api/fonto_client.dart";
import "../state/auth_store.dart";

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.auth, required this.onLoggedIn});

  final AuthStore auth;
  final VoidCallback onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _baseUrlCtrl = TextEditingController(text: AuthStore.defaultBaseUrl);
  final _patCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _baseUrlCtrl.dispose();
    _patCtrl.dispose();
    super.dispose();
  }

  // M14 / ADR 0056 — open the web login in the system browser for the OIDC
  // dance. On success the web deep-links a PAT back to /mobile/auth-callback,
  // handled in main.dart. The base URL field sets which instance to hit.
  Future<void> _ssoLogin() async {
    final baseUrl = _baseUrlCtrl.text.trim();
    if (baseUrl.isEmpty) {
      setState(() => _error = "Enter your Fonto URL first.");
      return;
    }
    final uri = Uri.parse("$baseUrl/login?mobile=1");
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _submit() async {
    final pat = _patCtrl.text.trim();
    final baseUrl = _baseUrlCtrl.text.trim();
    if (pat.isEmpty || baseUrl.isEmpty) {
      setState(() => _error = "Both fields are required.");
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    await widget.auth.save(pat: pat, baseUrl: baseUrl);
    final client = FontoClient(widget.auth);
    try {
      await client.stats();
      if (!mounted) return;
      await registerUploadDrain();
      widget.onLoggedIn();
    } on ApiException catch (e) {
      await widget.auth.clear();
      if (!mounted) return;
      setState(() => _error = "${e.status}: ${e.message}");
    } catch (e) {
      await widget.auth.clear();
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Sign in to Fonto")),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _baseUrlCtrl,
                decoration: const InputDecoration(
                  labelText: "Base URL",
                  hintText: "https://myfonto.com",
                ),
                keyboardType: TextInputType.url,
                autocorrect: false,
              ),
              const SizedBox(height: 24),
              // Primary path — M14 / ADR 0056 + Jex ADR-004. Opens the web login
              // in the system browser, where email/password, passkey, one-time
              // link, and SSO all work; every success mints a PAT and deep-links
              // it back to /mobile/auth-callback (handled in main.dart). No
              // native OAuth or WebAuthn needed in the app.
              FilledButton(
                onPressed: _busy ? null : _ssoLogin,
                child: const Text("Sign in"),
              ),
              const SizedBox(height: 8),
              Text(
                "Opens your browser to sign in with email & password, a "
                "passkey, or SSO. You'll return to the app automatically.",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
              const SizedBox(height: 12),
              // Advanced fallback — paste a Personal Access Token directly. For
              // headless/self-hosted setups or when the browser round-trip
              // isn't available.
              Theme(
                data: Theme.of(context)
                    .copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: const EdgeInsets.only(bottom: 8),
                  expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
                  title: const Text("Advanced: sign in with a token"),
                  children: [
                    TextField(
                      controller: _patCtrl,
                      decoration: const InputDecoration(
                        labelText: "Personal access token",
                        helperText:
                            "Mint one at /app/settings/tokens in the web UI.",
                      ),
                      obscureText: true,
                      autocorrect: false,
                    ),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child:
                                  CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text("Sign in with token"),
                    ),
                  ],
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
