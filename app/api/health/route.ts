// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
export async function GET() {
  return Response.json({
    ok: true,
    appId: 'fonto',
    schemaNamespace: process.env.APP_SCHEMA_NAMESPACE ?? null,
    plexoConnected: !!process.env.PLEXO_URL,
    plexoUrl: process.env.PLEXO_URL ?? null,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    emailConfigured: !!process.env.RESEND_API_KEY,
    timestamp: new Date().toISOString(),
  })
}
