import { neon } from "@neondatabase/serverless"
import { Redis } from "@upstash/redis"

// ─────────────────────────────────────────────────────────────────────────────
// Full-system backup / restore.
//
// Produces a single self-contained JSON document that captures EVERYTHING the app
// persists across BOTH backing stores:
//   • Neon (Postgres) — every base table in the `public` schema, dumped row-by-row
//     as JSON via `to_jsonb`, and restored symmetrically with
//     `jsonb_populate_recordset` (which maps columns by name and casts types
//     correctly — jsonb, timestamps, numerics, etc. — so it round-trips exactly).
//   • Upstash (Redis) — every key discovered via SCAN, captured with its data
//     TYPE, remaining TTL, and exact raw value, then restored by type.
//
// The document is fully portable: export from one environment, import into another
// (e.g. restore a production snapshot into staging, or recover after data loss).
//
// These clients are intentionally SEPARATE from lib/db.ts and lib/redis.ts:
//   • The Redis client here disables automatic (de)serialization so values are
//     captured/restored as the exact raw strings Redis holds — no lossy JSON
//     re-encoding round-trips.
//   • The Neon client here is used for raw, dynamic (identifier-interpolated)
//     queries via `.query()`, which the tagged-template proxy in lib/db.ts isn't
//     meant for.
// ─────────────────────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = "cookie-checker-backup"
export const BACKUP_VERSION = 1

export type RedisEntry = {
  key: string
  type: string
  /** Remaining TTL in ms, or -1 for no-expiry (mirrors PTTL semantics). */
  ttl: number
  value: unknown
}

export type BackupDocument = {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  stores: {
    neon: {
      enabled: boolean
      /** table name -> array of row objects */
      tables: Record<string, Record<string, unknown>[]>
    }
    redis: {
      enabled: boolean
      available?: boolean
      error?: string
      keys: RedisEntry[]
    }
  }
  warnings?: string[]
  counts: {
    neon: { tables: number; rows: number }
    redis: { keys: number }
  }
}

export type StoreSelection = { neon: boolean; redis: boolean }

export type ImportSummary = {
  neon: { restored: boolean; tables: number; rows: number }
  redis: { restored: boolean; keys: number }
  errors: string[]
}

const dbUrl = process.env.DATABASE_URL
export const backupDbEnabled = Boolean(dbUrl)
export const backupRedisEnabled = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

// Raw Neon client for dynamic, identifier-interpolated DDL/DML. Returns row arrays.
const rawSql = dbUrl ? neon(dbUrl) : null
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!rawSql) throw new Error("Database (Neon) is not configured.")
  return (await rawSql.query(text, params)) as T[]
}

// Raw Redis client WITHOUT auto (de)serialization so values round-trip byte-exact.
function rawRedisClient(): Redis {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
    automaticDeserialization: false,
  })
}

// Postgres identifiers we build queries from come from the DB itself (export) or a
// backup file (import). Validate them defensively before interpolation so a
// malformed/hostile file can never inject SQL through a table/column name.
function assertIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return name
}

// ── Export ───────────────────────────────────────────────────────────────────

