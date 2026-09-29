#!/usr/bin/env node
/**
 * Provision the operator's default AI connection.
 *
 * Reads the deployment's own AI config from the environment — the SAME values
 * the container already holds (`AI_*`, falling back to the legacy
 * `FONTO_LLM_*` names) — and writes it as the target user's DEFAULT connection
 * row in `fonto.ai_connections`.
 *
 * WHY THIS IS STANDALONE (no `@/lib` imports): it runs inside the production
 * container, where the app source is bundled by Next and `@/...` aliases do not
 * resolve for a plain `node` invocation. Rather than drag a bundler in, the
 * ciphertext is produced here with the SAME algorithm, format and key
 * derivation as `lib/crypto/secret-box.ts`:
 *
 *     aes-256-gcm, key = scrypt(AUTH_SECRET, "fonto-integrations-v1", 32),
 *     output = v1:<ivB64>:<tagB64>:<ctB64>
 *
 * Correctness is not assumed: after writing, verify by reading the row back
 * through the APP's own decrypt path —
 *   GET /api/ai/connections  → `keyLast4` must equal the real key's last four.
 * A mismatch means this script and the app disagree, and the row must be
 * rewritten by the app itself (Settings → Integrations).
 *
 * The key is never passed on the command line and never logged.
 *
 * Usage (run INSIDE the app container so the env is present):
 *   node scripts/provision-ai-default.mjs [--user-id <uuid>] [--label <name>]
 * Defaults to the operator userId when --user-id is omitted.
 */
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import postgres from 'postgres'

const OPERATOR_USER_ID = 'f9b6ed66-8e40-49e1-a439-22e6d25aea37'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : undefined
}

/** Mirrors getKey() in lib/crypto/secret-box.ts. */
function keyBytes() {
  const raw = process.env.AUTH_SECRET ?? ''
  if (!raw) throw new Error('AUTH_SECRET not set — cannot store secrets')
  return scryptSync(raw, 'fonto-integrations-v1', 32)
}

/** Mirrors encryptSecret() in lib/crypto/secret-box.ts. */
function encryptSecret(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

async function main() {
  const userId = arg('user-id') ?? OPERATOR_USER_ID
  const label = arg('label') ?? process.env.AI_LABEL ?? 'LiteLLM Auto'

  const baseUrl = (process.env.AI_BASE_URL ?? process.env.FONTO_LLM_BASE_URL ?? '').replace(/\/$/, '')
  const apiKey = process.env.AI_API_KEY ?? process.env.FONTO_LLM_KEY ?? ''
  const model = process.env.AI_MODEL ?? 'auto'

  if (!baseUrl || !apiKey) {
    console.error('No AI connection config in this environment (need AI_BASE_URL/AI_API_KEY or the legacy FONTO_LLM_* names).')
    process.exit(1)
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  console.log(`Provisioning default AI connection for user ${userId}`)
  console.log(`  label   = ${label}`)
  console.log(`  baseUrl = ${baseUrl}`)
  console.log(`  model   = ${model}`)
  console.log('  apiKey  = <read from env, not echoed>')

  const sql = postgres(url, { connection: { search_path: 'fonto' }, onnotice: () => {} })
  const encryptedApiKey = encryptSecret(apiKey)

  try {
    const existing = await sql`SELECT id, is_default FROM fonto.ai_connections WHERE user_id = ${userId} ORDER BY created_at`

    if (existing.length === 0) {
      await sql`
        INSERT INTO fonto.ai_connections (user_id, label, base_url, model, encrypted_api_key, is_default)
        VALUES (${userId}, ${label}, ${baseUrl}, ${model}, ${encryptedApiKey}, true)`
      console.log('created a new default connection')
    } else {
      const chosen = existing.find((r) => r.is_default) ?? existing[0]
      await sql`UPDATE fonto.ai_connections SET is_default = false WHERE user_id = ${userId}`
      await sql`
        UPDATE fonto.ai_connections
        SET label = ${label}, base_url = ${baseUrl}, model = ${model},
            encrypted_api_key = ${encryptedApiKey}, is_default = true, updated_at = now()
        WHERE id = ${chosen.id}`
      console.log(`updated connection ${chosen.id} (set as default)`)
    }

    const rows = await sql`SELECT id, label, is_default FROM fonto.ai_connections WHERE user_id = ${userId}`
    console.log('now configured:', JSON.stringify(rows))
  } finally {
    await sql.end({ timeout: 5 })
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
