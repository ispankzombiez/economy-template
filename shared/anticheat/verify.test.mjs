// Ad-hoc harness for the shared checkpoint verifier.
//
// Not part of the build — run with `node shared/anticheat/verify.test.mjs`.
// It exists because the verifier is the one component whose two failure modes
// are both silent and expensive: reject an honest player (they lose a coin they
// earned) or accept a forged one (the economy pays for nothing). Neither shows
// up in a typecheck or a bundle, so the invariants are pinned here instead.

import { verifyCheckpoints, scoreCeilingForWave } from "./verify.js";

const RULES = {
  maxWave: 15,
  maxScoreByWave: [
    2900, 5900, 9300, 12800, 17600, 21300, 25200, 29200, 33400, 39700, 44500,
    49000, 54100, 59700, 71200,
  ],
  maxScoreCeiling: 71200,
  maxHp: 120,
  maxMagic: 100,
  maxLives: 3,
  minMsPerWave: 4000,
  finaleWave: 15,
};

/**
 * A run that clears every wave with a plausible, slightly imperfect score.
 *
 * Scores sit at ~70% of each wave's ceiling, because a real player misses hits
 * and leaves enemies alive. That fraction matters: a log pinned to the ceiling
 * would be *reachable* but suspicious, and testing only that shape would leave
 * the ordinary-case path unexercised.
 */
function honestRun({ msPerWave = 9000 } = {}) {
  const checkpoints = [];
  let ms = 1600; // intro banner before wave one
  for (let wave = 1; wave <= 15; wave++) {
    ms += msPerWave;
    checkpoints.push({
      seq: wave - 1,
      wave,
      score: Math.floor(RULES.maxScoreByWave[wave - 1] * 0.7),
      hp: 40 + ((wave * 7) % 60),
      magic: (wave * 13) % 100,
      lives: wave > 11 ? 1 : 2,
      ms,
    });
  }
  return { checkpoints, elapsedMs: ms + 2000 };
}

let failures = 0;

function check(name, input, expectOk, expectReason) {
  const result = verifyCheckpoints(input);
  const okPass = result.ok === expectOk;
  const reasonPass =
    expectReason === undefined ||
    (result.reason !== undefined && result.reason.includes(expectReason));
  const pass = okPass && reasonPass;
  if (!pass) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      expected ok=${expectOk}` +
      `${expectReason ? ` containing "${expectReason}"` : ""}`);
    console.log(`      got      ok=${result.ok}` +
      `${result.reason ? ` reason="${result.reason}"` : ""}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

// ── The honest case must pass ────────────────────────────────────────────────
const honest = honestRun();
const finalScore = honest.checkpoints[14].score;
check("honest full run", { ...honest, rules: RULES, claimedScore: finalScore, claimedWin: true }, true);

// ── The forgeries it exists to stop ──────────────────────────────────────────
{
  const { checkpoints } = honestRun();
  const forged = checkpoints.map((c) => ({ ...c, score: 999999 }));
  check("inflated final score", {
    rules: RULES, checkpoints: forged, claimedScore: 999999, claimedWin: true, elapsedMs: 200000,
  }, false, "exceeds");
}

{
  const { checkpoints } = honestRun();
  checkpoints[7].wave = 12;
  check("skipped waves", {
    rules: RULES, checkpoints, claimedScore: finalScore, claimedWin: true, elapsedMs: 200000,
  }, false, "jumped");
}

{
  const { checkpoints } = honestRun();
  check("run far too fast to be real", {
    rules: RULES, checkpoints, claimedScore: finalScore, claimedWin: true, elapsedMs: 9000,
  }, false, "faster than");
}

{
  const { checkpoints } = honestRun();
  check("win claimed at wave 14", {
    rules: RULES, checkpoints: checkpoints.slice(0, 14),
    claimedScore: checkpoints[13].score, claimedWin: true, elapsedMs: 200000,
  }, false, "only reached wave 14");
}

{
  const { checkpoints } = honestRun();
  check("claimed score does not match log", {
    rules: RULES, checkpoints, claimedScore: finalScore + 1, claimedWin: true, elapsedMs: 200000,
  }, false, "does not match");
}

{
  const { checkpoints } = honestRun();
  const withGap = checkpoints.filter((c) => c.wave !== 9);
  check("gap in the sequence", {
    rules: RULES, checkpoints: withGap, claimedScore: finalScore, claimedWin: true, elapsedMs: 200000,
  }, false);
}

{
  const { checkpoints } = honestRun();
  checkpoints[3].score = 40000; // more than wave 4 could ever hold
  check("score outruns early progress", {
    rules: RULES, checkpoints, claimedScore: finalScore, claimedWin: true, elapsedMs: 200000,
  }, false, "exceeds");
}

{
  const { checkpoints } = honestRun();
  checkpoints[12].hp = 500;
  check("health above the maximum", {
    rules: RULES, checkpoints, claimedScore: finalScore, claimedWin: true, elapsedMs: 200000,
  }, false, "out of range");
}

{
  const { checkpoints } = honestRun();
  checkpoints[5].ms = checkpoints[4].ms - 5000;
  check("timestamps run backwards", {
    rules: RULES, checkpoints, claimedScore: finalScore, claimedWin: true, elapsedMs: 200000,
  }, false, "backwards");
}

check("no checkpoints at all", {
  rules: RULES, checkpoints: [], claimedScore: 0, claimedWin: true, elapsedMs: 200000,
}, false, "No checkpoints");

// ── The ceiling itself ───────────────────────────────────────────────────────
{
  const table = RULES.maxScoreByWave;
  const monotonic = table.every((v, i) => i === 0 || v > table[i - 1]);
  const rightShape =
    scoreCeilingForWave(RULES, 15) === 71200 &&
    scoreCeilingForWave(RULES, 1) === 2900 &&
    scoreCeilingForWave(RULES, 99) === 71200 &&
    scoreCeilingForWave(RULES, 0) === 2900;
  if (!monotonic || !rightShape) {
    failures++;
    console.log("FAIL  ceiling table shape");
    console.log(`      monotonic=${monotonic} shape=${rightShape}`);
  } else {
    console.log("pass  ceiling table is monotonic and clamps at both ends");
  }
}

// ── A slower honest run still passes ─────────────────────────────────────────
{
  const slow = honestRun({ msPerWave: 25000 });
  check("slow cautious run is not rejected", {
    rules: RULES, checkpoints: slow.checkpoints,
    claimedScore: slow.checkpoints[14].score, claimedWin: true, elapsedMs: slow.elapsedMs,
  }, true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
