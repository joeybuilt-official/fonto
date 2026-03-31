export async function GET() {
  return Response.json({
    ok: true,
    appId: 'base',
    schemaNamespace: process.env.APP_SCHEMA_NAMESPACE ?? null,
    plexoConnected: !!process.env.PLEXO_URL,
  })
}
