// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M8 — client helper to trigger a streaming bulk-zip download (ADR 0011).
// Uses a hidden form POST so an arbitrary-sized selection rides in the request
// body (not a length-capped URL); the endpoint's Content-Disposition header
// makes the browser save the streamed zip without navigating away.

function submitZipForm(fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/v1/assets/export/zip";
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

/** Download the given asset ids as a single streamed zip. */
export function downloadAssetsZip(ids: string[]): void {
  if (!ids.length) return;
  submitZipForm({ ids: ids.join(",") });
}

/** Download every asset in a collection as a single streamed zip. */
export function downloadCollectionZip(collectionId: string): void {
  submitZipForm({ collectionId });
}
