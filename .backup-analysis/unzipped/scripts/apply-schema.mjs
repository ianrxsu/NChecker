import { readFileSync } from "node:fs"
import { neon } from "@neondatabase/serverless"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL not set")
  process.exit(1)
}
const sql = neon(url)
const raw = readFileSync(new URL("./001-init-schema.sql", import.meta.url), "utf8")

// Strip line comments, then split on semicolons into individual statements. The
// neon() HTTP client executes one statement per call, so we run them in sequence.
const cleaned = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
const statements = cleaned
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)

console.log(`Applying ${statements.length} statements...`)
let ok = 0
for (const stmt of statements) {
  try {
    await sql.query(stmt)
    ok++
  } catch (e) {
    console.error("FAILED:", stmt.slice(0, 80).replace(/\s+/g, " "))
    console.error("  ->", e?.message || String(e))
    process.exit(1)
  }
}
console.log(`Done. ${ok}/${statements.length} statements applied.`)

const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
console.log("Tables now present:", tables.map((t) => t.table_name).join(", "))
