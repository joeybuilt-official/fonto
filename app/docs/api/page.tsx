// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// `/docs/api` — Scalar API Reference UI for the Fonto OpenAPI spec.
//
// We use Scalar's standalone web-component (loaded from their CDN) rather
// than `@scalar/nextjs-api-reference` because the latter is a route handler
// that returns raw HTML — it doesn't compose with `app/docs/api/page.tsx`.
// The CDN approach is one small <script> tag and avoids pulling more React
// renderer code into our bundle.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fonto API Reference",
  description: "Interactive REST API reference for Fonto (OpenAPI 3.1).",
};

export default function ApiReferencePage() {
  return (
    <>
      <h1 className="sr-only">Fonto API Reference</h1>

      {/* Fallback shown if Scalar's CDN script fails to load or render (offline,
          blocked, CDN outage). The inline script below hides it once Scalar
          mounts; if Scalar never mounts, this stays so the spec is still
          reachable. Also covers JS-disabled via <noscript>. */}
      <div id="api-fallback" className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Loading the API reference…</p>
        <p className="mt-2">
          If it doesn&apos;t appear, view the raw spec:{" "}
          <a href="/api/v1/openapi.json" className="text-primary-text hover:underline">
            /api/v1/openapi.json
          </a>{" "}
          (OpenAPI 3.1 JSON).
        </p>
      </div>
      <noscript>
        <div className="mx-auto max-w-2xl p-8 text-sm">
          The interactive API reference needs JavaScript. View the raw spec at{" "}
          <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
        </div>
      </noscript>

      {/* The standalone Scalar element reads its config from the script body. */}
      <script
        id="api-reference"
        type="application/json"
        // Static JSON config — no user input. Scalar reads this as plain text.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            url: "/api/v1/openapi.json",
            theme: "default",
            metaData: { title: "Fonto API Reference" },
            hideClientButton: false,
          }),
        }}
      />
      <script
        async
        src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest/dist/browser/standalone.js"
      />
      {/* Hide the fallback once Scalar actually renders its app; if it never
          mounts (CDN down/blocked), the fallback + raw-spec link stay. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){var tries=0;var t=setInterval(function(){tries++;if(document.querySelector('.scalar-app, scalar-api-reference, [data-v-app]')){var f=document.getElementById('api-fallback');if(f)f.style.display='none';clearInterval(t);}if(tries>40)clearInterval(t);},250);})();",
        }}
      />
    </>
  );
}
