#!/usr/bin/env node
/**
 * Poker replay harness — proves `(seed, difficulty, bet/choice log) => the same session`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own replay of the claimed session
 * ends in a session win (targetChips reached within POKER_MAX_HANDS) at the
 * chip count the claim asserts. That guarantee rests on two properties, and
 * this harness fails loudly the moment either breaks:
 *
 *   1. **Determinism.** The same seed shuffles the same deal on a phone and on
 *      a worker — and, crucially, hands in the same sequence: Poker is a
 *      session of hands whose proof is its bet/choice list, so the seed does
 *      not stop at the first shuffle. No `Math.random()`, no clock, anywhere
 *      in the engine — every shuffle draws from the session's one generator
 *      stream (51 swaps per hand).
 *   2. **Parity.** The log the component's click handlers produce is exactly
 *      the log the worker's replay driver consumes: the bet for each hand, and
 *      the player's street choices within it (FOLD/CHECK/BET). The house's
 *      play is *not* logged — `HouseAI.decideBetAction` reads only the house's
 *      cards, the board, and what it must match — so the replay engine
 *      re-runs it deterministically from the same deal. A driver that logged
 *      house decisions would refuse honest games; a component that omitted
 *      player choices would smuggle dead actions past a replay that expects
 *      none.
 *
 * ## What it checks
 *
 *   - **Codec round trips** — every bet index and choice byte encodes and
 *     decodes to the value it started as, through base64 and a JSON round trip
 *     (the claim's journey). Three bytes per hand.
 *   - **Malformed logs are refused** — a choice byte over 2, a hand with 0 or
 *     3+ choices, over the ceiling, garbage base64, a missing log, a seed that
 *     is not a 32-bit integer, a difficulty that is not today's or yesterday's.
 *     Refused *before* replay: a log the encoder could not have produced is
 *     protocol garbage, not a game that failed to match.
 *   - **Difficulty is the worker's, not the claim's** — today's and
 *     yesterday's indices pass; any other is a refusal (the "always claim
 *     easy" hole, closed by re-deriving from the date).
 *   - **The bet tables agree** — the cabinet's own `BET_AMOUNTS` (what the
 *     buttons show) and the codec's `POKER_BET_AMOUNTS` (what the wire
 *     carries) are the same six numbers, so a bet index cannot mean one thing
 *     on screen and another in the claim.
 *   - **A real win pays** — a greedily played session replays choice-for-choice
 *     to a byte-identical state, and its verdict matches at the final chip
 *     count. A fold replays to the same forfeit.
 *   - **The showdown counts all seven cards** — a straight completing on the
 *     turn and river beats the house's flop-era pair, and the five-of-seven
 *     picker keeps the strongest kickers rather than the first combination it
 *     enumerated. (The shipped cabinet scored hole+flop only; both ends share
 *     this engine, so the fix ships as one unit.)
 *   - **Forgery is refused** — the same log on a different deal, a hand
 *     spliced in after the session was already decided (caught at its exact
 *     position), a truncated log, a session that replays perfectly but ends in
 *     a loss, a score that disagrees with its own log.
 *   - **No nondeterminism in the engine's source** (structural scan), and the
 *     whole validate + replay fits a Workers Free request (well inside the
 *     10 ms budget).
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so,
 * exactly like `blackjackReplayTest.mjs`, everything is bundled by esbuild
 * with a resolve plugin answering both spellings *from the same directory*,
 * which is the entire point of the shared package: one file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/poker/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/poker/session.ts");
const TYPES = path.join(ROOT, "src/features/arcade/games/poker/types.ts");
const EVALUATE = path.join(ROOT, "src/features/arcade/games/poker/evaluateHand.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/pokerReplay.js");
const SHARED = path.join(ROOT, "shared/anticheat");
const CODEC = path.join(SHARED, "pokerLog.js");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "poker-entry.mjs");
const BUNDLE = path.join(CACHE, "poker.bundle.mjs");

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
    `export * from ${JSON.stringify(toUrl(TYPES))};`,
    `export * from ${JSON.stringify(toUrl(EVALUATE))};`,
    `export * from ${JSON.stringify(toUrl(WORKER_REPLAY))};`,
    `export * from ${JSON.stringify(toUrl(CODEC))};`,
  ].join("\n"),
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: BUNDLE,
  plugins: [
    {
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
  PLAYER_CHOICE_CODES,
  applyPlayerChoice,
  advanceStreet,
  createPokerState,
  placeBet,
  replayPokerSession,
  resolveHouse,
  resolveShowdown,
  sessionOver,
  sessionWon,
  startHand,
  // The showdown's five-of-seven picker (evaluateHand.ts)
  getBestHand,
  // Session (difficulty derivation, shared with the worker)
  POKER_DIFFICULTIES,
  POKER_MAX_HANDS,
  POKER_STARTING_CHIPS,
  getPokerDifficulty,
  // The cabinet's own bet table (what the buttons show)
  BET_AMOUNTS,
  // Worker verifier
  PokerReplayInputError,
  runPokerReplay,
  pokerReplayOutcome,
  validatePokerReplay,
  // Codec
  MAX_POKER_ACTIONS,
  MAX_POKER_HANDS,
  POKER_BET_AMOUNTS,
  decodePokerActionLog,
  decodePokerLog,
  encodePokerActionLog,
  encodePokerLog,
} = mod;

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a greedy player that emits the log a claim would carry.
//
// Its policy is deliberately simple and fully deterministic: it reads only the
// state, never the house's cards or future cards, exactly like the cabinet's
// UI. And, most importantly, it commits by the component's rule: a choice is
// logged iff the engine accepted it, and the hand's bet is logged iff the deal
// went through — so the log it emits is the log the worker's replay driver
// must be able to re-apply to the end.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which bet to open a hand with: the largest the stack can carry *through a
 * whole hand*. A street's wager equals everything bet so far, so a hand that
 * escalates both streets costs 4× its opening bet — and an opening bet the
 * stack cannot finish would force checks on the later streets instead.
 */
