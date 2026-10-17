#!/usr/bin/env node
/**
 * Solitaire replay harness — proves `(deal seed, action log) => the same board`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own board reaches all fifty-two
 * cards after re-applying the claimed action log. That guarantee rests on two
 * properties, and this harness exists to fail loudly the moment either breaks:
 *
 *   1. **Determinism.** The same seed deals the same board on a phone and on a
 *      worker — no `Math.random()`, no clock, anywhere in the engine.
 *   2. **Parity.** The log the client's click handlers produce is exactly the
 *      log the worker's replay driver consumes, including undo. A codec that
 *      reads a source field the encoder never wrote would refuse honest games;
 *      a driver that keeps history differently would refuse honest undos.
 *
 * ## What it checks
 *
 *   - **Codec round trips** — every opcode encodes and decodes to the action
 *     it started as, through base64 and a JSON round trip (the claim's journey).
 *   - **Malformed logs are refused** — unknown opcode, out-of-range pile/suit/
 *     target/cardIndex, odd length, over the ceiling, garbage base64. Refused
 *     *before* replay: a log the client's encoder could not have produced is
 *     protocol garbage, not a game that failed to match.
 *   - **Difficulty is the worker's, not the claim's** — today's and
 *     yesterday's names pass; any other is a refusal (the "always claim easy"
 *     hole, closed by re-deriving from the date).
 *   - **A real win pays** — a greedy-played game (the same priority the deal
 *     search certifies with) replays move-for-move to fifty-two cards and its
 *     verdict matches.
 *   - **Forgery is refused** — truncated log, wrong seed, a spliced no-op
 *     move, undo spam, a half-finished game, a score that disagrees with its
 *     own log.
 *   - **Undo parity** — a game played, undone and re-played replays to the
 *     same board, and an undo with empty history is a dead action.
 *   - **No nondeterminism in the engine's source** (structural scan), and the
 *     whole replay fits a Workers Free request (well inside the 10 ms budget).
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so, exactly
 * like `replayContinuationTest.mjs`, everything is bundled by esbuild with a
 * resolve plugin answering both spellings *from the same directory*, which is
 * the entire point of the shared package: one file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/solitaire/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/solitaire/session.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/solitaireReplay.js");
const SHARED = path.join(ROOT, "shared/anticheat");
const CODEC = path.join(SHARED, "solitaireLog.js");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "solitaire-entry.mjs");
const BUNDLE = path.join(CACHE, "solitaire.bundle.mjs");

const passes = [];
const failures = [];
function check(ok, label, detail = "") {
  if (ok) passes.push(label);
  else failures.push(detail ? `${label} — ${detail}` : label);
}

const toUrl = (p) => p.split(path.sep).join("/");

mkdirSync(CACHE, { recursive: true });
writeFileSync(
  ENTRY,
  [
    `export * from ${JSON.stringify(toUrl(ENGINE))};`,
    `export * from ${JSON.stringify(toUrl(SESSION))};`,
    `export * from ${JSON.stringify(toUrl(WORKER_REPLAY))};`,
    `export * from ${JSON.stringify(toUrl(CODEC))};`,
    "",
  ].join("\n"),
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  outfile: BUNDLE,
  loader: { ".png": "empty", ".webp": "empty", ".gif": "empty", ".mp3": "empty" },
  plugins: [
    {
      // Two spellings of one package, and the worker's is *not* the client's.
      // Client code imports `@nightshade/shared/anticheat/<file>`; the worker
      // imports the package subpath `@nightshade/shared/<file>`, resolved by
      // `shared/package.json`'s `exports` map. Neither spelling resolves on its
      // own under a single alias, so both are answered here — from the same
      // directory, which is the whole point of the package: one file, two ends.
      name: "nightshade-shared",
      setup(build_) {
        build_.onResolve({ filter: /^@nightshade\/shared\// }, (args) => {
          const rest = args.path.slice("@nightshade/shared/".length);
          const inAnticheat = path.join(SHARED, `${rest}.js`);
          const asWritten = path.join(ROOT, "shared", `${rest}.js`);
          return { path: existsSync(inAnticheat) ? inAnticheat : asWritten };
        });
      },
    },
  ],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});

const mod = await import(pathToFileURL(BUNDLE).href);
const {
  // Engine
  MAX_UNDOS_PER_GAME,
  SOLITAIRE_WIN_SCORE,
  SUITS,
  RANK_VALUE,
  applySolitaireAction,
  canPlaceOnFoundation,
  canPlaceOnTableau,
  createInitialState,
  createSolvableDeal,
  getFoundationsCount,
  replaySolitaireActions,
  // Session (difficulty derivation, shared with the worker)
  SOLITAIRE_DIFFICULTIES,
  getSolitaireDifficulty,
  // Worker verifier
  SolitaireReplayInputError,
  assertIssuedSeed,
  runSolitaireReplay,
  solitaireReplayOutcome,
  validateSolitaireReplay,
  SOLITAIRE_SEED_WALK,
  // Codec
  MAX_SOLITAIRE_ACTIONS,
  SOLITAIRE_OPS,
  decodeActionLog,
  decodeSolitaireLog,
  encodeAction,
  encodeActionLog,
  encodeSolitaireLog,
} = mod;

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a greedy player that emits the log a claim would carry.
//
// Its move priority mirrors `greedySolve`'s exactly (the search that
// `createSolvableDeal` certifies solvability with), so a deal the client's
// search accepted is a deal this player wins — and, more importantly, every
// action it emits is a state-changing one, exactly like the component: the
// applier returning the same object means the move was illegal, and illegal
// moves are never logged (see `setGameStateWithUndo`).
// ─────────────────────────────────────────────────────────────────────────────

/** One greedy move as the action that makes it, or null when stuck. */
function greedyAction(state) {
  const onPile = (card, i) =>
    canPlaceOnTableau(card, state.tableau[i].faceUp.at(-1));
  const toFnd = (card) => canPlaceOnFoundation(card, state.foundations[card.suit]);

  // 1. Tableau top → foundation
  for (let i = 0; i < 7; i++) {
    const pile = state.tableau[i];
    const top = pile.faceUp[pile.faceUp.length - 1];
    if (top && toFnd(top)) {
      return {
        op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION,
        source: {
          source: "tableau",
          pileIndex: i,
          cardIndex: pile.faceUp.length - 1,
        },
        suit: SUITS.indexOf(top.suit),
      };
    }
  }

  // 2. Waste top → foundation
  const wasteTop = state.waste[state.waste.length - 1];
  if (wasteTop && toFnd(wasteTop)) {
    return {
      op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION,
      source: { source: "waste" },
      suit: SUITS.indexOf(wasteTop.suit),
    };
  }

  // 3. Full stack that reveals a face-down card (prefer most fd)
  {
    let bestFd = 0;
    let bSrc = -1;
    let bDst = -1;
    for (let src = 0; src < 7; src++) {
      const pile = state.tableau[src];
      if (!pile.faceUp.length || !pile.faceDown.length) continue;
      for (let dst = 0; dst < 7; dst++) {
        if (src === dst || !onPile(pile.faceUp[0], dst)) continue;
        if (pile.faceDown.length > bestFd) {
          bestFd = pile.faceDown.length;
          bSrc = src;
          bDst = dst;
        }
      }
    }
    if (bSrc >= 0) {
      return {
        op: SOLITAIRE_OPS.MOVE_TO_TABLEAU,
        source: { source: "tableau", pileIndex: bSrc, cardIndex: 0 },
        target: bDst,
      };
    }
  }

  // 4. Waste top → tableau (prefer piles with most fd)
  if (wasteTop) {
    let best = -1;
    for (let i = 0; i < 7; i++) {
      if (!onPile(wasteTop, i)) continue;
      if (
        best === -1 ||
        state.tableau[i].faceDown.length > state.tableau[best].faceDown.length
      ) {
        best = i;
      }
    }
    if (best >= 0) {
      return { op: SOLITAIRE_OPS.MOVE_TO_TABLEAU, source: { source: "waste" }, target: best };
    }
  }

  // 5. Draw from stock, or recycle the waste
  if (state.stock.length > 0) return { op: SOLITAIRE_OPS.DRAW };
  if (state.passesRemaining > 0 && state.waste.length > 0) {
    return { op: SOLITAIRE_OPS.DRAW };
  }

  // 6. Partial-stack tableau → tableau (skip trivial king cycling)
  for (let src = 0; src < 7; src++) {
    const pile = state.tableau[src];
    for (let start = 0; start < pile.faceUp.length; start++) {
      for (let dst = 0; dst < 7; dst++) {
        if (src === dst || !onPile(pile.faceUp[start], dst)) continue;
        if (
          start === 0 &&
          !pile.faceDown.length &&
          !state.tableau[dst].faceUp.length
        ) {
          continue;
        }
        return {
          op: SOLITAIRE_OPS.MOVE_TO_TABLEAU,
          source: { source: "tableau", pileIndex: src, cardIndex: start },
          target: dst,
        };
      }
    }
  }

  return null;
}

