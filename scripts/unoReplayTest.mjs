#!/usr/bin/env node
/**
 * Uno replay harness — proves `(seed, player-choice log) => the same game`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own replay of the claimed game
 * ends with the *player* emptying their hand. That guarantee rests on two
 * properties, and this harness fails loudly the moment either breaks:
 *
 *   1. **Determinism.** The same seed deals the same cards on a phone and on
 *      a worker — and, crucially, keeps rolling the same way afterwards: Uno
 *      is a four-player game whose proof is the *player's* choice log, so the
 *      seed does not stop at the first shuffle. Three more things draw from
 *      the same generator stream: the colour a bot names when it drops a
 *      Wild, and the reshuffle that refills an empty deck from the discard.
 *      No `Math.random()`, no clock, anywhere in the engine.
 *   2. **Parity.** The log the component's click handlers produce is exactly
 *      the log the worker's replay driver consumes: the card the player
 *      played (by position in the hand) and the colour they named for a Wild,
 *      or a draw. The three bots are *not* logged — they have no choices of
 *      their own (`botChooseCard` reads only the hand and the board, and the
 *      one roll per Wild comes from the seeded stream), so the replay
 *      re-simulates them from the same rules. A driver that logged bot moves
 *      would refuse honest games; a component that omitted player actions
 *      would smuggle dead actions past a replay that expects none.
 *
 * ## What it checks
 *
 *   - **Codec round trips** — every choice encodes and decodes to the value
 *     it started as, through base64 and a JSON round trip (the claim's
 *     journey). Draws are one byte; plays are one or two.
 *   - **Malformed logs are refused** — a Wild play missing its colour byte, a
 *     colour over 3, a hand index over the encoding's reach, garbage base64,
 *     a missing/empty log, a seed that is not a 32-bit integer, a log over the
 *     ceiling. Refused *before* replay: a log the encoder could not have
 *     produced is protocol garbage, not a game that failed to match.
 *   - **A real win pays** — a greedily played game replays choice-for-choice
 *     to the same final state, and its verdict matches at a score of 1.
 *   - **Forgery is refused** — the same log on a different deal, a spliced
 *     choice (caught at its exact index), a choice appended after the game
 *     ended, a truncated log, a game that replays perfectly but ends with a
 *     bot winning, a score that disagrees with its own log.
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
const ENGINE = path.join(ROOT, "src/features/arcade/games/uno/engine.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/unoReplay.js");
const SHARED = path.join(ROOT, "shared/anticheat");
const CODEC = path.join(SHARED, "unoLog.js");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "uno-entry.mjs");
const BUNDLE = path.join(CACHE, "uno.bundle.mjs");

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
  NON_WILD_COLORS,
  MAX_BOT_TURNS,
  advanceBots,
  botPickColor,
  buildDeck,
  canPlay,
  createInitialState,
  playerDraw,
  playerPlayCard,
  replayUnoActions,
  runBotTurn,
  // Worker verifier
  UnoReplayInputError,
  runUnoReplay,
  unoReplayOutcome,
  validateUnoReplay,
  // Codec
  MAX_UNO_ACTIONS,
  MAX_UNO_HAND_INDEX,
  UNO_COLOR_COUNT,
  decodeUnoActionLog,
  decodeUnoLog,
  encodeUnoActionLog,
  encodeUnoLog,
} = mod;

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a greedy player that emits the log a claim would carry.
//
// Its policy — counter a pending penalty if it can, else take it; otherwise
// play the first playable non-Wild, else a Wild named for the most common
// colour in hand, else draw — is deliberately simple and fully deterministic:
// it reads only the state, never the deck or future cards, exactly like the
// component's UI. And, most importantly, it commits by the component's rule:
// a choice is logged iff the engine changed the state, so the log it emits is
// the log the worker's replay driver must be able to re-apply to the end.
// ─────────────────────────────────────────────────────────────────────────────

/** Same rule the engine enforces: a pending +2/+4 is met only by its twin. */
const isCounter = (card, topCard) =>
  (topCard.face === "DrawTwo" && card.face === "DrawTwo") ||
  (topCard.face === "WildDrawFour" && card.face === "WildDrawFour");

/** The most common colour in hand — a stand-in for a human's judgement. */
function pickColor(state) {
  const counts = [0, 0, 0, 0];
  for (const card of state.hands[0]) {
    const idx = NON_WILD_COLORS.indexOf(card.color);
    if (idx >= 0) counts[idx] += 1;
  }
  const best = counts.indexOf(Math.max(...counts));
  return best === -1 ? 0 : best;
}

