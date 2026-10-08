#!/usr/bin/env node

/**
 * Quick fix for backup restore error "relation 'claim_audit' does not exist".
 * Creates the missing claim_audit table schema so old backups can be imported.
 * Run: node scripts/migrate-claim-audit.mjs
 */

import { neon } from "@neondatabase/serverless"

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set. Exiting.")
  process.exit(1)
}

const sql = neon(DATABASE_URL)

const statement = `
  CREATE TABLE IF NOT EXISTS claim_audit (
    id         BIGSERIAL PRIMARY KEY,
    service    TEXT,
    plan       TEXT,
    country    TEXT,
    account_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS claim_audit_created_at_idx ON claim_audit (created_at DESC);
`

async function migrate() {
  try {
    console.log("📦 Creating claim_audit table...")
    const result = await sql.query(statement)
    console.log("✅ Migration complete! claim_audit table is ready.")
    console.log("You can now restore your backup without the 'relation does not exist' error.")
  } catch (err) {
    console.error("❌ Migration failed:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

migrate()