/**
 * Play greedily, emitting the log. Mirrors the component's commit rule:
 * an action is logged iff its applier changed the state.
 */
function playGreedy(initial, drawCount, cap = 3000) {
  let state = initial;
  const actions = [];
  for (let i = 0; i < cap; i++) {
    const action = greedyAction(state);
    if (!action) break;
    const next = applySolitaireAction(state, action, drawCount);
    if (next === state) break; // would be an emitter bug — caught by the win checks
    actions.push(action);
    state = next;
  }
  return { state, actions };
}

/** The claim's journey: log → bytes → base64 → JSON → decoded actions. */
function throughTheWire(actions, difficultyName, seed) {
  const base64 = encodeSolitaireLog(encodeActionLog(actions));
  const payload = JSON.parse(
    JSON.stringify({ seed, difficulty: difficultyName, actions: base64 }),
  );
  return validateSolitaireReplay(payload);
}

/** Verdict for a validated replay, as the worker computes it. */
function verdictFor(validated, claimScore = SOLITAIRE_WIN_SCORE) {
  return solitaireReplayOutcome(runSolitaireReplay(validated), claimScore);
}

const snapshot = (s) => JSON.parse(JSON.stringify(s));

// ─────────────────────────────────────────────────────────────────────────────
// A. Codec
// ─────────────────────────────────────────────────────────────────────────────

