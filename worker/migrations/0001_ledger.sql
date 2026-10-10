-- Nightshade Arcade — authoritative write ledger.
--
-- Everything the worker lets a player do passes through here. Two tables, two
-- different jobs.
--
-- ## Why D1 and not KV
--
-- The reward queue and the chest tally live in KV, which is fine for both because
-- they are bookkeeping: a stale read costs a leaderboard row, never a payout.
-- This table is different — it gates money, and it needs an atomic
-- read-decide-write. KV is eventually consistent with no atomic
-- read-modify-write, so two concurrent requests for the same daily slot would
-- both read "unused" and both succeed. That is a race, not a bug you can code
-- around.
--
-- D1 is SQLite, so `INSERT` against a primary key *is* the mutual exclusion:
-- the first one wins, the second gets a constraint violation. No read-then-write,
-- no window.

-- One row per entitlement a player has consumed, keyed so that a repeat attempt
-- is a primary-key collision rather than a check that can be raced.
--
--   slot = 'free'                     the arcade-wide daily allowance
--   slot = 'machine:poker'            a VIP's per-cabinet allowance
--   slot = 'chest'                    the entryway chest's daily ticket
CREATE TABLE IF NOT EXISTS daily_slots (
  farm_id    INTEGER NOT NULL,
  utc_day    TEXT    NOT NULL,
  slot       TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (farm_id, utc_day, slot)
);

-- Every write the worker attempts, written *before* the call to Sunflower Land.
--
-- The economies API has no idempotency key, so a timeout leaves us unable to
-- tell "never happened" from "happened and the response was lost". Blindly
-- retrying a mint is a double mint. So the client sends a nonce, we record the
-- intent first, and on an ambiguous failure we reconcile against the session
-- rather than retrying.
--
-- The primary key on `id` is what stops a double-tap, a retry, or a replayed
-- request from running the same intent twice.
CREATE TABLE IF NOT EXISTS attempts (
  id         TEXT    PRIMARY KEY,
  farm_id    INTEGER NOT NULL,
  intent     TEXT    NOT NULL,
  state      TEXT    NOT NULL,          -- 'intent' | 'settled' | 'failed'
  detail     TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS attempts_farm_created
  ON attempts (farm_id, created_at);