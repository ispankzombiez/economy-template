#!/usr/bin/env node
/**
 * Go Fish replay harness — proves `(seed, ask log) => the same game`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own replay of the claimed asks
 * ends in a player win at the book count the claim asserts. That guarantee
 * rests on two properties, and this harness fails loudly the moment either
 * breaks:
 *
 *   1. **Determinism.** The same seed deals the same deck on a phone and on a
 *      worker — and, crucially, rolls the same dealer choices: Go Fish is the
 *      first verified cabinet whose *mid-game* state depends on the RNG (the
 *      dealer picks a rank to ask for once per dealer turn), so the seed does
 *      not stop at the shuffle the way Solitaire's does. No `Math.random()`,
 *      no clock, anywhere in the engine — every draw comes from the run's one
 *      generator stream.
 *   2. **Parity.** The log the component's click handler produces is exactly
 *      the log the worker's replay driver consumes: one byte per ask the
 *      engine actually applied, none for the asks it refused. A driver that
 *      logged refused asks would refuse honest games; a component that logged
 *      them would smuggle dead actions past a replay that expects none.
 *
 * ## What it checks
 *
 *   - **Codec round trips** — every rank index (0–12) encodes and decodes to
 *     the byte it started as, through base64 and a JSON round trip (the
 *     claim's journey). One byte per ask, unlike Solitaire's two: an ask
 *     names nothing but a rank.
 *   - **Malformed logs are refused** — a byte over 12, over the ceiling,
 *     garbage base64, a missing/empty log, a seed that is not a 32-bit
 *     integer. Refused *before* replay: a log the encoder could not have
 *     produced is protocol garbage, not a game that failed to match.
 *   - **There is no difficulty** — Go Fish's lobby "Daily" label is
 *     decorative, so unlike Solitaire the validation derives nothing from the
 *     date; a `difficulty` field, if one arrives, is ignored rather than
 *     believed. The check pins that posture so it cannot quietly grow into a
 *     second table nobody maintains.
 *   - **A real win pays** — a greedily played game (ask for the rank you hold
 *     the most of) replays ask-for-ask to the same final state, and its
 *     verdict matches at the player's book count.
 *   - **Forgery is refused** — the same log on a different deal, a spliced
 *     ask for an unheld rank (caught at its exact index), an ask appended
 *     after the game ended (caught at the end), a truncated log, a dealer win
 *     or tie that replays perfectly, a score that disagrees with its own log.
 *   - **No nondeterminism in the engine's source** (structural scan), and the
 *     whole validate + replay fits a Workers Free request (well inside the
 *     10 ms budget).
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so,
 * exactly like `solitaireReplayTest.mjs`, everything is bundled by esbuild
 * with a resolve plugin answering both spellings *from the same directory*,
 * which is the entire point of the shared package: one file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/gofish/engine.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/gofishReplay.js");
const SHARED = path.join(ROOT, "shared/anticheat");
const CODEC = path.join(SHARED, "goFishLog.js");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "gofish-entry.mjs");
const BUNDLE = path.join(CACHE, "gofish.bundle.mjs");

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
  RANK_ORDER,
  askForRank,
  createInitialState,
  replayGoFishActions,
  // Worker verifier
  GoFishReplayInputError,
  goFishReplayOutcome,
  runGoFishReplay,
  validateGoFishReplay,
  // Codec
  GO_FISH_RANK_COUNT,
  MAX_GO_FISH_ACTIONS,
  decodeGoFishActionLog,
  decodeGoFishLog,
  encodeGoFishActionLog,
  encodeGoFishLog,
} = mod;

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a greedy player that emits the log a claim would carry.
//
// Its policy — "ask for the rank you hold the most of" — is deliberately
// simple and fully deterministic: it reads only the state, never the dealer's
// hand or the stock, exactly like the component's UI (which offers a button
// per held rank and lets the player pick any). Ties break toward the lower
// rank index, so the same state always asks the same rank. And, most
// importantly, it commits by the component's rule: an ask is logged iff the
// engine changed the state, so the log it emits is the log the worker's
// replay driver must be able to re-apply to the end.
// ─────────────────────────────────────────────────────────────────────────────

/** The rank the player holds the most copies of, or null with an empty hand. */
function greedyAsk(state) {
  const counts = new Map();
  for (const card of state.playerHand) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  let bestRank = null;
  let bestCount = 0;
  // Iterated in RANK_ORDER, strictly-greater compare: ties land on the
  // lowest rank index, deterministically.
  for (const rank of RANK_ORDER) {
    const count = counts.get(rank) ?? 0;
    if (count > bestCount) {
      bestRank = rank;
      bestCount = count;
    }
  }
  return bestRank;
}