{
  const roundTrips = [
    { label: "draw", action: { op: SOLITAIRE_OPS.DRAW } },
    { label: "auto-foundation", action: { op: SOLITAIRE_OPS.AUTO_FOUNDATION } },
    { label: "undo", action: { op: SOLITAIRE_OPS.UNDO } },
    {
      label: "move from waste",
      action: { op: SOLITAIRE_OPS.MOVE_TO_TABLEAU, source: { source: "waste" }, target: 3 },
    },
    {
      label: "move a run from a pile",
      action: {
        op: SOLITAIRE_OPS.MOVE_TO_TABLEAU,
        source: { source: "tableau", pileIndex: 5, cardIndex: 2 },
        target: 6,
      },
    },
    {
      label: "foundation from waste",
      action: { op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION, source: { source: "waste" }, suit: 2 },
    },
    {
      label: "foundation from pile top",
      action: {
        op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION,
        source: { source: "tableau", pileIndex: 0, cardIndex: 0 },
        suit: 1,
      },
    },
    {
      label: "smart from waste",
      action: { op: SOLITAIRE_OPS.SMART, source: { source: "waste" } },
    },
    {
      label: "smart from a mid-run card",
      action: {
        op: SOLITAIRE_OPS.SMART,
        source: { source: "tableau", pileIndex: 4, cardIndex: 3 },
      },
    },
  ];

  for (const { label, action } of roundTrips) {
    const decoded = decodeActionLog(
      decodeSolitaireLog(encodeSolitaireLog(encodeActionLog([action]))),
    );
    check(
      decoded.length === 1 && JSON.stringify(decoded[0]) === JSON.stringify(action),
      `codec round trip: ${label}`,
      JSON.stringify(decoded[0]),
    );
  }

  // A whole game's worth, through base64 and a JSON round trip.
  const many = roundTrips.map((r) => r.action);
  const wire = JSON.parse(
    JSON.stringify({
      actions: encodeSolitaireLog(encodeActionLog(many)),
    }),
  );
  check(
    JSON.stringify(decodeActionLog(decodeSolitaireLog(wire.actions))) ===
      JSON.stringify(many),
    "codec round trip: a whole multi-action log through JSON",
  );
}

