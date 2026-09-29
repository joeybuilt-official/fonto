/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * OpenTelemetry SDK is booted here (if `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
 * This must run before any other imports that we want auto-instrumented to pick
 * up their bindings — Next.js guarantees this hook fires first.
 *
 * (A second boot step — registering the app profile with a sibling app — was
 * removed with the fleet decoupling: the app owns its own surface now.)
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOtel } = await import("./lib/otel")
    await startOtel("fonto-web")
  }
}
