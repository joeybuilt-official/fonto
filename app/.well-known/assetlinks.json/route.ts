// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.5 — Android App Links verification file.
//
// ASSETLINKS_SHA256 must be set to the Play-managed signing cert fingerprint
// (colon-delimited uppercase hex). Pre-Play builds use the upload keystore
// fingerprint from ADR 0006; update to the Play key after first publish via
// Play Console → Setup → App integrity → App signing key certificate.
import { NextResponse } from "next/server";

export async function GET() {
  const fingerprint = process.env.ASSETLINKS_SHA256;
  if (!fingerprint) {
    return NextResponse.json({ error: "ASSETLINKS_SHA256 not configured" }, { status: 503 });
  }
  return NextResponse.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.joeybuilt.fonto",
          sha256_cert_fingerprints: [fingerprint],
        },
      },
    ],
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