// Malformed logs — refused by the decoder, before any replay.
{
  const expectThrow = (fn, label) => {
    try {
      fn();
      check(false, label, "did not throw");
    } catch {
      check(true, label);
    }
  };

  expectThrow(() => decodeActionLog(Uint8Array.from([0])), "odd-length log throws");
  expectThrow(
    () => decodeActionLog(Uint8Array.from([(6 << 4) | 0, 0])),
    "unknown opcode (6) throws",
  );
  expectThrow(
    () => decodeActionLog(Uint8Array.from([SOLITAIRE_OPS.DRAW | 8, 0])),
    "source nibble out of range (8) throws",
  );
  expectThrow(
    () =>
      decodeActionLog(
        Uint8Array.from([(SOLITAIRE_OPS.MOVE_TO_TABLEAU << 4) | 1, 7]),
      ),
    "target pile 7 throws",
  );
  expectThrow(
    () => decodeSolitaireLog("!!! not base64 !!!"),
    "garbage base64 throws",
  );
  expectThrow(
    () =>
      encodeAction({
        op: SOLITAIRE_OPS.MOVE_TO_TABLEAU,
        source: { source: "tableau", pileIndex: 9, cardIndex: 0 },
        target: 0,
      }),
    "encoding an out-of-range source pile throws",
  );

  // Over the ceiling: MAX+1 two-byte actions.
  const over = new Uint8Array((MAX_SOLITAIRE_ACTIONS + 1) * 2);
  let threw = false;
  try {
    decodeActionLog(over);
  } catch {
    threw = true;
  }
  check(threw, `a log of ${MAX_SOLITAIRE_ACTIONS + 1} actions throws (over the ceiling)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: difficulty is derived, not believed
// ─────────────────────────────────────────────────────────────────────────────

const today = getSolitaireDifficulty();
const yesterday = getSolitaireDifficulty(Date.now() - 86_400_000);

{
  const dummyActions = encodeSolitaireLog(
    encodeActionLog([{ op: SOLITAIRE_OPS.DRAW }]),
  );
  const base = { seed: 12345, actions: dummyActions };

  const expectInputError = (payload, label) => {
    try {
      validateSolitaireReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof SolitaireReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const todayValidated = validateSolitaireReplay({ ...base, difficulty: today.name });
  check(
    todayValidated.difficulty.name === today.name &&
      todayValidated.difficulty.drawCount === today.drawCount,
    "today's difficulty validates with the worker's own parameters",
  );

  validateSolitaireReplay({ ...base, difficulty: yesterday.name });
  check(true, "yesterday's difficulty validates (UTC-midnight-straddling runs)");

  const wrongName = SOLITAIRE_DIFFICULTIES.map((d) => d.name).find(
    (n) => n !== today.name && n !== yesterday.name,
  );
  expectInputError(
    { ...base, difficulty: wrongName },
    "a difficulty that is neither today's nor yesterday's is refused",
  );
  expectInputError({ ...base, difficulty: "expert" }, 'an unknown difficulty ("expert") is refused');
  expectInputError(undefined, "a missing replay is refused");
  expectInputError({ ...base }, "a replay without a difficulty is refused");
  expectInputError({ ...base, difficulty: today.name, seed: 1.5 }, "a fractional seed is refused");
  expectInputError({ ...base, difficulty: today.name, seed: -1 }, "a negative seed is refused");
  expectInputError({ ...base, difficulty: today.name, actions: "" }, "an empty action log is refused");
  expectInputError({ ...base, difficulty: today.name, actions: "AAEC" }, "a malformed (odd-byte) log is refused");
}

// ─────────────────────────────────────────────────────────────────────────────
// B2. The issued-seed binding: a claim's deal seed must be one the server's
//     base seed could have walked to.
//
// This is the window check that keeps a claim from naming a seed it shopped
// for across the whole 32-bit space. The client's `createSolvableDeal` walks
// `(base + i) >>> 0` forward for i in [0, 100), so the binding accepts exactly
// that window and refuses everything else — including a base that is absent
// altogether (a run opened before the seed column existed), which must fail
// closed rather than coerce to `0` and bind.
// ─────────────────────────────────────────────────────────────────────────────

{
  const expectBindingError = (resolved, base, label) => {
    try {
      assertIssuedSeed(resolved, base);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof SolitaireReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };
  const expectBindingOk = (resolved, base, label) => {
    try {
      assertIssuedSeed(resolved, base);
      check(true, label);
    } catch (error) {
      check(false, label, `unexpected throw: ${error}`);
    }
  };

  const base = 1_000_000_000;

  // The honest cases: the walk stopped on its first try (resolved === base), or
  // landed forward inside the window.
  expectBindingOk(base, base, "the base seed itself binds (a deal on the first try)");
  expectBindingOk(base + 1, base, "one step forward binds");
  expectBindingOk(
    base + (SOLITAIRE_SEED_WALK - 1),
    base,
    "the last in-window seed binds",
  );

  // Just past the window: no honest walk reaches this, so it can only be a seed
  // the caller chose.
  expectBindingError(
    base + SOLITAIRE_SEED_WALK,
    base,
    "a seed one past the walk window is refused",
  );
  expectBindingError(base + 10_000, base, "a far-forward (shopped) seed is refused");
  expectBindingError(base - 1, base, "a seed behind the base is refused (the walk goes forward only)");
  expectBindingError(0, base, "an unrelated seed is refused");

  // The run has no issued seed at all: `null`/`undefined` must be rejected as
  // missing, not coerced to `0` and bound.
  expectBindingError(base, null, "a run whose issued seed is null fails closed");
  expectBindingError(base, undefined, "an undefined base fails closed");
  expectBindingError(base, "1000", "a non-numeric base fails closed");

  // The 2^32 wraparound the client's `(seed + i) >>> 0` performs: a base near
  // the top of the range walks across zero, and the binding must follow.
  const nearTop = 0xfffffffe;
  expectBindingOk(
    (nearTop + 3) >>> 0,
    nearTop,
    "a seed across the 2^32 wrap binds (the walk wraps too)",
  );
  expectBindingError(
    (nearTop + SOLITAIRE_SEED_WALK) >>> 0,
    nearTop,
    "a wrapped seed past the window is refused",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win — the log a played game produces pays
// ─────────────────────────────────────────────────────────────────────────────

let deal = null;
let played = null;
{
  // Deterministic search: the first seed where the greedy log actually wins.
  // (With the priorities aligned it should be the very first certified deal,
  // but the search keeps this honest — and stable — if a priority ever shifts.)
  for (let i = 0; i < 50 && !deal; i++) {
    const candidate = createSolvableDeal(
      20_261_010 + i,
      today.maxPasses,
      today.drawCount,
    );
    const run = playGreedy(candidate.state, today.drawCount);
    if (
      getFoundationsCount(run.state) === SOLITAIRE_WIN_SCORE &&
      run.actions.length > 0
    ) {
      deal = candidate;
      played = run;
    }
  }

  check(deal !== null && played !== null, "found a deal whose greedy log wins");
}

if (deal && played) {
  check(
    played.actions.length < MAX_SOLITAIRE_ACTIONS,
    `the winning log (${played.actions.length} actions) fits the ceiling`,
  );

  // The worker's half: rebuild the deal, re-apply the log.
  const workerState = createInitialState(deal.seed, today.maxPasses);
  const replayed = replaySolitaireActions(
    workerState,
    played.actions,
    today.drawCount,
  );
  check(replayed.failedAt === -1, "every logged action applies during replay");
  check(
    replayed.undoCount === 0 && replayed.undoLimitExceeded === false,
    "a game without undos reports none",
  );
  check(
    getFoundationsCount(replayed.state) === SOLITAIRE_WIN_SCORE,
    "the replayed board reaches all fifty-two cards",
    `got ${getFoundationsCount(replayed.state)}`,
  );
  check(
    JSON.stringify(replayed.state) === JSON.stringify(played.state),
    "replay state is identical to the state the client played to",
  );

  // The whole pipeline, as the claim carries it.
  const validated = throughTheWire(
    played.actions,
    today.name,
    deal.seed,
  );
  const verdict = verdictFor(validated);
  check(
    verdict.matched === true && verdict.replayScore === SOLITAIRE_WIN_SCORE,
    "a played-to-win game verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused: Solitaire
  // pays on a won deal, not on whatever number the caller asserts.
  const badScore = verdictFor(validated, SOLITAIRE_WIN_SCORE - 1);
  check(
    badScore.matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(badScore),
  );

  // A half-finished game — the same log minus its final move — replays
  // perfectly and still pays nothing.
  const truncated = throughTheWire(
    played.actions.slice(0, -1),
    today.name,
    deal.seed,
  );
  const truncatedVerdict = verdictFor(truncated);
  check(
    truncatedVerdict.matched === false && truncatedVerdict.replayScore < SOLITAIRE_WIN_SCORE,
    "a truncated log is refused (the board is not a won deal)",
    JSON.stringify(truncatedVerdict),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Forgery, tampering, undo
// ─────────────────────────────────────────────────────────────────────────────

if (deal && played) {
  const drawCount = today.drawCount;

  // Wrong seed: the same moves against a different deal.
  const wrongSeed = throughTheWire(played.actions, today.name, (deal.seed + 1) >>> 0);
  check(
    verdictFor(wrongSeed).matched === false,
    "the same log on a different deal is refused",
  );

  // A spliced no-op: a foundation move whose suit cannot match the card.
  const pile0Card = deal.state.tableau[0].faceUp[0];
  const wrongSuit = SUITS.indexOf(pile0Card.suit) === 0 ? 1 : 0;
  const spliced = throughTheWire(
    [
      {
        op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION,
        source: { source: "tableau", pileIndex: 0, cardIndex: 0 },
        suit: wrongSuit,
      },
      ...played.actions,
    ],
    today.name,
    deal.seed,
  );
  const splicedReplayed = runSolitaireReplay(spliced);
  check(
    splicedReplayed.failedAt === 0,
    "a spliced no-op move is caught at its exact index",
    `failedAt=${splicedReplayed.failedAt}`,
  );
  check(
    verdictFor(spliced).matched === false,
    "a log with a spliced no-op move is refused",
  );

  // Undo spam: more undos than a game allows.
  const spam = throughTheWire(
    [...played.actions, ...Array.from({ length: MAX_UNDOS_PER_GAME + 1 }, () => ({ op: SOLITAIRE_OPS.UNDO }))],
    today.name,
    deal.seed,
  );
  const spamReplayed = runSolitaireReplay(spam);
  check(
    spamReplayed.undoLimitExceeded === true,
    `undo spam (${MAX_UNDOS_PER_GAME + 1} undos) exceeds the allowance`,
    JSON.stringify(spamReplayed),
  );
  check(verdictFor(spam).matched === false, "undo spam is refused");

  // The allowance boundary: exactly MAX undos is legal (the board is rewound,
  // so the *score* refuses it — but the undo count itself is not the reason).
  const boundary = runSolitaireReplay(
    throughTheWire(
      [...played.actions, ...Array.from({ length: MAX_UNDOS_PER_GAME }, () => ({ op: SOLITAIRE_OPS.UNDO }))],
      today.name,
      deal.seed,
    ),
  );
  check(
    boundary.undoCount === MAX_UNDOS_PER_GAME && boundary.undoLimitExceeded === false,
    `exactly ${MAX_UNDOS_PER_GAME} undos stays within the allowance`,
  );

  // Undo with an empty history: the first action is a dead one.
  const emptyHistory = replaySolitaireActions(
    createInitialState(deal.seed, today.maxPasses),
    [{ op: SOLITAIRE_OPS.UNDO }],
    drawCount,
  );
  check(
    emptyHistory.failedAt === 0,
    "an undo with empty history is a dead action at index 0",
  );
}

// Undo parity: play, undo, re-play — the driver must land on the same board
// the component's own bookkeeping does.
if (deal) {
  const drawCount = today.drawCount;
  let state = deal.state;
  const log = [];
  const history = [];

  // The component's commit rule, exactly: log iff changed, push iff changed.
  const commit = (action) => {
    const next = applySolitaireAction(state, action, drawCount);
    if (next === state) return false;
    history.push(state);
    log.push(action);
    state = next;
    return true;
  };

  let played40 = 0;
  for (let i = 0; i < 40; i++) {
    const action = greedyAction(state);
    if (!action || !commit(action)) break;
    played40 = i + 1;
  }
  check(played40 > 10, "the parity game plays a meaningful prefix");

  // The component's undo rule: pop, log the UNDO, restore.
  let undone = 0;
  for (let i = 0; i < 2 && history.length > 0; i++) {
    state = history.pop();
    log.push({ op: SOLITAIRE_OPS.UNDO });
    undone += 1;
  }
  check(undone === 2, "the parity game undoes twice");

  // Re-play after the undos.
  for (let i = 0; i < 25; i++) {
    const action = greedyAction(state);
    if (!action || !commit(action)) break;
  }

  const replayed = replaySolitaireActions(deal.state, log, drawCount);
  check(replayed.failedAt === -1, "the undo log replays without a dead action");
  check(
    replayed.undoCount === undone,
    `the driver counted exactly ${undone} undos`,
    `got ${replayed.undoCount}`,
  );
  check(
    JSON.stringify(replayed.state) === JSON.stringify(state),
    "undo mid-game: replay lands on the same board as the client",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Determinism and budget
// ─────────────────────────────────────────────────────────────────────────────

{
  const source = readFileSync(ENGINE, "utf8");
  // Strip block comments and line comments first, so prose *about* determinism
  // cannot satisfy a scan that is meant to find code doing the opposite.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check(!/Math\.random\(/.test(code), "engine.ts has no Math.random()");
  check(!/Date\.now\(/.test(code), "engine.ts has no Date.now()");
  check(!/performance\.now\(/.test(code), "engine.ts has no performance.now()");

  // Deal determinism: same seed, same board; different seed, different board.
  const a = snapshot(createInitialState(4242, 3));
  const b = snapshot(createInitialState(4242, 3));
  const c = snapshot(createInitialState(4243, 3));
  check(JSON.stringify(a) === JSON.stringify(b), "same seed deals an identical board");
  check(JSON.stringify(a) !== JSON.stringify(c), "a different seed deals a different board");
}

if (deal && played) {
  // The replay must fit a Workers Free request: 10 ms of CPU is the ceiling,
  // and this is the whole claim's replay with no parking. Measured loosely
  // (25 ms) because CI machines vary — the point is catching a replay that
  // accidentally became expensive, not benchmarking.
  const validated = throughTheWire(played.actions, today.name, deal.seed);
  const t0 = performance.now();
  runSolitaireReplay(validated);
  const elapsed = performance.now() - t0;
  check(
    elapsed < 25,
    `the whole replay fits one request (${elapsed.toFixed(3)} ms < 25 ms)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const total = passes.length + failures.length;
console.log(`\n${passes.length}/${total} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log("solitaire replay harness: all checks passed");