async function exportNeon(): Promise<BackupDocument["stores"]["neon"]> {
  if (!backupDbEnabled) return { enabled: false, tables: {} }

  const tableRows = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )

  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const { table_name } of tableRows) {
    assertIdent(table_name)
    // to_jsonb(row) gives us a complete, type-faithful JSON object per row.
    const rows = await q<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM "${table_name}" t`)
    tables[table_name] = rows.map((r) => r.row)
  }
  return { enabled: true, tables }
}

async function exportRedis(): Promise<BackupDocument["stores"]["redis"]> {
  if (!backupRedisEnabled) return { enabled: false, keys: [] }
  const redis = rawRedisClient()

  // Enumerate every key with SCAN (never KEYS — SCAN is non-blocking / paginated).
  const allKeys: string[] = []
  let cursor = "0"
  do {
    const [next, batch] = (await redis.scan(cursor, { count: 500 })) as [string | number, string[]]
    allKeys.push(...batch)
    // Normalize: Upstash may return the cursor as a number; the terminal cursor is 0.
    cursor = String(next)
  } while (cursor !== "0")

  const keys: RedisEntry[] = []
  for (const key of allKeys) {
    const type = (await redis.type(key)) as string
    const ttl = (await redis.pttl(key)) as number
    let value: unknown = null
    switch (type) {
      case "string":
        value = await redis.get(key)
        break
      case "list":
        value = await redis.lrange(key, 0, -1)
        break
      case "set":
        value = await redis.smembers(key)
        break
      case "zset":
        // [member, score, member, score, …] — captured with scores so ordering
        // and weights restore exactly.
        value = await redis.zrange(key, 0, -1, { withScores: true })
        break
      case "hash":
        value = await redis.hgetall(key)
        break
      default:
        // Unknown/none (key expired mid-scan) — skip.
        continue
    }
    keys.push({ key, type, ttl, value })
  }
  return { enabled: true, keys }
}

export async function exportBackup(selection: StoreSelection = { neon: true, redis: true }): Promise<BackupDocument> {
  const warnings: string[] = []
  const neonStore = selection.neon ? await exportNeon() : { enabled: false, tables: {} }
  let redisStore: BackupDocument["stores"]["redis"] = { enabled: false, available: false, keys: [] }
  if (selection.redis) {
    if (!backupRedisEnabled) {
      const message = "Redis is unavailable; the backup contains all available Neon data but no Redis keys."
      warnings.push(message)
      redisStore = { enabled: true, available: false, error: message, keys: [] }
    } else {
      try {
        redisStore = { ...(await exportRedis()), available: true }
      } catch (err) {
        const message = `Redis export failed: ${err instanceof Error ? err.message : String(err)}`
        warnings.push(message)
        redisStore = { enabled: true, available: false, error: message, keys: [] }
      }
    }
  }

  const rowCount = Object.values(neonStore.tables).reduce((n, rows) => n + rows.length, 0)

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    stores: { neon: neonStore, redis: redisStore },
    warnings: warnings.length ? warnings : undefined,
    counts: {
      neon: { tables: Object.keys(neonStore.tables).length, rows: rowCount },
      redis: { keys: redisStore.keys.length },
    },
  }
}

// ── Import (destructive replace) ──────���������────────────────────────────────────────

// Re-sync any identity/serial sequences on a table so future inserts don't collide
// with restored primary keys.
async function resyncSequences(table: string): Promise<void> {
  const seqCols = await q<{ column_name: string; seq: string | null }>(
    `SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  for (const { column_name, seq } of seqCols) {
    if (!seq) continue
    assertIdent(column_name)
    await q(
      `SELECT setval('${seq}',
         GREATEST((SELECT COALESCE(MAX("${column_name}"), 1) FROM "${table}"), 1),
         (SELECT COUNT(*) > 0 FROM "${table}"))`,
    )
  }
}