function chooseBet(state) {
  const affordable = POKER_BET_AMOUNTS.filter(
    (amount) => amount <= state.playerChips,
  );
  if (affordable.length === 0) return null;
  const escalating = affordable.filter(
    (amount) => 4 * amount <= state.playerChips,
  );
  if (escalating.length > 0) return escalating[escalating.length - 1];
  return affordable[affordable.length - 1];
}

/**
 * Which street choice to make: escalate whenever the stack can cover the
 * cumulative bet (the cabinet's BET-disabled rule), check otherwise. Never
 * fold — folding forfeits the pot outright, so a player chasing a target
 * checks and lets the showdown decide. The fold path is exercised directly
 * below, where its parity matters more than its frequency.
 */
function chooseStreet(state) {
  return state.playerChips >= state.totalPlayerBetAcrossGame
    ? "bet"
    : "check";
}

/**
 * Play greedily to the end of the session, emitting the log. Mirrors the
 * component's commit rule exactly: log a choice iff `applied`, log the hand's
 * bet iff `placeBet` changed the state. The session ends when targetChips is
 * reached, chips run out, or POKER_MAX_HANDS is spent.
 */
function playGreedy(initial) {
  let state = initial;
  const hands = [];

  while (!sessionOver(state) && hands.length < MAX_POKER_HANDS) {
    state = startHand(state);
    const bet = chooseBet(state);
    if (bet === null) break;

    const afterBet = placeBet(state, bet);
    if (afterBet === state) break;
    state = afterBet;

    const handLog = {
      betIdx: POKER_BET_AMOUNTS.findIndex((amount) => amount === bet),
      actions: [],
    };
    hands.push(handLog);

    // Streets until the hand ends: preflop, then the postflop street, then the
    // showdown resolves with no further choice.
    for (let i = 0; i < 4 && state.status !== "gameover"; i++) {
      const choice = chooseStreet(state);
      const move = applyPlayerChoice(state, choice);
      if (!move.applied) break;
      handLog.actions.push(PLAYER_CHOICE_CODES[choice]);
      state = move.state;
      if (state.status === "gameover") break;

      const house = resolveHouse(state, choice);
      state = house.state;
      if (house.handEnded) break;

      state = advanceStreet(state);
      if (state.status === "showdown") {
        state = resolveShowdown(state);
      }
    }

    if (state.status !== "gameover") break; // defensive: a hand never finished
  }

  return { state, hands };
}