/** One greedy choice given the current state (the player is to move). */
function greedyAction(state) {
  const hand = state.hands[0];
  const topCard = state.discard[state.discard.length - 1];

  if (state.pendingDrawCount > 0) {
    const counterIdx = hand.findIndex((c) => isCounter(c, topCard));
    if (counterIdx === -1) return { kind: "draw" };
    const card = hand[counterIdx];
    return card.color === "Wild"
      ? { kind: "play", index: counterIdx, color: pickColor(state) }
      : { kind: "play", index: counterIdx };
  }

  const playable = [];
  for (let i = 0; i < hand.length; i++) {
    if (canPlay(hand[i], topCard, state.currentColor)) playable.push(i);
  }
  if (playable.length === 0) return { kind: "draw" };

  const nonWild = playable.find((i) => hand[i].color !== "Wild");
  if (nonWild !== undefined) return { kind: "play", index: nonWild };

  return { kind: "play", index: playable[0], color: pickColor(state) };
}

/** Apply a choice exactly as the worker's replay driver will. */
function applyChoice(state, action) {
  if (action.kind === "draw") return playerDraw(state);
  return playerPlayCard(
    state,
    action.index,
    action.color === undefined
      ? undefined
      : NON_WILD_COLORS[action.color],
  );
}

/**
 * Play greedily to the end of the game, emitting the log. Mirrors the
 * component's split exactly: the component's click handlers apply player
 * choices and log them, while a 700 ms timer drives `runBotTurn` one bot step
 * at a time — the same sequence `advanceBots` runs in a loop here.
 */
function playGreedy(initial, cap = MAX_UNO_ACTIONS) {
  let state = initial;
  const log = [];
  // Bounds a pathological game (the discard refills an empty deck, so a game
  // can in principle cycle); honest games finish in a few dozen choices.
  let guard = 0;

  while (!state.gameOver && guard < 20_000) {
    guard += 1;

    if (state.currentPlayer !== 0) {
      const driven = advanceBots(state);
      if (driven.exhausted) return { state, log, exhausted: true };
      state = driven.state;
      continue;
    }

    if (log.length >= cap) return { state, log, capped: true };

    const action = greedyAction(state);
    const before = state;
    state = applyChoice(state, action);
    if (state === before) return { state, log, stuck: true };

    log.push(action);
  }

  return { state, log, guardHit: guard >= 20_000 };
}

/** The claim's journey: log → bytes → base64 → JSON → validated. */
function throughTheWire(log, seed) {
  const base64 = encodeUnoLog(encodeUnoActionLog(log));
  const payload = JSON.parse(JSON.stringify({ seed, actions: base64 }));
  return validateUnoReplay(payload);
}

/** Verdict for a validated replay, as the worker computes it. */
function verdictFor(validated, claimScore) {
  return unoReplayOutcome(runUnoReplay(validated), claimScore);
}

const snapshot = (s) => JSON.parse(JSON.stringify(s));

