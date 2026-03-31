---
description: Plexo Core integration patterns
---

## Plexo Core

Plexo Core is the AI backbone. The app connects to it via `PLEXO_URL` env var.

## Health endpoint

- `GET /api/health` returns connection status and app metadata
- Used by the PlexoConnectionStatus component and external monitors
