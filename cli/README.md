# @joeybuilt/fonto-cli

Terminal interface to a Fonto instance. Talks to `/api/v1` via a personal
access token (PAT).

```bash
npm install -g @joeybuilt/fonto-cli   # once published

# Mint a PAT in the web UI: /app/settings/tokens
fonto login --base-url https://fonto.example.com --pat <token>

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
| `fonto sc create <name> [--query <file>] [--json]` | POST a new smart collection from a JSON query DSL (or stdin). |
| `fonto stacks list [--json]` | List existing stacks. |
| `fonto stacks suggestions [--limit] [--json]` | Show RAW+JPEG / burst suggestions (read-only). |
| `fonto stacks accept <id…> [--primary <id>] [--name] [--json]` | Confirm a suggestion and create the stack. |
| `fonto folder mv <path> <newParent> [--json]` | Reparent a folder subtree. |
| `fonto folder rm <path> [--orphan] [--json]` | Trash every asset under `<path>` (or `--orphan` to clear paths instead). |
| `fonto sync <dir> [--remote-prefix <path>] [--state <path>] [--dry-run] [--pull]` | Sync `<dir>` with the remote — push by default, `--pull` adds bidirectional delta. |

`--json` on listing commands emits the raw API response so the CLI is
pipeable into `jq`.

### `fonto sync`

Walks `<dir>` recursively and uploads new or edited files into the
matching virtual folder on the remote (rooted at `--remote-prefix`,
default `/`). State lives at `<dir>/.fonto-sync.json` so reruns are
cheap. Honours hard ignores (`.git`, `node_modules`, `.DS_Store`,
`Thumbs.db`) plus a `.fontoignore` file with one glob per line. Use
`--dry-run` to preview.

`--pull` adds the remote → local half. It walks
`/api/v1/sync/assets?cursor=…` forward from the cursor stored in the
state file, applying remote tombstones (delete local) and downloading
new/changed assets into the matching local path. When a remote asset
would land on a local file that is not tracked by the state file, the
download is skipped (no clobbering). Pull runs before push, so newly
pulled assets are not re-uploaded on the same invocation.

### `fonto stacks`

Stacks group near-duplicates (e.g. RAW+JPEG, bursts). `suggestions`
runs the read-only suggestor and prints groups by index. `accept`
takes asset ids (typically copied from a suggestion row) and POSTs to
`/api/v1/stacks/suggestions/accept`, returning the new stack id.

### `fonto folder`

Folders are derived from `assets.directory_path`. `mv` reparents a
prefix (and every descendant under it). `rm` defaults to trashing
every asset under the prefix; `--orphan` instead clears
`directory_path` so the assets survive at the root.

### `fonto sc create`

POSTs a new smart collection. The query DSL JSON is loaded from
`--query <file>` (or from stdin if `--query` is omitted and stdin is
piped). Example:

```bash
echo '{"mime":"image/","favorite":true}' | fonto sc create "Favourite photos"
fonto sc create "PDFs" --query ./query.json
```

## Development

```bash
cd cli
npm install
npm run dev   # watch + run
npm run build # tsc → dist/
node dist/index.js whoami
```

## Roadmap

v0.3 closes the remaining CLI gaps: bidirectional sync, stacks accept,
smart-collection create, and folder mv/rm. Follow-ups:

- Parallelism flag for sync push/pull (currently sequential).
- `fonto folder rename <path> <newName>` — already supported server-side
  (`/folders/operation op=rename`); just needs the CLI surface.
- `fonto persons` / `fonto faces` ops once the people UI lands.
- Conflict resolution policy for sync pull (currently skip-untracked).

Auth is intentionally PAT-only: the `/api/v1/tokens` endpoints that mint
PATs are session-gated to keep PAT → PAT escalation impossible.
