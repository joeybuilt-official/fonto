// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// OpenTelemetry SDK bootstrap. Shared between the Next.js app
// (`instrumentation.ts`) and the worker (`worker/index.ts`).
//
// Configuration:
//   OTEL_EXPORTER_OTLP_ENDPOINT — collector OTLP/HTTP endpoint
//                                 (e.g. http://otel-collector:4318)
//   OTEL_SERVICE_NAME           — overrides the default service name
//
// If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, this function returns without
// initializing the SDK — Fonto must run cleanly without a collector
// reachable. We swallow any boot errors for the same reason: telemetry must
// never be the reason a deploy is wedged.

let started = false;

export async function startOtel(defaultServiceName: string): Promise<void> {
  if (started) return;
  if (process.env.NEXT_RUNTIME === "edge") return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  try {
    const [
      { NodeSDK },
      { getNodeAutoInstrumentations },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/auto-instrumentations-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
    ]);

    const serviceName = process.env.OTEL_SERVICE_NAME ?? defaultServiceName;

    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({
        // The SDK appends `/v1/traces` if the user provides a base endpoint.
        url: endpoint.replace(/\/$/, "") + "/v1/traces",
      }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: endpoint.replace(/\/$/, "") + "/v1/metrics",
        }),
        exportIntervalMillis: 15_000,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs to avoid an avalanche of spans for next.js' own file
          // reads. Everything else (http, pg, ioredis, bullmq) stays on.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;

    // Best-effort shutdown so spans/metrics flush on SIGTERM.
    const shutdown = async (): Promise<void> => {
      try {
        await sdk.shutdown();
      } catch {
        // ignore
      }
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  } catch (err) {
    // Telemetry boot failures must never fail the app. Log to stderr only.
    console.warn(
      "[fonto] OpenTelemetry init failed:",
      err instanceof Error ? err.message : err
    );
  }
}
