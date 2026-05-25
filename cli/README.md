# @joeybuilt/fonto-cli

Terminal interface to a Fonto instance. Talks to `/api/v1` via a personal
access token (PAT).

```bash
npm install -g @joeybuilt/fonto-cli   # once published

# Mint a PAT in the web UI: /app/settings/tokens
fonto login --pat <token> --base-url https://myfonto.com

fonto whoami           # verify the token + show workspace stats
fonto ls               # list assets in the workspace
fonto ls --mime image/ --limit 20
fonto ls --favorite
fonto search "dog on beach"
fonto upload ./IMG_0001.jpg --path /Photos/2024
```

`FONTO_BASE_URL` and `FONTO_PAT` environment variables override the
saved config — useful in CI.

## Commands

| Command | What |
|---|---|
| `fonto login --pat <token> [--base-url <url>]` | Save credentials. |
| `fonto whoami` | Confirm auth + show workspace counts. |
| `fonto ls [--mime] [--favorite] [--limit] [--json]` | List assets. |
| `fonto search <query> [--json]` | Filename / description / OCR search. |
| `fonto upload <file> [--path <virtual>] [--json]` | Multipart upload. |

`--json` on listing commands emits the raw API response so the CLI is
pipeable into `jq`.

## Development

```bash
cd cli
npm install
npm run dev   # watch + run
npm run build # tsc → dist/
node dist/index.js whoami
```

## Roadmap

Today's set covers read + upload. Follow-ups (each its own cmd file):

- `fonto download <id>` — pull an asset by id.
- `fonto trash <id>` / `fonto restore <id>`.
- `fonto smart-collection list` / `fonto smart-collection run <id>`.
- `fonto stacks suggestions` / `fonto stacks accept <ids…>`.
- `fonto sync` — folder bidirectional sync, modelled on the upload-script
  pattern (`pnpm import:s3` in the parent repo).

Auth is intentionally PAT-only: the `/api/v1/tokens` endpoints that mint
PATs are session-gated to keep PAT → PAT escalation impossible.
