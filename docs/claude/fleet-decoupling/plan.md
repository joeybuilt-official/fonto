# Fleet decoupling — Fonto standalone (zero Plexo, app-owned AI)

> Plan for the fonto leg of the fleet decoupling directive (2026-09-29).
> Reference shape: levio PR #42 (`7d11a2f`) — app-owned published API + Jex
> manifest, per-user AI connections, zero `@joeybuilt/plexo-sdk`, conformance
> guard inverted from "require Plexo" to "forbid Plexo".

## Why

Every Joeybuilt app must stand alone: no sibling SDK, no sibling credentials,
no sibling deployment in a core flow. Fonto's coupling was the widest in the
fleet — the Plexo SDK facade (`lib/plexo.ts`), boot registration
(`lib/plexo-registration.ts`), the vision sidecar client
(`lib/plexo-vision.ts`), a federated intelligence tier, two inbound routes
(`/api/plexo/{data,events}`), a health probe, a dashboard status badge, and
`PLEXO_*` environment variables read across ~25 call sites.

## Invariant

An optional capability that is absent must DEGRADE, never block a core flow.
No 503 for a missing capability on a core path, no eager workspace resolution,
no peer in the inference path.

## What changes

### 1. Delete the sibling surface

| Removed | Was |
|---|---|
| `@joeybuilt/plexo-sdk` | the sibling SDK (package.json + lockfile + next.config externalize + depcruise rules) |
| `lib/plexo.ts` | the SDK facade + deploy-shaped prompts |
| `lib/plexo-registration.ts` | boot-time app-profile registration with Plexo Core |
| `lib/plexo-vision.ts` | CLIP/OCR/face client bound to `PLEXO_VISION_URL` + `PLEXO_SERVICE_KEY` |
| `lib/intelligence/adapters/plexo-federated.ts` | the federated tier (env `PLEXO_URL`) |
| `lib/intelligence/adapters/plexo-unified.ts` | `POST {PLEXO_URL}/api/v1/vision/analyze-image` |
| `app/api/plexo/{data,events}` | inbound routes a sibling called |
| `app/api/health/plexo` | a probe of a sibling's health |
| `components/plexo-connection-status.tsx`, `components/plexo/PlexoConnectionStatus.tsx` | peer status UI |
| `PLEXO_URL` / `PLEXO_SERVICE_KEY` / `PLEXO_VISION_URL` | sibling credentials/config |

### 2. App-owned replacements

- **AI connections** (`fonto.ai_connections`, migration 0063) +
  `lib/ai/connections.ts` — per-user label/base URL/model/API key; the key is
  AES-256-GCM encrypted via the new single home `lib/crypto/secret-box.ts`
  (which `lib/integrations/tokenCrypto.ts` now delegates to, so existing Google
  token ciphertext is untouched). Resolution: named connection → user default →
  env deployment default (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`, with the legacy
  `FONTO_LLM_*` names honored). No read path returns the key — masked last-4 only.
- **Identity** — already app-owned (`fonto.workspaces`); `plexoEnsureWorkspace`
  simply goes away.
- **Vision tier** — `lib/intelligence/adapters/vision-sidecar.ts` bound to
  `FONTO_VISION_URL` (+ optional `FONTO_VISION_KEY`); unset = capability not
  advertised = typed unavailable, per capability.
- **Published API** — `/api/peer/v1/{data,events}` authenticated by the
  deployment's own `FONTO_SERVICE_KEY` (`lib/peer/service-keys.ts`), plus
  `public/.well-known/jex.manifest.json` served both as a static asset and via
  an api route importing the same file.

### 3. Conformance guard — inverted

`scripts/conformance-guard.mjs` currently *requires* AI through
`@joeybuilt/plexo-sdk` and bans provider packages. It is rewritten to the
zero-Plexo shape: forbid the sibling SDKs, forbid `@/lib/plexo*` imports,
forbid `PLEXO_*` env reads — while keeping rule 3 (asset LIST projection
whitelist) intact and `@anthropic-ai/sdk` allowed as the embedded tier floor.
It runs in `verify.yml` (`pnpm conformance`), which stays hosted-only and
secret-free.

## Build notes

- The public tree (`joeybuilt-official/fonto`) is the PR target; the
  hive-desktop checkout is a divergent dev lineage — the same app code paths for
  every file this plan touches, but not the target.
- `USE_UNIFIED_ANALYZE` and the unified analyze-image path are removed with
  their Plexo Core backend; the existing port-based enrichment chain (CLIP
  argmax floor + vision ports + completion tier) is the app-owned successor.
- Outbound `ext.fonto.*` events were Plexo-bound; their app-owned equivalents
  are the existing webhook + activity buses.
