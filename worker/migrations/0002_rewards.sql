-- Nightshade Arcade — reward grants and claims.
--
-- Replaces the KV queue. Two reasons:
--
--   1. **Atomicity.** A claim has to be decidable by the database, not by a
--      read-then-write. Two concurrent claims for one grant both read "not
--      claimed" and both mint. A `UNIQUE` primary key makes that impossible.
--   2. **History.** The KV queue kept one record per reward and overwrote
--      `claimedAt` on it. That cannot answer "has this player ever claimed grant
--      X", which is exactly the question a per-grant id needs answered.
--
-- ## Why grants need unique ids at all
--
-- The old design leaned on the economy's own `requireAbsent` marker to make a
-- reward one-use. That cannot express "the same reward, many times, to the same
-- player": the marker item carries `max: 1`, so the economy refuses the second
-- claim regardless of what our ledger says. Nor can it express "the same reward
-- to many players" without a marker per player, which the editor cannot express.
--
-- So the uniqueness lives here instead. Each grant is its own row with its own
-- id, and a claim is an insert. Repeating a reward is queueing more grants —
-- which is what the owner actually wants to be able to do.

-- One row per reward the owner has sent. `id` is the grant id a player claims
-- against, so it must be globally unique: that is what makes "exactly once"
-- checkable at claim time.
CREATE TABLE IF NOT EXISTS grants (
  id                 TEXT    PRIMARY KEY,
  farm_id            INTEGER NOT NULL,
  action_id          TEXT    NOT NULL,
  label              TEXT    NOT NULL DEFAULT '',
  note               TEXT    NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  created_by         INTEGER NOT NULL,
  created_by_username TEXT   NOT NULL DEFAULT ''
);

-- Grants for one farm, newest first. Mirrors the KV prefix scan this replaces.
CREATE INDEX IF NOT EXISTS grants_farm_created
  ON grants (farm_id, created_at DESC);

-- A claim. `grant_id` is the primary key, and that single constraint is the whole
-- guarantee: the second insert of one grant collides, so the second claim never
-- reaches Sunflower Land. Keyed on the grant alone rather than (farm_id, grant_id)
-- so a grant can never be claimed by two different farms either.
--
-- Written *before* the mint, and `settled_at` marked after. An ambiguous failure
-- therefore leaves a row with `settled_at IS NULL` — evidence that something may
-- have been granted, to be reconciled by hand rather than a silent gap. The same
-- write-ahead pattern `attempts` uses.
-- `claimed_by_username` stores the farm's username at claim time for the audit panel.
CREATE TABLE IF NOT EXISTS claims (
  grant_id            TEXT    PRIMARY KEY,
  farm_id             INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  claimed_at          INTEGER NOT NULL,
  settled_at          INTEGER,
  detail              TEXT,
  claimed_by_username TEXT
);

CREATE INDEX IF NOT EXISTS claims_farm ON claims (farm_id, claimed_at DESC);