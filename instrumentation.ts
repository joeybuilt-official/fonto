/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Two things happen here:
 *  1. OpenTelemetry SDK is booted (if `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
 *     This must run before any other imports that we want auto-instrumented
 *     pick up their bindings — Next.js guarantees this hook fires first.
 *  2. Fonto registers itself with Plexo Core (legacy behaviour, unchanged).
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOtel } = await import("./lib/otel")
    await startOtel("fonto-web")

    const { registerWithPlexoCore } = await import("./lib/plexo-registration")
    await registerWithPlexoCore()
  }
}