/**
 * Play greedily to the end, emitting the log. Mirrors the component's commit
 * rule: an ask is logged iff the engine changed the state. Both documented
 * softlocks (dealer hand empties on a dead stock; empty player hand at turn
 * start) end the loop *without* a finished game — the same dead end a player
 * hits at the cabinet, which is exactly the property worth pinning: neither
 * can ever produce a log the worker would pay.
 */
function playGreedy(initial, cap = MAX_GO_FISH_ACTIONS) {
  let state = initial;
  const asks = [];
  while (!state.gameOver && asks.length < cap) {
    if (state.turn !== "player") break; // dealer-side softlock
    const rank = greedyAsk(state);
    if (!rank) break; // player-side softlock
    const next = askForRank(state, rank);
    if (next === state) break; // would be an emitter bug — caught by the win checks
    asks.push(RANK_ORDER.indexOf(rank));
    state = next;
  }
  return { state, asks };
}

/** The claim's journey: asks → bytes → base64 → JSON → validated. */
function throughTheWire(asks, seed) {
  const base64 = encodeGoFishLog(encodeGoFishActionLog(asks));
  const payload = JSON.parse(JSON.stringify({ seed, actions: base64 }));
  return validateGoFishReplay(payload);
}

/** Verdict for a validated replay, as the worker computes it. */
function verdictFor(validated, claimScore) {
  return goFishReplayOutcome(runGoFishReplay(validated), claimScore);
}

const snapshot = (s) => JSON.parse(JSON.stringify(s));

