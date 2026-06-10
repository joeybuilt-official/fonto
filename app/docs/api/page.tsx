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
    </>
  );
}