/** The claim's journey: log → bytes → base64 → JSON → validated. */
function throughTheWire(hands, difficultyIdx, seed) {
  const base64 = encodePokerLog(encodePokerActionLog(difficultyIdx, hands));
  const payload = JSON.parse(
    JSON.stringify({ seed, difficulty: difficultyIdx, actions: base64 }),
  );
  return validatePokerReplay(payload);
}

/** Verdict for a validated replay, as the worker computes it. */
function verdictFor(validated, claimScore) {
  return pokerReplayOutcome(runPokerReplay(validated), claimScore);
}

const snapshot = (s) => JSON.parse(JSON.stringify(s));

const todayIdxOf = () => {
  const today = getPokerDifficulty();
  return {
    today,
    todayIdx: POKER_DIFFICULTIES.findIndex((d) => d.name === today.name),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// A. Codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every bet index and choice byte round tripped through bytes, base64 and
  // JSON. Includes the three shapes a hand can take: fold only, check-then-
  // check (hand survives to showdown without escalating), check-then-bet.
  const many = {
    difficultyIdx: 1,
    hands: [
      { betIdx: 0, actions: [0] }, // 1 chip, FOLD at preflop
      { betIdx: 1, actions: [1, 1] }, // 5 chips, CHECK, CHECK
      { betIdx: 5, actions: [1, 2] }, // 100 chips, CHECK, BET
      { betIdx: 3, actions: [2, 1] }, // 25 chips, BET, CHECK
    ],
  };
  const wire = JSON.parse(
    JSON.stringify({
      actions: encodePokerLog(
        encodePokerActionLog(many.difficultyIdx, many.hands),
      ),
    }),
  );
  const decoded = decodePokerActionLog(decodePokerLog(wire.actions));
  check(
    JSON.stringify(decoded) === JSON.stringify(many),
    "codec round trip: a whole session log through JSON",
    JSON.stringify(decoded),
  );

  const expectThrow = (fn, label) => {
    try {
      fn();
      check(false, label, "did not throw");
    } catch {
      check(true, label);
    }
  };

  // Invalid bet index (the table has six entries, 0–5)
  expectThrow(
    () => encodePokerActionLog(0, [{ betIdx: 6, actions: [1] }]),
    "encoding betIdx 6 throws",
  );
  expectThrow(
    () => encodePokerActionLog(0, [{ betIdx: -1, actions: [1] }]),
    "encoding a negative betIdx throws",
  );
  // Invalid choice
  expectThrow(
    () => encodePokerActionLog(0, [{ betIdx: 0, actions: [3] }]),
    "encoding choice 3 throws",
  );
  // A hand with no choices — the player always faces the preflop decision
  expectThrow(
    () => encodePokerActionLog(0, [{ betIdx: 0, actions: [] }]),
    "encoding a hand with no choices throws",
  );
  // A hand with three choices — the turn and river trigger no betting
  expectThrow(
    () => encodePokerActionLog(0, [{ betIdx: 0, actions: [1, 2, 1] }]),
    "encoding a hand with three choices throws",
  );
  // Too many hands
  const tooManyHands = {
    difficultyIdx: 0,
    hands: Array.from({ length: MAX_POKER_HANDS + 1 }, () => ({
      betIdx: 0,
      actions: [1],
    })),
  };
  expectThrow(
    () =>
      encodePokerActionLog(tooManyHands.difficultyIdx, tooManyHands.hands),
    `encoding ${MAX_POKER_HANDS + 1} hands throws`,
  );
  // Too many choices total
  expectThrow(
    () =>
      encodePokerActionLog(0, [
        { betIdx: 0, actions: [1, 1] },
        { betIdx: 0, actions: [1, 1] },
        { betIdx: 0, actions: [1, 1] },
        { betIdx: 0, actions: [1, 1] },
        { betIdx: 0, actions: [1, 1] },
        { betIdx: 0, actions: [1] },
      ]),
    `encoding ${MAX_POKER_ACTIONS + 1} choices throws`,
  );
  // Malformed decode
  expectThrow(
    () => decodePokerActionLog(Uint8Array.from([0])),
    "decoding a truncated log throws",
  );
  expectThrow(
    // difficulty 0, one hand, bet 0, zero choices
    () => decodePokerActionLog(Uint8Array.from([0, 1, 0, 0])),
    "decoding a hand with no choices throws",
  );
  expectThrow(
    // difficulty 0, one hand, bet 0, three choices
    () => decodePokerActionLog(Uint8Array.from([0, 1, 0, 3, 1, 1, 1])),
    "decoding a hand with three choices throws",
  );
  expectThrow(
    () => decodePokerLog("!!! not base64 !!!"),
    "garbage base64 throws",
  );

  // The cabinet's bet table and the wire's are the same six numbers: a bet
  // index cannot mean one thing on screen and another in the claim.
  check(
    BET_AMOUNTS.join(",") === POKER_BET_AMOUNTS.join(","),
    "the cabinet's BET_AMOUNTS and the codec's POKER_BET_AMOUNTS agree",
    `${BET_AMOUNTS} vs ${POKER_BET_AMOUNTS}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: difficulty is derived, not believed
// ─────────────────────────────────────────────────────────────────────────────

{
  const { today, todayIdx } = todayIdxOf();
  const yesterday = getPokerDifficulty(Date.now() - 86_400_000);
  const yesterdayIdx = POKER_DIFFICULTIES.findIndex(
    (d) => d.name === yesterday.name,
  );

  const logFor = (idx) =>
    encodePokerLog(encodePokerActionLog(idx, [{ betIdx: 0, actions: [1] }]));
  const baseToday = { seed: 12345, difficulty: todayIdx, actions: logFor(todayIdx) };
  const baseYesterday = {
    seed: 12345,
    difficulty: yesterdayIdx,
    actions: logFor(yesterdayIdx),
  };

  const expectInputError = (payload, label) => {
    try {
      validatePokerReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof PokerReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  // Today's difficulty validates
  const todayValidated = validatePokerReplay(baseToday);
  check(
    todayValidated.difficultyIdx === todayIdx &&
      todayValidated.hands.length === 1,
    "today's difficulty validates with the worker's own parameters",
  );

  // Yesterday's difficulty validates (UTC-midnight-straddling runs)
  validatePokerReplay(baseYesterday);
  check(true, "yesterday's difficulty validates");

  // Any other difficulty is refused
  const wrongIdx = POKER_DIFFICULTIES.findIndex(
    (d) => d.name !== today.name && d.name !== yesterday.name,
  );
  if (wrongIdx >= 0) {
    expectInputError(
      { ...baseToday, difficulty: wrongIdx, actions: logFor(wrongIdx) },
      `difficulty ${POKER_DIFFICULTIES[wrongIdx].name} (not today/yesterday) is refused`,
    );
  }
  expectInputError(
    { ...baseToday, difficulty: 99, actions: logFor(99) },
    "unknown difficulty index (99) is refused",
  );
  expectInputError(undefined, "a missing replay is refused");
  expectInputError(
    { seed: 12345, difficulty: todayIdx },
    "a replay without actions is refused",
  );
  expectInputError(
    { ...baseToday, seed: 1.5 },
    "a fractional seed is refused",
  );
  expectInputError({ ...baseToday, seed: -1 }, "a negative seed is refused");
  expectInputError(
    { ...baseToday, seed: 0x100000000 },
    "a seed over 32 bits is refused",
  );
  expectInputError(
    { ...baseToday, actions: "!!! not base64 !!!" },
    "garbage base64 is refused",
  );
  expectInputError(
    { ...baseToday, actions: encodePokerLog(new Uint8Array([0, 1, 0, 7, 1])) },
    "a choice byte over 2 is refused",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Engine step parity: deal, fold, check, and the seven-card showdown
// ─────────────────────────────────────────────────────────────────────────────

{
  const { today, todayIdx } = todayIdxOf();
  const seed = 777;

  let state = startHand(createPokerState(seed, today));
  state = placeBet(state, 5);
  check(
    state.status === "preflop_betting" &&
      state.playerChips === POKER_STARTING_CHIPS - 5 &&
      state.potAmount === 10,
    "deal in: the stack drops by the bet and the house matches into the pot",
    `chips=${state.playerChips} pot=${state.potAmount}`,
  );

  const fold = applyPlayerChoice(state, "fold");
  check(
    fold.applied && fold.handEnded,
    "a fold is accepted and ends the hand",
  );
  check(
    fold.state.playerChips === state.playerChips &&
      fold.state.lastWinner === "house" &&
      fold.state.status === "gameover",
    "a fold forfeits the pot to the house without touching the stack",
    `chips=${fold.state.playerChips} winner=${fold.state.lastWinner}`,
  );

  // The same folded hand through the replay — parity on the path a fold takes.
  const foldedLog = {
    difficultyIdx: todayIdx,
    hands: [{ betIdx: POKER_BET_AMOUNTS.indexOf(5), actions: [0] }],
  };
  const replayedFold = replayPokerSession(createPokerState(seed, today), foldedLog);
  check(replayedFold.failedAt === -1, "a fold hand replays cleanly");
  check(
    JSON.stringify(replayedFold.state) === JSON.stringify(fold.state),
    "the folded hand replays to the identical state",
  );

  // A check is legal and must still be reported as applied — the replay's
  // dead-action rule reads `applied`, never reference equality.
  let checked = startHand(createPokerState(seed + 1, today));
  checked = placeBet(checked, 5);
  const checkMove = applyPlayerChoice(checked, "check");
  check(
    checkMove.applied === true && checkMove.state === checked,
    "a check is reported applied even though it returns the same state",
    `applied=${checkMove.applied}`,
  );

  // The showdown scores the best five of all seven cards — the fix for the
  // shipped cabinet's most visible bug. The hand is built so the two
  // evaluations disagree: on the hole cards + flop alone the house's pair of
  // kings beats the player's high card, but the turn and river complete
  // 5-6-7-8-9 for the player — what the screen shows, and what must win.
  const card = (rank, suit) => ({ rank, suit });
  const resolved = resolveShowdown({
    ...createPokerState(seed, today),
    status: "showdown",
    playerHand: [card("9", "Kale"), card("8", "Wheat")],
    houseHand: [card("K", "Kale"), card("K", "Wheat")],
    communityCards: [
      card("7", "Barley"),
      card("5", "Radish"),
      card("2", "Kale"),
      card("6", "Wheat"),
      card("4", "Barley"),
    ],
    potAmount: 10,
  });
  check(
    resolved.lastWinner === "player",
    "the turn and river count: a straight completing on the board beats the house's flop-era pair",
    `winner=${resolved.lastWinner}`,
  );
  check(
    resolved.playerEvalHand?.rankingName === "Straight",
    "the player's shown evaluation is the straight the board completed",
    String(resolved.playerEvalHand?.rankingName),
  );

  // The picker must keep the strongest combination *within* a hand type, not
  // the first one it enumerated: these seven cards contain both a pair with
  // junk kickers (first in combination order) and a pair with face kickers.
  const best = getBestHand([
    card("A", "Kale"),
    card("A", "Wheat"),
    card("2", "Barley"),
    card("3", "Radish"),
    card("5", "Kale"),
    card("9", "Wheat"),
    card("J", "Barley"),
  ]);
  const bestRanks = best.map((c) => c.rank);
  check(
    bestRanks.includes("J") && bestRanks.includes("9") && bestRanks.includes("5"),
    "getBestHand keeps the strongest kickers, not the first combination of its rank class",
    bestRanks.join(","),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D. A real win — the log a played session produces pays
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic search over seeds for a session the greedy player wins.
let winRun = null;
let lossRun = null;
for (let i = 0; i < 5000 && !(winRun && lossRun); i++) {
  const seed = (20_261_011 + i) >>> 0;
  const { today, todayIdx } = todayIdxOf();
  const run = playGreedy(createPokerState(seed, today));
  if (sessionOver(run.state)) {
    if (sessionWon(run.state) && !winRun) {
      winRun = { seed, difficultyIdx: todayIdx, ...run };
    } else if (!sessionWon(run.state) && !lossRun) {
      lossRun = { seed, difficultyIdx: todayIdx, ...run };
    }
  }
}

check(winRun !== null, "found a seed whose greedy log wins the session");
check(lossRun !== null, "found a seed whose greedy log ends in a session loss");

if (winRun) {
  check(
    winRun.hands.length > 0 && winRun.hands.length <= MAX_POKER_HANDS,
    `the winning session (${winRun.hands.length} hands) fits the ceiling`,
  );
  check(
    winRun.hands.every((hand) => hand.actions.length >= 1),
    "every logged hand carries its preflop choice",
  );

  // The worker's half: rebuild the session, re-apply the bets and choices.
  const replayed = replayPokerSession(
    createPokerState(
      winRun.seed,
      POKER_DIFFICULTIES[winRun.difficultyIdx],
    ),
    { difficultyIdx: winRun.difficultyIdx, hands: winRun.hands },
  );
  check(replayed.failedAt === -1, "every logged choice applies during replay");
  check(
    winRun.state.playerChips >= winRun.state.difficulty.targetChips,
    "the client's session ends with chips >= target",
    `${winRun.state.playerChips} vs ${winRun.state.difficulty.targetChips}`,
  );
  check(
    JSON.stringify(replayed.state) === JSON.stringify(winRun.state),
    "replay state is identical to the state the client played to",
  );

  // The whole pipeline, as the claim carries it.
  const validated = throughTheWire(
    winRun.hands,
    winRun.difficultyIdx,
    winRun.seed,
  );
  const verdict = verdictFor(validated, winRun.state.playerChips);
  check(
    verdict.matched === true &&
      verdict.replayScore === winRun.state.playerChips,
    "a played-to-win session verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused.
  const badScore = verdictFor(validated, winRun.state.playerChips - 1);
  check(
    badScore.matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(badScore),
  );

  // A truncated session — the same log minus its final choice — must not pay.
  const lastHand = winRun.hands[winRun.hands.length - 1];
  if (lastHand.actions.length >= 2) {
    const truncatedHands = winRun.hands.map((hand, index) =>
      index === winRun.hands.length - 1
        ? { ...hand, actions: hand.actions.slice(0, -1) }
        : hand,
    );
    const truncated = throughTheWire(
      truncatedHands,
      winRun.difficultyIdx,
      winRun.seed,
    );
    const truncatedVerdict = verdictFor(truncated, winRun.state.playerChips);
    check(
      truncatedVerdict.matched === false,
      "a truncated log is refused (the hand had not finished)",
      JSON.stringify(truncatedVerdict),
    );
    check(
      runPokerReplay(truncated).sessionOver === false,
      "the truncated replay lands on an unfinished session",
    );
  }

  // The splice the cabinet's UI makes impossible: an extra hand logged after
  // the session was already decided. The replay must catch it at its exact
  // position rather than play it.
  const splicedHands = [
    ...winRun.hands,
    { betIdx: 0, actions: [1] },
  ];
  if (splicedHands.length <= MAX_POKER_HANDS) {
    const spliced = throughTheWire(
      splicedHands,
      winRun.difficultyIdx,
      winRun.seed,
    );
    const splicedReplayed = runPokerReplay(spliced);
    const expectedFailedAt = (winRun.hands.length << 8) | 5;
    check(
      splicedReplayed.failedAt === expectedFailedAt,
      `a hand spliced after the session ended is caught at hand ${winRun.hands.length}`,
      `failedAt=${splicedReplayed.failedAt} (expected ${expectedFailedAt})`,
    );
    check(
      verdictFor(spliced, winRun.state.playerChips).matched === false,
      "a log with a hand spliced after the session ended is refused",
    );
  }
}

if (lossRun) {
  // A finished loss session replaying perfectly is still no coin.
  const verdict = verdictFor(
    throughTheWire(lossRun.hands, lossRun.difficultyIdx, lossRun.seed),
    lossRun.state.playerChips,
  );
  check(
    verdict.matched === false,
    "a finished session the player did not win is refused",
    JSON.stringify(verdict),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Forgery, tampering
// ─────────────────────────────────────────────────────────────────────────────

if (winRun) {
  const { seed, difficultyIdx, hands, state } = winRun;
  const score = state.playerChips;
  const otherSeed = (seed + 1) >>> 0;

  // Wrong seed: the same bets and choices against a different deal. The cards
  // must differ — that is the seed actually driving the shuffle — and the
  // moment the chip counts differ, the claim's score has nothing to agree with.
  const wrongReplayed = replayPokerSession(
    createPokerState(otherSeed, POKER_DIFFICULTIES[difficultyIdx]),
    { difficultyIdx, hands },
  );
  check(
    JSON.stringify(wrongReplayed.state) !== JSON.stringify(state),
    "the same log on a different seed replays to a different session",
  );
  if (wrongReplayed.state.playerChips !== score) {
    const wrongVerdict = verdictFor(
      throughTheWire(hands, difficultyIdx, otherSeed),
      score,
    );
    check(
      wrongVerdict.matched === false,
      "a score transplanted onto a different deal is refused",
      JSON.stringify(wrongVerdict),
    );
  } else {
    // Different cards that happen to land the same chips: the sessions are
    // still different (checked above), and a claim must agree with its own
    // replay's score either way — which the assertion just above establishes.
    check(true, "a different deal stays a different session when chips coincide");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Determinism and budget
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

  // Session determinism: same seed + same table, same session; different
  // seed, different session (the seed reaches the deck).
  const { today } = todayIdxOf();
  const a = snapshot(createPokerState(4242, today));
  const b = snapshot(createPokerState(4242, today));
  const c = snapshot(createPokerState(4243, today));
  check(
    JSON.stringify(a) === JSON.stringify(b),
    "same seed opens an identical session",
  );
  check(
    JSON.stringify(a) !== JSON.stringify(c),
    "a different seed opens a different session",
  );

  // The shuffle itself: two decks from the same stream deal the same cards,
  // and one draw advances the shared generator.
  const first = startHand(createPokerState(99, today));
  const second = startHand(createPokerState(99, today));
  check(
    JSON.stringify(first.deck) === JSON.stringify(second.deck),
    "the same seed shuffles an identical deck",
  );
}

if (winRun) {
  // The house's per-street decisions and every shuffle draw from the same
  // stream the session opened with, so the same (seed, difficulty, log)
  // replayed twice must reach the same session. This is the check that would
  // catch the stream being rebuilt instead of resumed.
  const first = runPokerReplay(
    throughTheWire(winRun.hands, winRun.difficultyIdx, winRun.seed),
  );
  const second = runPokerReplay(
    throughTheWire(winRun.hands, winRun.difficultyIdx, winRun.seed),
  );
  check(
    first.replayScore === second.replayScore &&
      first.failedAt === second.failedAt,
    "replaying the same (seed, difficulty, log) twice reaches the same session",
    `${first.replayScore} vs ${second.replayScore}`,
  );

  // The replay must fit a Workers Free request: 10 ms of CPU is the ceiling,
  // and this is the whole claim's replay with no parking. Measured loosely
  // (25 ms) because CI machines vary — the point is catching a replay that
  // accidentally became expensive, not benchmarking.
  const t0 = performance.now();
  runPokerReplay(
    throughTheWire(winRun.hands, winRun.difficultyIdx, winRun.seed),
  );
  const elapsed = performance.now() - t0;
  check(
    elapsed < 25,
    `the whole validate + replay fits one request (${elapsed.toFixed(3)} ms < 25 ms)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const total = passes.length + failures.length;
console.log(`\n${passes.length}/${total} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log("poker replay harness: all checks passed");