// ─────────────────────────────────────────────────────────────────────────────
// A. Codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every rank index the codec can carry, round tripped through bytes, base64
  // and JSON — the claim's whole journey for one ask each.
  const all = Array.from({ length: GO_FISH_RANK_COUNT }, (_, i) => i);
  const wire = JSON.parse(
    JSON.stringify({ actions: encodeGoFishLog(encodeGoFishActionLog(all)) }),
  );
  check(
    JSON.stringify(decodeGoFishActionLog(decodeGoFishLog(wire.actions))) ===
      JSON.stringify(all),
    `all ${GO_FISH_RANK_COUNT} rank indices round trip through base64 + JSON`,
  );

  // A game's worth of asks — repeated ranks included, since repeats are the
  // normal case (you ask for what you hold most).
  const many = [0, 0, 12, 5, 12, 12, 3];
  const manyWire = JSON.parse(
    JSON.stringify({ actions: encodeGoFishLog(encodeGoFishActionLog(many)) }),
  );
  check(
    JSON.stringify(decodeGoFishActionLog(decodeGoFishLog(manyWire.actions))) ===
      JSON.stringify(many),
    "codec round trip: a whole ask log through JSON",
  );

  const expectThrow = (fn, label) => {
    try {
      fn();
      check(false, label, "did not throw");
    } catch {
      check(true, label);
    }
  };

  expectThrow(
    () => encodeGoFishActionLog([GO_FISH_RANK_COUNT]),
    "encoding rank 13 throws",
  );
  expectThrow(
    () => encodeGoFishActionLog([1.5]),
    "encoding a fractional rank throws",
  );
  expectThrow(
    () => decodeGoFishActionLog(Uint8Array.from([GO_FISH_RANK_COUNT])),
    "decoding a byte over 12 throws",
  );
  expectThrow(
    () => decodeGoFishActionLog(new Uint8Array(MAX_GO_FISH_ACTIONS + 1)),
    `decoding ${MAX_GO_FISH_ACTIONS + 1} bytes throws (over the ceiling)`,
  );
  expectThrow(
    () => decodeGoFishLog("!!! not base64 !!!"),
    "garbage base64 throws",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: a seed and an ask log, and nothing else
// ─────────────────────────────────────────────────────────────────────────────

{
  const dummyActions = encodeGoFishLog(encodeGoFishActionLog([0]));
  const base = { seed: 12345, actions: dummyActions };

  const expectInputError = (payload, label) => {
    try {
      validateGoFishReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof GoFishReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  expectInputError(undefined, "a missing replay is refused");
  expectInputError({ seed: 12345 }, "a replay without an action log is refused");
  expectInputError({ ...base, actions: "" }, "an empty action log is refused");
  expectInputError(
    { ...base, seed: 1.5 },
    "a fractional seed is refused",
  );
  expectInputError({ ...base, seed: -1 }, "a negative seed is refused");
  expectInputError(
    { ...base, seed: 0x100000000 },
    "a seed over 32 bits is refused",
  );
  expectInputError(
    { ...base, actions: "!!! not base64 !!!" },
    "garbage base64 is refused",
  );
  expectInputError(
    { ...base, actions: encodeGoFishLog(new Uint8Array([GO_FISH_RANK_COUNT])) },
    "a rank byte over 12 is refused",
  );
  expectInputError(
    {
      ...base,
      actions: encodeGoFishLog(new Uint8Array(MAX_GO_FISH_ACTIONS + 1)),
    },
    "a log over the ceiling is refused",
  );

  // No difficulty — Go Fish has none (the lobby "Daily" label is decorative),
  // so, unlike Solitaire, the validation derives nothing from the date and
  // refuses nothing for want of a difficulty. A field named `difficulty`, if
  // one ever arrives, is ignored rather than believed: there is no table for
  // it to disagree with. This check pins that posture.
  const withStrayDifficulty = validateGoFishReplay({
    ...base,
    difficulty: "expert",
  });
  check(
    withStrayDifficulty.seed === 12345 && withStrayDifficulty.total === 1,
    "the replay validates with no difficulty — there is none to check",
    JSON.stringify(withStrayDifficulty),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win — the log a played game produces pays
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic search over seeds for two things the verdict table must treat
// oppositely: a finished game the player *wins* (must verify), and a finished
// game they do not (must be refused even though its log replays perfectly).
let winRun = null;
let lossRun = null;
for (
  let i = 0;
  i < 600 && !(winRun && lossRun);
  i++
) {
  const seed = (20_261_010 + i) >>> 0;
  const run = playGreedy(createInitialState(seed));
  if (!run.state.gameOver) continue;
  if (run.state.winner === "player") {
    if (!winRun) winRun = { seed, ...run };
  } else {
    if (!lossRun) lossRun = { seed, ...run };
  }
}

check(winRun !== null, "found a seed whose greedy log wins");
check(
  lossRun !== null,
  "found a seed whose greedy log ends in a dealer win or tie",
);

if (winRun) {
  check(
    winRun.asks.length > 0 && winRun.asks.length < MAX_GO_FISH_ACTIONS,
    `the winning log (${winRun.asks.length} asks) fits the ceiling`,
  );

  // The worker's half: rebuild the deal, re-apply the asks.
  const replayed = replayGoFishActions(
    createInitialState(winRun.seed),
    winRun.asks,
  );
  check(replayed.failedAt === -1, "every logged ask applies during replay");
  check(
    winRun.state.playerBooks.length > winRun.state.dealerBooks.length,
    "the client's game ends with more books for the player than the dealer",
    `${winRun.state.playerBooks.length}-${winRun.state.dealerBooks.length}`,
  );
  check(
    JSON.stringify(replayed.state) === JSON.stringify(winRun.state),
    "replay state is identical to the state the client played to",
  );

  // The whole pipeline, as the claim carries it.
  const validated = throughTheWire(winRun.asks, winRun.seed);
  const verdict = verdictFor(
    validated,
    winRun.state.playerBooks.length,
  );
  check(
    verdict.matched === true &&
      verdict.replayScore === winRun.state.playerBooks.length,
    "a played-to-win game verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused: Go Fish
  // pays on a won game, not on whatever number the caller asserts.
  const badScore = verdictFor(
    validated,
    winRun.state.playerBooks.length - 1,
  );
  check(
    badScore.matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(badScore),
  );

  // A half-finished game — the same log minus its final ask — replays
  // perfectly (every prefix ask still applies) and still pays nothing: the
  // game it lands on has not ended.
  if (winRun.asks.length > 1) {
    const truncated = throughTheWire(winRun.asks.slice(0, -1), winRun.seed);
    const truncatedVerdict = verdictFor(
      truncated,
      winRun.state.playerBooks.length,
    );
    check(
      truncatedVerdict.matched === false,
      "a truncated log is refused (the game had not finished)",
      JSON.stringify(truncatedVerdict),
    );
    check(
      runGoFishReplay(truncated).gameOver === false,
      "the truncated replay lands on an unfinished game",
    );
  }
}

if (lossRun) {
  // A dealer win or a tie replaying perfectly is still no coin — the cabinet
  // pays on a player win, and the score here even *agrees* with the log, so
  // the refusal is unambiguously the outcome check.
  const verdict = verdictFor(
    throughTheWire(lossRun.asks, lossRun.seed),
    lossRun.state.playerBooks.length,
  );
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
  const { seed, asks, state } = winRun;
  const score = state.playerBooks.length;

  // Wrong seed: the same asks against a different deal — a different shuffle
  // *and* different dealer choices, since both resume the one stream.
  const wrongSeed = throughTheWire(asks, (seed + 1) >>> 0);
  check(
    verdictFor(wrongSeed, score).matched === false,
    "the same log on a different deal is refused",
  );

  // A spliced ask for a rank the player does not hold. The engine returns the
  // state unchanged, which the replay reports as a dead action at its exact
  // index — the tamper signal, caught before anything else can be believed.
  const initial = createInitialState(seed);
  const deadIndex = RANK_ORDER.findIndex(
    (rank) => !initial.playerHand.some((card) => card.rank === rank),
  );
  check(deadIndex !== -1, "the initial hand cannot hold all thirteen ranks");
  if (deadIndex !== -1) {
    const engineLevel = replayGoFishActions(initial, [deadIndex]);
    check(
      engineLevel.failedAt === 0,
      "an ask for an unheld rank is a dead action at index 0",
      `failedAt=${engineLevel.failedAt}`,
    );

    const spliced = throughTheWire([deadIndex, ...asks], seed);
    check(
      runGoFishReplay(spliced).failedAt === 0,
      "a spliced dead ask is caught at its exact index",
      `failedAt=${runGoFishReplay(spliced).failedAt}`,
    );
    check(
      verdictFor(spliced, score).matched === false,
      "a log with a spliced dead ask is refused",
    );
  }

  // An ask appended after the game ended: the engine refuses every ask once
  // the game is over, so the log dies at its very end — the component never
  // logs post-game asks, and a log carrying one is not this game's log.
  const appended = throughTheWire([...asks, asks[0]], seed);
  check(
    runGoFishReplay(appended).failedAt === asks.length,
    "an ask appended after game over is caught at the end of the log",
    `failedAt=${runGoFishReplay(appended).failedAt} of ${asks.length}`,
  );
  check(
    verdictFor(appended, score).matched === false,
    "a log with an appended post-game ask is refused",
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

  // Deal determinism: same seed, same game; different seed, different game.
  // This transitively covers the deck's RNG injection too: a deck that fell
  // back to `Math.random()` would deal differently under the same seed, and
  // this check would be the first to notice.
  const a = snapshot(createInitialState(4242));
  const b = snapshot(createInitialState(4242));
  const c = snapshot(createInitialState(4243));
  check(JSON.stringify(a) === JSON.stringify(b), "same seed deals an identical game");
  check(JSON.stringify(a) !== JSON.stringify(c), "a different seed deals a different game");
}

if (winRun) {
  // Dealer-choice determinism, in the round trip that matters most: the same
  // (seed, asks) replayed twice — as the client played it and as the worker
  // replays it — must reach the same books. The dealer's per-turn rank pick
  // draws from the same stream the shuffle consumed, so this is the check
  // that would catch the stream being rebuilt instead of resumed.
  const first = runGoFishReplay(throughTheWire(winRun.asks, winRun.seed));
  const second = runGoFishReplay(throughTheWire(winRun.asks, winRun.seed));
  check(
    first.replayScore === second.replayScore && first.failedAt === second.failedAt,
    "replaying the same (seed, asks) twice reaches the same game",
    `${first.replayScore} vs ${second.replayScore}`,
  );

  // The replay must fit a Workers Free request: 10 ms of CPU is the ceiling,
  // and this is the whole claim's replay with no parking. Measured loosely
  // (25 ms) because CI machines vary — the point is catching a replay that
  // accidentally became expensive, not benchmarking.
  const t0 = performance.now();
  runGoFishReplay(throughTheWire(winRun.asks, winRun.seed));
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
console.log("go fish replay harness: all checks passed");
