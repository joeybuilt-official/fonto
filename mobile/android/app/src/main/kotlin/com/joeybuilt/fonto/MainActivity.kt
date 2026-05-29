// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.9 — auth bridge MethodChannel. Flutter calls saveAuth(pat, baseUrl)
// on login and clearAuth() on sign-out. Values land in the "fonto_bridge"
// SharedPreferences file, which FontoDocumentsProvider reads synchronously.

package com.joeybuilt.fonto

import android.content.Context
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    private val CHANNEL = "com.joeybuilt.fonto/auth_bridge"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                val prefs = getSharedPreferences("fonto_bridge", Context.MODE_PRIVATE)
                when (call.method) {
                    "saveAuth" -> {
                        val pat = call.argument<String>("pat") ?: ""
                        val baseUrl = call.argument<String>("baseUrl") ?: ""
                        prefs.edit()
                            .putString("pat", pat)
                            .putString("base_url", baseUrl)
                            .apply()
                        result.success(null)
                    }
                    "clearAuth" -> {
                        prefs.edit().clear().apply()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
