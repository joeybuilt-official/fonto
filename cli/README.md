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
| `fonto download <id> [--out <path>] [--variant thumb\|preview\|original]` | Save an asset to disk. |
| `fonto trash <id…>` / `fonto restore <id…>` | Toggle lifecycle on one or more assets. |
| `fonto sc list [--json]` | Enumerate saved smart collections. |
| `fonto sc run <id> [--limit] [--json]` | Execute a smart collection. |
| `fonto sync <dir> [--remote-prefix <path>] [--state <path>] [--dry-run]` | One-way local → remote incremental upload. |

`--json` on listing commands emits the raw API response so the CLI is
pipeable into `jq`.

### `fonto sync`

Walks `<dir>` recursively and uploads new or edited files into the
matching virtual folder on the remote (rooted at `--remote-prefix`,
default `/`). State lives at `<dir>/.fonto-sync.json` so reruns are
cheap. Honours hard ignores (`.git`, `node_modules`, `.DS_Store`,
`Thumbs.db`) plus a `.fontoignore` file with one glob per line. Use
`--dry-run` to preview.

Direction is local → remote only. A `--pull` mode pulling remote
changes down to disk is on the roadmap.

## Development

```bash
cd cli
npm install
npm run dev   # watch + run
npm run build # tsc → dist/
node dist/index.js whoami
```

## Roadmap

v0.2 covers read, upload, download, trash/restore, smart-collection
list/run, and one-way sync. Follow-ups:

- `fonto sync --pull` — bidirectional, fetch remote changes since the
  state file's last upload.
- `fonto stacks suggestions` / `fonto stacks accept <ids…>`.
- `fonto sc create` from a JSON DSL file.
- `fonto folder mv / rm` mirroring the UX-2 web ops.

Auth is intentionally PAT-only: the `/api/v1/tokens` endpoints that mint
PATs are session-gated to keep PAT → PAT escalation impossible.
