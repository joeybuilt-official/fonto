// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Android DocumentsProvider — exposes the user's Fonto library inside
// the system file-picker / share-target chooser. Auth credentials come
// from the "fonto_bridge" SharedPreferences file written by MainActivity
// via the com.joeybuilt.fonto/auth_bridge MethodChannel on every login
// and cleared on sign-out.
//
// Provider authority: com.joeybuilt.fonto.documents
// One root: "Fonto Library" → flat list of all assets (up to 200).

package com.joeybuilt.fonto

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class FontoDocumentsProvider : DocumentsProvider() {

    companion object {
        const val AUTHORITY = "com.joeybuilt.fonto.documents"
        const val ROOT_ID = "fonto_root"
        const val DOCUMENT_ROOT = "root"
        private const val PREFS_NAME = "fonto_bridge"
        private const val KEY_PAT = "pat"
        private const val KEY_BASE_URL = "base_url"
        private const val PAGE_LIMIT = 200
        private const val CONNECT_TIMEOUT = 10_000
        private const val READ_TIMEOUT = 20_000
        private const val STREAM_TIMEOUT = 60_000

        private val ROOT_COLUMNS = arrayOf(
            Root.COLUMN_ROOT_ID,
            Root.COLUMN_TITLE,
            Root.COLUMN_ICON,
            Root.COLUMN_FLAGS,
            Root.COLUMN_MIME_TYPES,
            Root.COLUMN_DOCUMENT_ID,
        )
        private val DOC_COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )

        // Two SimpleDateFormat patterns cover ISO 8601 with and without milliseconds.
        private fun parseIso8601(s: String?): Long {
            if (s == null) return 0L
            for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")) {
                try {
                    return SimpleDateFormat(pattern, Locale.US)
                        .also { it.timeZone = TimeZone.getTimeZone("UTC") }
                        .parse(s)!!.time
                } catch (_: Exception) {}
            }
            return 0L
        }
    }

    private fun prefs() =
        context!!.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val pat: String? get() = prefs().getString(KEY_PAT, null)
    private val baseUrl: String? get() = prefs().getString(KEY_BASE_URL, null)

    override fun onCreate(): Boolean = true

    // ── Roots ─────────────────────────────────────────────────────────────────

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: ROOT_COLUMNS)
        val p = pat ?: return cursor  // not signed in → no roots shown
        @Suppress("UNUSED_EXPRESSION") p  // referenced for null-check only
        cursor.newRow().apply {
            add(Root.COLUMN_ROOT_ID, ROOT_ID)
            add(Root.COLUMN_TITLE, "Fonto Library")
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            add(Root.COLUMN_FLAGS, 0)
            add(Root.COLUMN_MIME_TYPES, null)
            add(Root.COLUMN_DOCUMENT_ID, DOCUMENT_ROOT)
        }
        return cursor
    }

    // ── Document metadata ─────────────────────────────────────────────────────

    override fun queryDocument(
        documentId: String,
        projection: Array<out String>?,
    ): Cursor {
        val cursor = MatrixCursor(projection ?: DOC_COLUMNS)
        if (documentId == DOCUMENT_ROOT) {
            cursor.newRow().apply {
                add(Document.COLUMN_DOCUMENT_ID, DOCUMENT_ROOT)
                add(Document.COLUMN_DISPLAY_NAME, "Fonto Library")
                add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
                add(Document.COLUMN_SIZE, 0L)
                add(Document.COLUMN_LAST_MODIFIED, 0L)
                add(Document.COLUMN_FLAGS, 0)
            }
            return cursor
        }
        val p = pat; val bu = baseUrl
        if (p == null || bu == null) return cursor
        try {
            val json = httpGet("$bu/api/v1/assets/$documentId", p)
            addAssetRow(cursor, json.getJSONObject("asset"))
        } catch (_: Exception) {}
        return cursor
    }

    // ── Children list ─────────────────────────────────────────────────────────

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cursor = MatrixCursor(projection ?: DOC_COLUMNS)
        val p = pat; val bu = baseUrl
        if (p == null || bu == null) return cursor
        try {
            val json = httpGet("$bu/api/v1/assets?limit=$PAGE_LIMIT", p)
            val assets: JSONArray = json.getJSONArray("assets")
            for (i in 0 until assets.length()) {
                addAssetRow(cursor, assets.getJSONObject(i))
            }
        } catch (_: Exception) {}
        return cursor
    }

    // ── File open ─────────────────────────────────────────────────────────────

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        val p = checkNotNull(pat) { "Fonto: not signed in" }
        val bu = checkNotNull(baseUrl) { "Fonto: no base URL" }

        // Resolve presigned URL via the batch endpoint.
        val urlJson = httpPost(
            "$bu/api/v1/assets/urls",
            p,
            """{"ids":["$documentId"],"variant":"original"}""",
        )
        val presigned = urlJson.getJSONObject("urls").getString(documentId)

        // Pipe: background thread writes download → caller reads.
        val pipe = ParcelFileDescriptor.createPipe()
        val (readSide, writeSide) = pipe

        Thread {
            try {
                ParcelFileDescriptor.AutoCloseOutputStream(writeSide).use { out ->
                    streamGet(presigned, out)
                }
            } catch (e: Exception) {
                try { writeSide.closeWithError(e.message ?: "Download failed") }
                catch (_: Exception) {}
            }
        }.also { it.name = "fonto-doc-stream"; it.start() }

        return readSide
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    private fun httpGet(url: String, pat: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.setRequestProperty("Authorization", "Bearer $pat")
            conn.setRequestProperty("Accept", "application/json")
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.connect()
            return conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally {
            conn.disconnect()
        }
    }

    private fun httpPost(url: String, pat: String, body: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Authorization", "Bearer $pat")
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.doOutput = true
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.connect()
            conn.outputStream.bufferedWriter().use { it.write(body) }
            return conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally {
            conn.disconnect()
        }
    }

    private fun streamGet(url: String, out: OutputStream) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = STREAM_TIMEOUT
            conn.connect()
            conn.inputStream.use { it.copyTo(out) }
        } finally {
            conn.disconnect()
        }
    }

    // ── Row builder ───────────────────────────────────────────────────────────

    private fun addAssetRow(cursor: MatrixCursor, asset: JSONObject) {
        val id = asset.getString("id")
        val filename = asset.getString("filename")
        val mime = asset.getString("mimeType")
        val size = asset.optLong("sizeBytes", 0L)
        val ts = parseIso8601(asset.optString("createdAt", null).takeIf { it.isNotEmpty() })
        cursor.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, id)
            add(Document.COLUMN_DISPLAY_NAME, filename)
            add(Document.COLUMN_MIME_TYPE, mime)
            add(Document.COLUMN_SIZE, size)
            add(Document.COLUMN_LAST_MODIFIED, ts)
            add(Document.COLUMN_FLAGS, 0)
        }
    }
}
