-- Adds a stable per-account identity column to the Prime pool so duplicate rows for
-- the SAME account (re-captured with a different, rotating cookie string) collapse to
-- one canonical row. Prime exposes no email, so before this the dedup fingerprint fell
-- back to hashing the cookie — a different cookie blob for the same account produced a
-- new fingerprint and therefore a duplicate. account_id holds Amazon's customerID; the
-- save path prefers it for the fingerprint and DELETEs older siblings that share it.
-- Idempotent: safe to run repeatedly.

ALTER TABLE saved_prime_cookies ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS saved_prime_cookies_account_id_idx
  ON saved_prime_cookies (account_id);
