-- Nightshade Arcade — the open run, and which cabinet it belongs to.
--
-- ## Why this table exists
--
-- `Claim-Raven-Coin` used to mint on the caller's word: hold a voucher, send
-- `claim-result`, receive a coin. The voucher proved only that a run had been
-- *opened* — never that it was played, let alone won, and never which cabinet
-- it was for.
--
-- Verification fixes that only if the worker knows **which cabinet the claim is
-- about**. It cannot take that from the claim itself: the browser chooses that
-- field, so a player aiming at a verified cabinet would simply name an
-- unverified one and drop back to the trusting route. The cabinet therefore has
-- to be fixed at the moment the run is *opened* — a separate request, made
-- before any claim, whose answer the claim cannot rewrite.
--
-- One row per farm: a player has one run open at a time, and the voucher is a
-- single item, so the primary key on `farm_id` is both the constraint and the
-- deduplication. Re-opening overwrites, which is correct — the older run's
-- voucher was consumed by the newer open.
--
-- Deleted when the run is claimed or voided, so a claim can never read a
-- cabinet left over from a run that already paid out.
CREATE TABLE IF NOT EXISTS active_runs (
  farm_id    INTEGER PRIMARY KEY,
  -- Registry id of the cabinet that opened the run ('' for the arcade-wide
  -- allowance, which names no cabinet of its own).
  cabinet    TEXT    NOT NULL,
  opened_at  INTEGER NOT NULL
);
