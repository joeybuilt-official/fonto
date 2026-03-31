---
description: Plexo Core integration patterns
---

## Plexo Core

Plexo Core is the AI backbone. The app connects to it via `PLEXO_URL` env var.

## Health endpoint

- `GET /api/health` returns connection status and app metadata
- Used by the PlexoConnectionStatus component and external monitors

## Connection status component
- `PlexoConnectionStatus` lives in `components/plexo/PlexoConnectionStatus.tsx`
- Already wired into the dashboard layout — do not add it again in page components
- Polls `/api/health` every 60s — no additional setup needed
- Shows green when `plexoConnected: true`, amber when false, red on fetch error
- The health endpoint must return `plexoConnected`, `plexoUrl`, `appId`, `schemaNamespace`, `timestamp`
