# GAME_SPEC.md

> **Living document.** Clone maintainers edit this file as the single source for **numbers**, **rules**, and **content** specific to **their** mini-game.

## Agent summary

Before changing code, update this spec when you alter: **starting resources**, **win/lose conditions**, **timers**, **costs**, **enemy counts**, or **progression tiers**. Agents should read this file when implementing balance or UI copy tied to rules.

**Default shell:** `App` renders **`ChickenRescueApp`** (Phaser + portal session). Swap in **`UiResourcesApp`** or another example from **`src/examples/`** in **`App.tsx`** when building a different mini-game.

When changing **Phaser visuals**, read **`ART.md`** and keep gameplay art mapped to **`icons.config.ts` / `resources.config.ts`** (`@sl-assets`) where possible — avoid one-off URLs or vector-drawn gameplay tiles where pixel assets exist.

---

## Game identity (your fork)

- **Working title:** _[your game name]_
- **One-line pitch:** _[what the player does in one sentence]_

## Raven Bubbles (`src/features/arcade/games/ravenbubbles/`)

The eleventh cabinet, on `Machine 11` — the first cabinet the original arcade
left empty. A Puzzle-Bobble-style bubble shooter themed with SFL crop art.

| Rule | Value |
|------|-------|
| Board | 10 columns × 13 rows hex grid, odd rows shifted half a bubble right |
| Opening board | 5 rows of bubbles, dealt in clumps of 1–2, not scattered |
| Bubble colours | 6 — Sunflower, Carrot, Pumpkin, Potato, Corn, Wheat (each carries that crop's art) |
| Win | Clear the difficulty's screen count in one life |
| Lose | Any bubble comes to rest on row 11 or below (the dashed line) |
| Ceiling drop | Every 15 shots, the whole cluster shifts down one row |
| Pop | 3+ of a colour connected = they pop, 30 points each |
| Drop | Bubbles left unconnected to the ceiling fall, 60 points each |
| Refill | A cleared screen deals a fresh one, **ceiling and countdown reset** |
| Difficulty | 4 levels — **only the screen count changes**: Easy 1, Medium 2, Hard 4, Expert 10 |
| Reward | 1 Raven Coin, like every other cabinet |

The ceiling reset on refill is what makes the higher counts reachable at all.
The ceiling only ever descends, so without it a tenth screen would be dealt
underneath the anchor and fall apart on arrival; with it, a run is a chain of
self-contained stages.

### Three rules this board has to earn that the original gets for free

All three were found by measuring, not by playing: a solver that picks the best
of every possible angle each shot was losing at **90 points of a 1500 target on
shot 11**, on every difficulty, against a build that looked fine.

1. **The deal is made of small clumps, not random cells.** Filling cell-by-cell
   at random with six colours gives any cell roughly a 1-in-36 chance of
   agreeing with two neighbours, so a 50-bubble board holds about one accidental
   triplet — a board with no triplets has no plays, and every shot just snaps
   onto the cluster's floor and pushes it down a row. Clumps of one or two are
   enough: one bubble lands against a pair and makes the three. Larger clumps
   were tried and are far too soft, because the player never has to build
   anything.
2. **The handout is biased towards playable colours.** `pickNextColor` only
   offers a colour that is on the board *and* can be completed at a cell a shot
   can actually reach (`landingCells` traces real trajectories for this). A
   dead-end bubble is worth nothing but descent.
3. **The flight is substepped.** Advancing by `velocity * dt` in one go makes
   the physics depend on the frame rate: at 950 px/s a 50 ms hitch moves a
   bubble 47 px — more than its own diameter — so shots pass through the cluster
   and snap wherever they happen to stop. Steps are capped at 5 px.

**Controls.** Mouse move + click, arrow keys + Space, and touch (drag to aim,
lift to fire) with a `(pointer: coarse)` check that swaps the lobby's control
copy. The aim guide is a dotted line that bounces off the walls and stops at
the first bubble it would hit.

**Economy ids** (derived from the registry id `raven-bubbles`, so the economy
editor must publish them): `Mint-Raven-Coin-RavenBubbles`,
`Free Run Token - RavenBubbles`, `Grant-Free-Run-RavenBubbles`,
`Start-Free-Run-RavenBubbles`.

## Core loop (fill in)

1. _[Step 1]_
2. _[Step 2]_
3. _[Step 3]_

## Win / lose (your fork)

- **Win condition:** _[e.g. reach score X, survive Y seconds]_
- **Lose condition:** _[e.g. run out of lives]_
- **Retry:** _[what resets vs what persists]_

## Resources (your fork)

| Resource | Type | Notes |
|----------|------|-------|
| Coins | profile (stub) | `$gameState.coins` from `loadPlayerProfile` in `lib/api.ts` |
| _[add rows]_ | | |

---

## Boring (`src/examples/boring/`)

> Optional sample (mount **`BoringApp`** from **`App.tsx`** if present in your fork). Session fetch: portal helpers + **`getPlayerEconomySession`**. Example action **definitions** (not wired to POST yet): **`boring/lib/boringClientActions.ts`**.

### Pitch

Welcome screen → **Start** → simple Phaser field with a bumpkin moved by arrow keys.

### Routes

| Path | Role |
|------|------|
| `/` | Welcome; session fetch when `getMinigamesApiUrl()` + `getJwt()` succeed |
| `/game` | **`MainScene`** inside **`PhaserGame`** |

---

## Out of scope (this file)

- Does **not** replace `DESIGN.md` (philosophy) or `TECHNICAL.md` (implementation).

## Related docs

- `DESIGN.md`, `VALIDATION.md`, `API.md`, `ART.md`, `TECHNICAL.md`, `../src/examples/README.md`
