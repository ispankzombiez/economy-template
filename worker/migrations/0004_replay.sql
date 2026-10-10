-- Nightshade Arcade — a replay in progress, and the verdict it eventually earns.
--
-- ## Why replay is parked rather than done in one request
--
-- Re-simulating a claimed run is the only anti-cheat a player cannot forge: the
-- worker rebuilds the match from `(seed, champion, difficulty)` and feeds it the
-- player's own per-tick inputs, then reads the score that falls out. But a run
-- to the finale is ~10,000 ticks and a Worker gets 10 ms of CPU per request, so
-- the whole replay cannot fit in one call.
--
-- `replay_state` is therefore the *rest* of a replay between two slices of work.
-- Each request advances up to `CHUNK_TICKS` ticks and writes the match back;
-- the next request resumes from it. This is the same shape as the chunked
-- continuation the other half of this table's life depends on — see
-- `continue-verification` in the worker.
--
-- ## Why the state is JSON, and why that is safe
--
-- `MatchState` is plain data: numbers, strings, booleans and arrays of the
-- same. It holds no functions, no class instances and no cycles, so it
-- round-trips through JSON unchanged. That matters more than it sounds — the
-- replay only reproduces the client's run if the resumed state is *bit-identical*
-- to the state the client stepped, and any field JSON cannot express (a `NaN`,
-- an `Infinity`, a `undefined` inside an array) would silently diverge. The
-- engine keeps none of those in the simulation; the two `Math.random` sites
-- that remain are confined to `renderMatch` and are never stepped here.
--
-- One row per farm, keyed the same way `active_runs` is: a player has one run
-- open at a time, so the primary key is both the constraint and the
-- deduplication. A new claim overwrites an unfinished replay, which is correct
-- — the older replay describes a run that can no longer pay out.
CREATE TABLE IF NOT EXISTS replay_state (
  farm_id    INTEGER PRIMARY KEY,
  -- Serialized `MatchState` plus the replay cursor, as JSON. Large-ish (a
  -- mid-run match is a few KB) but bounded: the engine's entity lists are
  -- capped by the wave table, so it does not grow without limit.
  state      TEXT    NOT NULL,
  -- How many ticks of the log have been re-simulated so far, and how many the
  -- log holds in total. Kept out of the JSON so a progress read — and the
  -- "is this replay finished" test — does not have to parse the whole state.
  cursor     INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  -- Identity of the run this replay belongs to: `active_runs.opened_at`. Read,
  -- never sent, so a claim cannot choose it — see migration 0005 for why the
  -- park has to be bound to a run rather than to a moment.
  run_key    INTEGER NOT NULL
);

-- Verdicts, one row per replayed claim.
--
-- Kept even though a replay's verdict does not (yet) decide the payout: Stage B
-- is shadow mode, where the checkpoints still pay and the replay only *records*
-- whether it agreed. That record is the whole point — a match rate measured on
-- real runs is the only way to learn whether replay is safe to enforce before
-- it starts refusing money. Tabled rather than logged to console because it has
-- to survive the isolate and be counted across players.
CREATE TABLE IF NOT EXISTS replay_verdicts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id      INTEGER NOT NULL,
  cabinet      TEXT    NOT NULL,
  -- Whether the re-simulated run produced the claimed outcome. NULL when the
  -- replay could not be completed at all (abandoned, malformed, timed out) —
  -- distinct from 0, which means it *was* completed and disagreed.
  matched      INTEGER,
  -- What the replay produced, for diagnosing a mismatch after the fact. A
  -- mismatch with no numbers beside it is an assertion; with them it is a bug
  -- report.
  replay_score INTEGER,
  claim_score  INTEGER,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_verdicts_farm ON replay_verdicts (farm_id);