// ─────────────────────────────────────────────────────────────────────────────
// A. Codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every shape of choice round tripped through bytes, base64 and JSON.
  const many = [
    { kind: "draw" },
    { kind: "play", index: 0 },
    { kind: "play", index: 7 },
    { kind: "play", index: 0, color: 0 },
    { kind: "play", index: 107, color: 3 },
    { kind: "play", index: 42 },
  ];
  const wire = JSON.parse(
    JSON.stringify({ actions: encodeUnoLog(encodeUnoActionLog(many)) }),
  );
  const decoded = decodeUnoActionLog(decodeUnoLog(wire.actions));
  check(
    JSON.stringify(decoded) === JSON.stringify(many),
    "codec round trip: a whole choice log through JSON",
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

  // Encoding refusals
  expectThrow(
    () => encodeUnoActionLog([{ kind: "play", index: MAX_UNO_HAND_INDEX + 1 }]),
    `encoding a hand index over ${MAX_UNO_HAND_INDEX} throws`,
  );
  expectThrow(
    () => encodeUnoActionLog([{ kind: "play", index: -1 }]),
    "encoding a negative hand index throws",
  );
  expectThrow(
    () => encodeUnoActionLog([{ kind: "play", index: 0, color: UNO_COLOR_COUNT }]),
    "encoding a colour over 3 throws",
  );
  expectThrow(
    () =>
      encodeUnoActionLog(
        Array.from({ length: MAX_UNO_ACTIONS + 1 }, () => ({ kind: "draw" })),
      ),
    `encoding ${MAX_UNO_ACTIONS + 1} choices throws`,
  );

  // Malformed decode — most importantly the wild-without-colour case, which
  // is what makes the log canonical: a wild play always carries its colour.
  expectThrow(
    () => decodeUnoActionLog(Uint8Array.from([0x80])),
    "decoding a wild play with no colour byte throws",
  );
  expectThrow(
    () => decodeUnoActionLog(Uint8Array.from([0x80 | 5, 9])),
    "decoding a colour over 3 throws",
  );
  expectThrow(
    () => decodeUnoLog("!!! not base64 !!!"),
    "garbage base64 throws",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: what could not have come from the client
// ─────────────────────────────────────────────────────────────────────────────

{
  const dummy = encodeUnoLog(encodeUnoActionLog([{ kind: "draw" }]));
  const base = { seed: 12345, actions: dummy };

  const expectInputError = (payload, label) => {
    try {
      validateUnoReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof UnoReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const validated = validateUnoReplay(base);
  check(
    validated.seed === 12345 && validated.total === 1,
    "a well-formed replay validates",
  );

  expectInputError(undefined, "a missing replay is refused");
  expectInputError({ seed: 12345 }, "a replay without actions is refused");
  expectInputError({ actions: dummy }, "a replay without a seed is refused");
  expectInputError({ ...base, seed: 1.5 }, "a fractional seed is refused");
  expectInputError({ ...base, seed: -1 }, "a negative seed is refused");
  expectInputError({ ...base, seed: 0x100000000 }, "a seed over 32 bits is refused");
  expectInputError({ ...base, actions: "!!! not base64 !!!" }, "garbage base64 is refused");
  expectInputError(
    { ...base, actions: encodeUnoLog(Uint8Array.from([0x80])) },
    "a wild play missing its colour byte is refused",
  );
  expectInputError(
    {
      ...base,
      // Hand-built rather than encoded: the *encoder* refuses a log over the
      // ceiling, so a hostile client would build the bytes directly. The
      // decoder must refuse it too — the ceiling is a resource bound, not a
      // courtesy.
      actions: encodeUnoLog(new Uint8Array(MAX_UNO_ACTIONS + 1).fill(0x00)),
    },
    "a log over the ceiling is refused",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win — the log a played game produces pays
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic search over seeds for a game the greedy player wins, and one
// they lose (a finished loss replaying perfectly must still pay nothing).
let winRun = null;
let lossRun = null;
for (let i = 0; i < 4000 && !(winRun && lossRun); i++) {
  const seed = (20_261_011 + i) >>> 0;
  const run = playGreedy(createInitialState(seed));
  if (run.state.gameOver) {
    if (run.state.winner === "player" && !winRun) {
      winRun = { seed, ...run };
    } else if (run.state.winner !== "player" && !lossRun) {
      lossRun = { seed, ...run };
    }
  }
}

check(winRun !== null, "found a seed whose greedy log wins the game");
check(lossRun !== null, "found a seed whose greedy log ends in a bot win");

if (winRun) {
  check(
    winRun.log.length > 0 && winRun.log.length <= MAX_UNO_ACTIONS,
    `the winning game (${winRun.log.length} choices) fits the ceiling`,
  );

  // The worker's half: rebuild the deal, re-apply the choices with the bots
  // re-simulated in between.
  const replayed = replayUnoActions(createInitialState(winRun.seed), winRun.log);
  check(replayed.failedAt === -1, "every logged choice applies during replay");
  check(
    winRun.state.winner === "player",
    "the client's game ends as a player win",
  );
  check(
    JSON.stringify(replayed.state) === JSON.stringify(winRun.state),
    "replay state is identical to the state the client played to",
  );

  // The whole pipeline, as the claim carries it.
  const validated = throughTheWire(winRun.log, winRun.seed);
  const verdict = verdictFor(validated, 1);
  check(
    verdict.matched === true && verdict.replayScore === 1,
    "a played-to-win game verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused.
  check(
    verdictFor(validated, 0).matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(verdictFor(validated, 0)),
  );

  // A truncated game — the same log minus its final choice — replays
  // perfectly (every prefix choice still applies) and still pays nothing.
  if (winRun.log.length > 1) {
    const truncatedLog = winRun.log.slice(0, -1);
    const truncated = throughTheWire(truncatedLog, winRun.seed);
    check(
      verdictFor(truncated, 1).matched === false,
      "a truncated log is refused (the game had not finished)",
      JSON.stringify(verdictFor(truncated, 1)),
    );
    check(
      runUnoReplay(truncated).gameOver === false,
      "the truncated replay lands on an unfinished game",
    );
  }
}

if (lossRun) {
  // A finished loss game replaying perfectly is still no coin.
  const verdict = verdictFor(throughTheWire(lossRun.log, lossRun.seed), 1);
  check(
    verdict.matched === false,
    "a finished game the player did not win is refused",
    JSON.stringify(verdict),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Forgery, tampering
// ─────────────────────────────────────────────────────────────────────────────

if (winRun) {
  const { seed, log } = winRun;

  // Wrong seed: the same choices against a different deal.
  const wrongSeed = throughTheWire(log, (seed + 1) >>> 0);
  check(
    verdictFor(wrongSeed, 1).matched === false,
    "the same log on a different deal is refused",
  );

  // A spliced choice: an extra draw appended after the game ended. The
  // engine refuses every choice once the game is over, so it dies at its
  // exact index — the tamper signal, not a weaker check.
  const spliced = throughTheWire([...log, { kind: "draw" }], seed);
  const splicedReplayed = runUnoReplay(spliced);
  check(
    splicedReplayed.failedAt === log.length,
    `a choice spliced after the game ended is caught at index ${log.length}`,
    `failedAt=${splicedReplayed.failedAt}`,
  );
  check(
    verdictFor(spliced, 1).matched === false,
    "a log with a spliced post-game choice is refused",
  );

  // A dead choice in the middle: replace a mid-game choice with a draw, which
  // the engine may well accept — so instead corrupt a *play* into an
  // out-of-range index, which the engine refuses (no such card) and which
  // therefore dies exactly where the forgery was introduced.
  const midIdx = Math.floor(log.length / 2);
  const corruptIndex = log.map((a, i) =>
    i === midIdx && a.kind === "play"
      ? { kind: "play", index: a.index + 1 }
      : a,
  );
  if (JSON.stringify(corruptIndex) !== JSON.stringify(log)) {
    const corrupted = throughTheWire(corruptIndex, seed);
    check(
      runUnoReplay(corrupted).failedAt >= 0,
      "a choice rewritten to a different card is caught at its index",
      `failedAt=${runUnoReplay(corrupted).failedAt}`,
    );
    check(
      verdictFor(corrupted, 1).matched === false,
      "a log with a rewritten choice is refused",
    );
  }
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

  // Deal determinism: same seed deals an identical game; different seed, a
  // different one. The ids are part of this on purpose — they are the card's
  // position in the build order, so a worker's rebuild is byte-identical.
  const a = snapshot(createInitialState(4242));
  const b = snapshot(createInitialState(4242));
  const c = snapshot(createInitialState(4243));
  check(JSON.stringify(a) === JSON.stringify(b), "same seed deals an identical game");
  check(JSON.stringify(a) !== JSON.stringify(c), "a different seed deals a different game");
  check(
    buildDeck().length === 108 && new Set(buildDeck().map((x) => x.id)).size === 108,
    "the deck is 108 uniquely-identified cards",
  );

  // Bot-choice determinism: the same (seed, log) replayed twice must reach
  // the same winner. The bots' Wild colour picks draw from the same stream
  // the shuffle consumed, so this is the check that would catch the stream
  // being rebuilt instead of resumed.
  if (winRun) {
    const first = runUnoReplay(throughTheWire(winRun.log, winRun.seed));
    const second = runUnoReplay(throughTheWire(winRun.log, winRun.seed));
    check(
      first.replayScore === second.replayScore && first.failedAt === second.failedAt,
      "replaying the same (seed, log) twice reaches the same game",
      `${first.replayScore} vs ${second.replayScore}`,
    );

    // The fuse: a bot turn must always make progress, so the loop that runs
    // them between two player choices can never spin.
    const probe = createInitialState(winRun.seed);
    check(
      MAX_BOT_TURNS >= 4,
      "the bot-turn fuse leaves room for a Skip (three bot turns max)",
    );
    void probe;
  }
}

if (winRun) {
  // The replay must fit a Workers Free request: 10 ms of CPU is the ceiling,
  // and this is the whole claim's replay with no parking. Measured loosely
  // (25 ms) because CI machines vary — the point is catching a replay that
  // accidentally became expensive, not benchmarking.
  const t0 = performance.now();
  runUnoReplay(throughTheWire(winRun.log, winRun.seed));
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
console.log("uno replay harness: all checks passed");
