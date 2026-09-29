---
description: App-owned AI connections and the published API surface
---

## AI connections (app-owned)

Each user configures their OWN AI connection in Settings → Integrations:
label, base URL, model, API key. Stored in `fonto.ai_connections`; the key is
AES-256-GCM encrypted by `lib/crypto/secret-box.ts` (key from AUTH_SECRET) and
is NEVER returned by a read path — `listAiConnections` returns a masked last-4.

Resolution order for an inference call (`lib/ai/connections.ts`):
1. named connection (when the caller knows which one it wants),
2. the user's default,
3. the deployment default from env (`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`,
   legacy `FONTO_LLM_*` honored).

A user with no connection falls back to the deployment default. When neither
exists the call degrades to a typed `CapabilityUnavailableError` — never a 503
on a core flow.

## Intelligence facade

All inference goes through `lib/intelligence/client.ts`:
- `intelligence.complete(req)` — deployment-default/env connection.
- `intelligence.completeForUser(userId, req)` — the user's own connection.
- `intelligence.embedImage/embedText/ocr/label/detectFaces` — the vision
  sidecar at `FONTO_VISION_URL` (optional; unset ⇒ capability not advertised).
- `intelligence.storeMemory/searchMemory` — the pgvector Memory port.

Prompts (classify / describe / suggest-tags) live in
`lib/intelligence/prompts.ts` and always take a userId.

## Published API surface

`/api/peer/v1/data` (GET/POST) and `/api/peer/v1/events` (HMAC-SHA256 signed)
authenticate with the deployment's own `FONTO_SERVICE_KEY` /
`FONTO_SERVICE_KEY_V2` (`lib/peer/service-keys.ts`). Unconfigured ⇒ 503
FEATURE_DISABLED. The manifest is published at
`public/.well-known/jex.manifest.json` and served by
`app/.well-known/jex.manifest.json/route.ts` from the SAME import.
