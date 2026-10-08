-- ============================================================================
-- Full database schema for the cookie-checker app.
--
-- This is the single source of truth for the Postgres (Neon) schema. It is
-- IDEMPOTENT — every statement uses IF NOT EXISTS / ON CONFLICT DO NOTHING — so
-- it is safe to run against a brand-new database OR re-run against an existing
-- one. Run this against any fresh Neon database before pointing the app at it.
--
-- Why this file exists: the original tables were created out-of-band (via the
-- Neon MCP) and never committed, so a fresh/empty database had no schema and the
-- app errored. Keeping the schema here means migrating to a new database is just
-- "run this script, then swap DATABASE_URL".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Saved alive cookies — one table per service. All five are structurally
-- identical; each row is a deduped account keyed by `fingerprint`.
--   fingerprint : sha256 of normalized email (or the cookie when no email) —
--                 UNIQUE so the same account is never stored twice.
--   cookie      : the session string, AES-256-GCM encrypted at rest.
--   raw/profiles/links : parsed account detail as JSONB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_cookies (
  id                 BIGSERIAL PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,
  cookie             TEXT NOT NULL,
  email              TEXT,
  plan               TEXT,
  country_code       TEXT,
  payment_method     TEXT,
  next_billing_cycle TEXT,
  member_since       TEXT,
  phone              TEXT,
  max_streams        INTEGER,
  email_verified     BOOLEAN,
  profiles           JSONB,
  links              JSONB,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_cookies_created_at_idx ON saved_cookies (created_at DESC);
CREATE INDEX IF NOT EXISTS saved_cookies_email_idx ON saved_cookies (lower(email));

CREATE TABLE IF NOT EXISTS saved_prime_cookies (
  id                 BIGSERIAL PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,
  account_id         TEXT,
  cookie             TEXT NOT NULL,
  email              TEXT,
  plan               TEXT,
  country_code       TEXT,
  payment_method     TEXT,
  next_billing_cycle TEXT,
  member_since       TEXT,
  phone              TEXT,
  max_streams        INTEGER,
  email_verified     BOOLEAN,
  profiles           JSONB,
  links              JSONB,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE saved_prime_cookies ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS saved_prime_cookies_account_id_idx ON saved_prime_cookies (account_id);
CREATE INDEX IF NOT EXISTS saved_prime_cookies_created_at_idx ON saved_prime_cookies (created_at DESC);
CREATE INDEX IF NOT EXISTS saved_prime_cookies_email_idx ON saved_prime_cookies (lower(email));

CREATE TABLE IF NOT EXISTS saved_crunchyroll_cookies (
  id                 BIGSERIAL PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,
  account_id         TEXT,
  cookie             TEXT NOT NULL,
  email              TEXT,
  plan               TEXT,
  country_code       TEXT,
  payment_method     TEXT,
  next_billing_cycle TEXT,
  member_since       TEXT,
  phone              TEXT,
  max_streams        INTEGER,
  email_verified     BOOLEAN,
  profiles           JSONB,
  links              JSONB,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE saved_crunchyroll_cookies ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS saved_crunchyroll_cookies_account_id_idx ON saved_crunchyroll_cookies (account_id);
CREATE INDEX IF NOT EXISTS saved_crunchyroll_cookies_created_at_idx ON saved_crunchyroll_cookies (created_at DESC);
CREATE INDEX IF NOT EXISTS saved_crunchyroll_cookies_email_idx ON saved_crunchyroll_cookies (lower(email));

CREATE TABLE IF NOT EXISTS saved_steam_cookies (
  id                 BIGSERIAL PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,
  cookie             TEXT NOT NULL,
  email              TEXT,
  plan               TEXT,
  country_code       TEXT,
  payment_method     TEXT,
  next_billing_cycle TEXT,
  member_since       TEXT,
  phone              TEXT,
  max_streams        INTEGER,
  email_verified     BOOLEAN,
  profiles           JSONB,
  links              JSONB,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_steam_cookies_created_at_idx ON saved_steam_cookies (created_at DESC);
CREATE INDEX IF NOT EXISTS saved_steam_cookies_email_idx ON saved_steam_cookies (lower(email));

CREATE TABLE IF NOT EXISTS saved_spotify_cookies (
  id                 BIGSERIAL PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,
  cookie             TEXT NOT NULL,
  email              TEXT,
  plan               TEXT,
  country_code       TEXT,
  payment_method     TEXT,
  next_billing_cycle TEXT,
  member_since       TEXT,
  phone              TEXT,
  max_streams        INTEGER,
  email_verified     BOOLEAN,
  profiles           JSONB,
  links              JSONB,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_spotify_cookies_created_at_idx ON saved_spotify_cookies (created_at DESC);
CREATE INDEX IF NOT EXISTS saved_spotify_cookies_email_idx ON saved_spotify_cookies (lower(email));

-- ---------------------------------------------------------------------------
-- Reward sessions — LootLabs gateway tokens for the account generator.
-- `unlocked` flips true only via a secret-verified postback; consuming requires
-- status='pending' AND unlocked=true (single-use security boundary).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reward_sessions (
  token        TEXT PRIMARY KEY,
  plan         TEXT,
  country      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  service      TEXT,
  unlocked     BOOLEAN NOT NULL DEFAULT false,
  unlocked_at  TIMESTAMPTZ,
  postback_ip  TEXT,
  -- One-time completion id from the LootLabs postback. Stored under a PARTIAL
  -- unique index (below) so a replayed completion id can never unlock a second
  -- token. markRewardUnlocked() writes this on every postback — the column MUST
  -- exist or the postback throws and sessions stay locked forever.
  lootlabs_unique_id TEXT,
  used_at      TIMESTAMPTZ,
  granted_id   BIGINT,
  purpose      TEXT NOT NULL DEFAULT 'account',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Backfill for pre-existing tables created before newer reward-session fields were added.
  ALTER TABLE reward_sessions ADD COLUMN IF NOT EXISTS lootlabs_unique_id TEXT;
  ALTER TABLE reward_sessions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'account';
CREATE INDEX IF NOT EXISTS reward_sessions_ip_unlocked_idx ON reward_sessions (postback_ip, unlocked_at DESC);
CREATE INDEX IF NOT EXISTS reward_sessions_status_idx ON reward_sessions (status);
-- Replay protection: a given LootLabs completion id may unlock at most one token.
CREATE UNIQUE INDEX IF NOT EXISTS reward_sessions_lootlabs_unique_id_key
  ON reward_sessions (lootlabs_unique_id) WHERE lootlabs_unique_id IS NOT NULL;

-- Access keys and deleted-key replay protection.
CREATE TABLE IF NOT EXISTS access_codes (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  duration_hours INTEGER NOT NULL DEFAULT 24,
  active BOOLEAN NOT NULL DEFAULT true,
  bound_device_id TEXT,
  bound_ip TEXT,
  bound_at TIMESTAMPTZ,
  netflix_limit INTEGER NOT NULL DEFAULT 5,
  prime_limit INTEGER NOT NULL DEFAULT 5,
  crunchyroll_limit INTEGER NOT NULL DEFAULT 5,
  netflix_window TEXT NOT NULL DEFAULT 'day',
  prime_window TEXT NOT NULL DEFAULT 'day',
  crunchyroll_window TEXT NOT NULL DEFAULT 'day',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_type TEXT NOT NULL DEFAULT 'lifetime',
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS access_codes_active_idx ON access_codes (active);
CREATE TABLE IF NOT EXISTS deleted_access_codes (
  code TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Claim analytics — one row per account handed out by the generator.
-- (claim_audit is a legacy alias for backwards compatibility with old backups)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_events (
  id         BIGSERIAL PRIMARY KEY,
  service    TEXT,
  plan       TEXT,
  country    TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_events_created_at_idx ON claim_events (created_at DESC);

-- Backwards-compatible alias table for old backups that reference 'claim_audit'.
-- This allows restores from older database snapshots to work without modification.
CREATE TABLE IF NOT EXISTS claim_audit (
  id         BIGSERIAL PRIMARY KEY,
  service    TEXT,
  plan       TEXT,
  country    TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_audit_created_at_idx ON claim_audit (created_at DESC);

-- ---------------------------------------------------------------------------
-- Metrics. Detail rows (metric_runs) are BOUNDED via retention pruning and feed
-- only recent trend charts; all-time stats live in the fixed-size metric_totals
-- rollup so reads stay cheap and storage stays flat regardless of usage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_runs (
  id               BIGSERIAL PRIMARY KEY,
  total            INTEGER NOT NULL DEFAULT 0,
  alive            INTEGER NOT NULL DEFAULT 0,
  dead             INTEGER NOT NULL DEFAULT 0,
  error            INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  outcome          TEXT,
  error_categories JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_runs_created_at_idx ON metric_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS metric_generations (
  id         BIGSERIAL PRIMARY KEY,
  service    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metric_users (
  ip_hash    TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_users_last_seen_idx ON metric_users (last_seen);

CREATE TABLE IF NOT EXISTS metric_counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

-- Fixed-size lifetime rollup (single row, id = 1).
CREATE TABLE IF NOT EXISTS metric_totals (
  id             SMALLINT PRIMARY KEY DEFAULT 1,
  runs           BIGINT NOT NULL DEFAULT 0,
  total          BIGINT NOT NULL DEFAULT 0,
  alive          BIGINT NOT NULL DEFAULT 0,
  dead           BIGINT NOT NULL DEFAULT 0,
  error          BIGINT NOT NULL DEFAULT 0,
  duration_sum   BIGINT NOT NULL DEFAULT 0,
  duration_count BIGINT NOT NULL DEFAULT 0,
  unique_users   BIGINT NOT NULL DEFAULT 0,
  first_seen     TIMESTAMPTZ,
  last_seen      TIMESTAMPTZ,
  CONSTRAINT metric_totals_singleton CHECK (id = 1)
);
INSERT INTO metric_totals (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
