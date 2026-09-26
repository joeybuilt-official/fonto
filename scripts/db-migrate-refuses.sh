#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# `pnpm db:migrate` used to be the documented install step. It cannot work on
# this repository, and its failure mode was SILENT — drizzle-kit exited 0 having
# applied nothing, so a fresh clone came up with an empty database and no error
# to explain why. A silent no-op is the worst possible install step, so this
# wrapper now fails loudly and points at the supported path.
#
# Use: pnpm db:setup            (== bash scripts/db-apply.sh)
#      pnpm db:setup:dry-run    print the plan, touch nothing
#      pnpm db:setup:adopt      record state for an already-migrated database
#
# The three reasons drizzle-kit migrate cannot drive this series, each verified:
#   1. There is no drizzle/meta/_journal.json, so drizzle-orm's
#      readMigrationFiles() has nothing to read and applies NOTHING.
#   2. drizzle/migrations/ has no baseline: 0002 alters fonto.assets, which no
#      numbered migration ever creates. Those tables were made out-of-band.
#   3. drizzle wraps every migration in ONE transaction, and 0037/0058 use
#      CREATE INDEX CONCURRENTLY, which Postgres refuses inside a transaction.
set -euo pipefail

echo "db:migrate is DISABLED on this repository — it cannot apply this migration" >&2
echo "series and fails silently, leaving you with an empty database and no error." >&2
echo >&2
echo "Use the supported path instead:" >&2
echo "    pnpm db:setup            # apply baselines + every migration" >&2
echo "    pnpm db:setup:dry-run    # print the plan, touch nothing" >&2
echo "    pnpm db:setup:adopt      # record an already-migrated database" >&2
echo >&2
echo "Full rationale: docs/self-hosting.md §'Why not pnpm db:migrate'" >&2
exit 1