async function importNeon(
  tables: Record<string, Record<string, unknown>[]>,
  errors: string[],
): Promise<{ tables: number; rows: number }> {
  let tableCount = 0
  let rowCount = 0

  for (const [table, rows] of Object.entries(tables)) {
    try {
      assertIdent(table)
      // Replace the table's contents wholesale so the restore is authoritative.
      await q(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`)

      if (rows.length > 0) {
        // jsonb_populate_recordset expands the JSON array into correctly-typed
        // rows of the table's own rowtype (columns matched by name).
        await q(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb) ON CONFLICT DO NOTHING`, [
          JSON.stringify(rows),
        ])
        rowCount += rows.length
      }

      await resyncSequences(table)
      tableCount += 1
    } catch (err) {
      errors.push(`Neon table "${table}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { tables: tableCount, rows: rowCount }
}

// Empties every target Neon table once before a chunked restore.
export async function restoreNeonBegin(tables: string[]): Promise<void> {
  if (!backupDbEnabled) throw new Error("Neon is not configured in this environment.")
  if (!tables.length) return
  const idents = tables.map((table) => `"${assertIdent(table)}"`).join(", ")
  await q(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE`)
}

// Inserts a batch into an already-truncated table. Retries are safe.
export async function restoreNeonInsert(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (!backupDbEnabled) throw new Error("Neon is not configured in this environment.")
  assertIdent(table)
  if (!rows.length) return 0
  await q(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb) ON CONFLICT DO NOTHING`, [
    JSON.stringify(rows),
  ])
  return rows.length
}

// Resyncs identity sequences for the given tables after all rows are inserted.
export async function restoreNeonFinalize(tables: string[]): Promise<void> {
  if (!backupDbEnabled) throw new Error("Neon is not configured in this environment.")
  for (const table of tables) {
    assertIdent(table)
    await resyncSequences(table)
  }
}

// Clears the Redis database before a full restore so deleted keys do not survive.
export async function restoreRedisBegin(): Promise<void> {
  if (!backupRedisEnabled) throw new Error("Redis is not configured in this environment.")
  const redis = rawRedisClient()
  const keys: string[] = []
  let cursor = "0"
  do {
    const [next, batch] = (await redis.scan(cursor, { count: 500 })) as [string | number, string[]]
    keys.push(...batch)
    cursor = String(next)
  } while (cursor !== "0")
  for (const batch of batchByCount(keys, 250)) await redis.del(...batch)
}

function* batchByCount<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

// Restores a batch of Redis keys (del + rewrite + reapply TTL), collecting per-key
// errors rather than aborting the whole batch.
export async function restoreRedisChunk(entries: RedisEntry[]): Promise<{ keys: number; errors: string[] }> {
  if (!backupRedisEnabled) throw new Error("Redis is not configured in this environment.")
  const errors: string[] = []
  const res = await importRedis(entries, errors)
  return { keys: res.keys, errors }
}

async function importRedis(entries: RedisEntry[], errors: string[]): Promise<{ keys: number }> {
  const redis = rawRedisClient()
  let restored = 0

  for (const entry of entries) {
    try {
      await redis.del(entry.key)
      switch (entry.type) {
        case "string":
          await redis.set(entry.key, entry.value as string)
          break
        case "list": {
          const items = (entry.value as unknown[]) ?? []
          if (items.length) await redis.rpush(entry.key, ...(items as string[]))
          break
        }
        case "set": {
          const members = (entry.value as unknown[]) ?? []
          if (members.length) await redis.sadd(entry.key, members[0] as string, ...(members.slice(1) as string[]))
          break
        }
        case "zset": {
          // Rebuild {score, member} pairs from the flat [member, score, …] dump.
          const flat = (entry.value as unknown[]) ?? []
          const pairs: { score: number; member: string }[] = []
          for (let i = 0; i < flat.length; i += 2) {
            pairs.push({ member: String(flat[i]), score: Number(flat[i + 1]) })
          }
          if (pairs.length) await redis.zadd(entry.key, pairs[0], ...pairs.slice(1))
          break
        }
        case "hash": {
          const obj = (entry.value as Record<string, unknown>) ?? {}
          if (Object.keys(obj).length) await redis.hset(entry.key, obj)
          break
        }
        default:
          continue
      }
      // Restore remaining TTL when the key had one (PTTL returns -1 for none).
      if (typeof entry.ttl === "number" && entry.ttl > 0) {
        await redis.pexpire(entry.key, Math.max(1, Math.floor(entry.ttl)))
      }
      restored += 1
    } catch (err) {
      errors.push(`Redis key "${entry.key}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { keys: restored }
}

// Validates a parsed object is a backup document we can restore.
const SAFE_REDIS_TYPES = new Set(["string", "list", "set", "zset", "hash"])

export function isBackupDocument(value: unknown): value is BackupDocument {
  if (!value || typeof value !== "object") return false
  const doc = value as Partial<BackupDocument>
  if (doc.format !== BACKUP_FORMAT || doc.version !== BACKUP_VERSION || !doc.stores) return false
  const stores = doc.stores as Partial<BackupDocument["stores"]>
  if (stores.neon?.enabled && (!stores.neon.tables || typeof stores.neon.tables !== "object")) return false
  if (stores.redis?.enabled) {
    if (stores.redis.available === false) return true
    if (!Array.isArray(stores.redis.keys)) return false
    for (const entry of stores.redis.keys) {
      if (!entry || typeof entry.key !== "string" || !/^[^\\s]{1,512}$/.test(entry.key)) return false
      if (!SAFE_REDIS_TYPES.has(entry.type) || typeof entry.ttl !== "number" || entry.ttl < -1) return false
    }
  }
  return true
}

export async function importBackup(
  doc: BackupDocument,
  selection: StoreSelection = { neon: true, redis: true },
): Promise<ImportSummary> {
  const errors: string[] = []
  const summary: ImportSummary = {
    neon: { restored: false, tables: 0, rows: 0 },
    redis: { restored: false, keys: 0 },
    errors,
  }

  if (selection.neon && doc.stores.neon?.enabled) {
    if (!backupDbEnabled) {
      errors.push("Neon is not configured in this environment — skipped Postgres restore.")
    } else {
      const res = await importNeon(doc.stores.neon.tables ?? {}, errors)
      summary.neon = { restored: true, ...res }
    }
  }

  if (selection.redis && doc.stores.redis?.enabled) {
    if (doc.stores.redis.available === false) {
      errors.push(doc.stores.redis.error || "Redis was unavailable when this backup was created — skipped Redis restore.")
    } else if (!backupRedisEnabled) {
      errors.push("Redis is not configured in this environment — skipped Redis restore.")
    } else {
      const res = await importRedis(doc.stores.redis.keys ?? [], errors)
      summary.redis = { restored: true, ...res }
    }
  }

  return summary
}
