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
| Opening board | 5 rows of bubbles (50 per screen), dealt in clumps of 1–2, not scattered |
| Bubble colours | 6 — Sunflower, Carrot, Pumpkin, Potato, Corn, Wheat (each carries that crop's art) |
| Win | Reach the difficulty's **target score** |
| Lose | Any bubble comes to rest on row 11 or below (the dashed line) |
| Ceiling drop | Every 15 shots, the whole cluster shifts down one row |
| Pop | 3+ of a colour connected = they pop, **10 points** each |
| Drop | Bubbles left unconnected to the ceiling fall, **20 points** each |
| Refill | A cleared screen deals a fresh one, ceiling and countdown reset |
| Difficulty | 4 levels: **1500 / 3000 / 7500 / 15000** points (3 / 6 / 15 / 30 screens) |
| Reward | 1 Raven Coin, like every other cabinet |

### The target is a score, set outright

A run is won on **points**, not on a screen counter. Screens are how the game is
framed — a run is a chain of them — but the number the player chases is a score.

A first attempt derived the target as `screens x 50 x 10`, reasoning that clearing
a screen the ordinary way lands on exactly that. It does — but a **drop pays
double**, and drops are free bubbles: cut one cluster out and everything it was
holding up falls. A bot firing purely random angles reached 500 of Easy's 500
**having cleared not one screen**, so a target built from the pop value alone was
never a screen's worth of work. The targets are now set directly.

`1500 / 3000 / 7500 / 15000` is three, six, fifteen and thirty screens of
all-pops (a screen is `50 x 10 = 500`). A drop-heavy player is still rewarded —
they can beat a target ahead of the screen count — they simply have to do three
screens' worth of it rather than one.

(These were originally set at 5000 / 10000 / 25000 / 50000, which measured out
as a 45-minute Expert run. The ladder kept its ratios when it was scaled down.)

`BUBBLES_PER_SCREEN`, `SCREEN_WORTH` and each difficulty's `screens` equivalent
live in `ravenbubbles/session.ts`, and the cabinet imports the deal's row and
column counts from there. Changing the grid would silently change what a
difficulty looks like when read in screens, so both are derived from one place.

The ceiling reset on refill is what makes runs this long survivable at all. The
ceiling only ever descends, so without it a tenth screen would be dealt
underneath the anchor and fall apart on arrival; with it, every screen is a
self-contained stage.

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

## Sunflower Brawler (`src/features/arcade/games/sunflowerbrawler/`)

The twelfth cabinet, on `Machine 12` — the second cabinet the original arcade
left empty. A **side-scrolling beat 'em up**: one champion walks a scrolling
street, fights five scripted waves, and finishes on the Big Goblin. It was a
one-on-one fighting game until that game turned out to be a button masher — see
[Why the genre changed](#why-the-genre-changed).

| Rule | Value |
|------|-------|
| Format | **One run** — five waves, `MAX_LIVES` (3) lives for the whole thing |
| Clock | **None.** A run lasts as long as the player takes |
| Clearing | Kill every enemy in a wave → `WAVE_CLEAR_MS` banner → walk to the next screen |
| Defeat | Lives reaching 0 → `GAME OVER` on whatever wave you were on |
| Reward win | Clear wave 5 → **1 Raven Coin** (`SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD`) |
| Difficulty | 4 levels, UTC-day seeded for reward runs (weights **3 / 3 / 2 / 1**) |
| Roster | Barlow (Bumpkin), Graxle (Goblin), Nyx (Nightshade), Reginald (Sunflorian) |

### Why the genre changed

The fighting game it replaced had no guard: a jump was the only block, the
answer to every threat was a single timing window, and with four buttons and
two specials a match decayed into whoever could press **X** at the right moment
repeatedly. It was a button masher wearing a fighting game's controls.

A beat 'em up answers that with a **crowd** and a **plane**. Being surrounded
is a positioning problem rather than a reaction problem, and no amount of
pressing faster solves a line you are not standing on. Two rules carry the
whole change:

1. **Everything stands on a depth plane.** Every actor has a `z` from 0 (far)
   to `Z_MAX` (134, near); ←→ walk along the plane, ↑↓ step into and out of it.
2. **A swing is a horizontal band through that plane.** Hit resolution is
   `|a.z − b.z| ≤ moveZReach(move)` — there is no vertical test at all. So
   **stepping off the line is the dodge**, and the game needs no jump and no
   block.

Draw order is `z`-sorted, which is the plane's only piece of realism: an actor
nearer the camera is drawn last and therefore over whatever it overlaps,
shadow included in the same pass.

### The roster is asymmetric, and the string is where the asymmetry lives

Every champion carries the same **two** buttons: `Space` swings, `X` casts. What
differs is the **three-hit string** each `Space` press walks through —
`combo1 → combo2 → combo3` on a 640 ms window (`COMBO_WINDOW_MS`), wrapping
back to `combo1` when the window lapses. The finisher is always the slowest,
longest and hardest-throwing swing of the three, so the choice each press
presents is *finish the string* or *reset it*, and the enemy's approach timing
changes with which you did.

| Fighter | Faction | HP | Walk | **SPACE** combo 1 → 2 → 3 | **X** spell |
|---------|---------|----|------|---------------------------|-------------|
| **Barlow** | Bumpkin | 110 | 152 | `attack` **11** → `attack` **12** → `hammering` **23** dmg, 480 px/s finisher | **34 dmg** |
| **Graxle** | Goblin | 120 | 170 | `axe` **10** → `axe` **11** → `mining` **19** dmg, **340 px/s lunge** | **30 dmg** |
| **Nyx** | Nightshade | 90 | 164 | `attack` **10** → `attack` **11** → `mining` **18** dmg, 520 px/s `z` scatter | **36 dmg** |
| **Reginald** | Sunflorian | 100 | 144 | `attack` **12** → `axe` **14** → `hammering` **26** dmg | **42 dmg** |

Graxle is the fastest to startup and the lightest hitter; Reginald is the
slowest and the heaviest; Nyx has the least health and the quickest finisher.
Health runs 90–120 and speed 144–170, so picking a champion is a real choice
rather than a colour swap.

### The moves are frame data, not art

Every fighter animates out of the same CDN cycles — the animation API has one
vocabulary regardless of outfit, so `attack` *is* Barlow's sword swing and
Graxle's axe swing depending only on whose sheet it was requested for. What
makes the four feel different therefore cannot live in the art; it lives in
**when** in a cycle the hit lands and how hard it throws.

Each move records the sheet frame its hit connects on (`impact`) and its
playback rate (`fps`). Together those give the two numbers a player actually
feels — **startup** (time to impact) and **total** (time until you can act
again) — and neither is hand-entered in milliseconds, so retuning a move means
changing a frame number and the timings follow (`moveImpactMs` /
`moveDurationMs`).

| | `combo1` | `combo2` | `combo3` (finisher) | `magic` |
|---|---|---|---|---|
| Barlow | `attack` 26 fps, impact f5 → **192 / 385 ms**, 11 dmg, reach 66, `z` 28 | `attack` 30 fps → **167 / 333 ms**, 12 dmg, reach 70 | `hammering` 54 fps, impact f19 → **352 / 426 ms**, 23 dmg, reach 78, `z` 40 | `casting` 30 fps, f7 → 233 / 500 ms, **34 dmg** |
| Graxle | `axe` 32 fps → **156 / 313 ms**, 10 dmg | `axe` 34 fps → **147 / 294 ms**, 11 dmg | `mining` 33 fps → **152 / 303 ms**, 19 dmg, **lunges 340 px/s** | 30 dmg |
| Nyx | `attack` 31 fps → **161 / 323 ms**, 10 dmg | `attack` 33 fps → **152 / 303 ms**, 11 dmg | `mining` 40 fps → **125 / 250 ms** — fastest finisher in the roster, 18 dmg | 36 dmg |
| Reginald | `attack` 24 fps → **208 / 417 ms**, 12 dmg | `axe` 26 fps → **192 / 385 ms**, 14 dmg | `hammering` 52 fps → **365 / 442 ms**, 26 dmg | 42 dmg |

`advance` is the third number that matters and the one the fight actually
turns on: during the middle 30–90 % of a move the attacker carries itself
forward along `x`, so Graxle's 340 px/s finisher is both a hit and the way the
goblin closes the distance it needs.

### Magic is the one thing that ignores depth

`X` spends **50** of the **100**-point meter on a screen-wide blast
(`move.screen: true`): it resolves against **every** living enemy whatever line
they are on, at full damage, and it is the only move in the game for which
`zReach` is not read. That is the whole design of the meter — being surrounded
is the normal state of a beat 'em up, and the spell is the answer to it, so
spending it on a single well-behaved opponent is the wrong trade.

The meter fills from **damage dealt** (`magicPerDamage`, 0.13–0.14 per point)
and from **kills** (`magicPerKill`, 4–5). Readiness is tested **before** the
buffer is drained, so a press made at 49 stays armed for the length of the
buffer and comes out on the exact frame the meter clears.

### Depth is the dodge, and i-frames are the guard

There is no jump and no guard. Melee hitboxes are a rectangle along `x` — from
ten pixels *behind* the attacker to `move.reach` in front — crossed with a band
along `z` of `moveZReach(move)` (22 px by default, `DEPTH_TOUCH`; finishers run
to 40). Depth is therefore the only axis left to miss on, and the plane is sized
for it: `Z_MAX = 134` against a 66 px body is about two body-heights, wide
enough that two lines read as genuinely different places and shallow enough
that the whole band stays on screen without the camera ever tilting.

Because a swing is a band rather than a box, **separation is two-dimensional**.
`separatePair` pushes along whichever axis is *least* embedded, and falls back
to `x` when the `z` push would land either actor against the edge of the plane.
Separating on `x` unconditionally would make the plane feel like a wall you
cannot walk around — the whole point is that two actors can share an `x`
perfectly well if they are on different lines.

**The anti-stunlock rule is the i-frame.** `applyHit` sets
`invulnMs = hitstunMs + 120`. Without it a crowd could hold one actor in
hitstun indefinitely; with it every hit is followed by a window in which the
victim is free but untouchable — long enough to step off the line, short enough
not to be a free turn. Knockback bleeds off **exponentially** in both `x` and
`z` (`Math.exp(-6·dt)`), because a shove that stops dead reads as a teleport
and one that decays linearly reads as ice.

The three-hit string runs on a **140 ms** buffer (`INPUT_BUFFER_MS`, ~8
frames), deliberately shorter than the fighting game's 180 ms: with a single
attack button, a long one turns the string into something that queues itself.
`event.repeat` is ignored, so a held key cannot autofire.

### The waves are two factions asking opposite questions

Five waves, one per screen of the level, laid out in `enemies.ts`. Waves 1–2 are
a **goblin** block and waves 3–4 an **undead** block, and the two are built to
ask for opposite answers:

| # | Name | Spawns |
|---|------|--------|
| 1 | `GOBLIN PATROL` | 2 Scout, 1 Brute |
| 2 | `GOBLIN RAIDERS` | 2 Sneak, 1 Scout, 1 Brute |
| 3 | `THE BONEYARD` | 3 Skeleton, 1 Zombie |
| 4 | `GRAVE LEGION` | 2 Skeleton, 1 Banshee, 1 Dreadhorn |
| 5 | `BIG GOBLIN` | 1 boss |

* **Goblins** (22–48 HP, 108–172 px/s) are fast and frail. They close distance
  and poke, so the answer is to hold a line and make them come to you.
* **The undead** (34–80 HP, 76–126 px/s) are slow and tanky. They walk straight
  in and absorb the string, so the answer is the depth axis — step off their
  line, let them pass, hit them from the line they are not on.

Every wave carries one **heavy**: 48–80 HP against a grunt's 22–38, a slower
and much longer-reaching swing, and roughly double the knockback. The heavy is
what stops a wave from being a circle-strafe — it holds the middle while the
grunts work the edges.

Spawn positions alternate between the left and right edge (`index % 3`) and are
spread across the whole `z` range, so a wave never arrives as a single file
column walking in from one side.

### The boss is a sprite, not a sheet

`src/features/arcade/assets/big_goblin.png` comes from Sunflower Land's own
`RetreatScene` — a 108×35 strip of four 27×35 frames played at 6 fps, copied
into the repo following the existing committed-arcade-art precedent. It has an
idle cycle and nothing else: no walk, no attack, no death.

So the boss's states are driven **procedurally** in `engine.ts` from the same
`action` field every other actor has:

* **Attack** — `bossFrameOf` picks one of the strip's four frames as a pose
  (wound back / struck through / recovering) and `drawBoss` leans the whole
  sprite through a continuous offset: back through the first 40 % of the move,
  driven through the middle, settling over the recovery. Continuous on purpose —
  a jump in the offset reads as a stutter at 60 fps.
* **Hurt** — a white `hitFlash` overlay, the same path every other actor uses.
* **Death** — rotate over `DEATH_MS` and fade out past 55 %.
* **Spawn** — a scale pop from 0.55 with a fade.

The boss has 300 HP, is drawn at `BOSS_SCALE = 4.4` (≈154 px tall against a
66 px player), and gets two moves with **two different tells**:

* **SWIPE** (`jab`) — 100 px reach, `zReach` 34. Wide in `x`, narrow enough in
  `z` that stepping off the boss's line still works; the reward for reading it.
* **SLAM** (`heavy`) — 130 px reach, `zReach` **70**. Against a 134-deep plane
  the depth axis will *not* save you: the 400 ms windup is the tell and the
  answer is purely to be somewhere else along `x`.

Two attacks, two different dodges, one button.

### AI re-rolls on a tick, it does not cheat

`stepEnemyAi` runs once per decision, on a timer. Everything is a roll against a
parameter today's difficulty sets, so "hard" never means the AI cheats at the
physics — it re-rolls more often, commits more often, and commits to the heavy
instead of the jab more often.

The branch order matters. Committing is tested **first**, so an enemy already in
range never walks *past* you to reposition. Repositioning (`spacingChance`) is
tested before approaching, so a wave that has just been hit gets a beat to
breathe. And the approach stops at `jab.reach` rather than walking into the
separation radius, so an enemy waiting for an opening holds its ground instead
of grinding against you frame after frame.

| Difficulty | `reactionMs` | `aggression` | `heavyChance` | `spacingChance` | `speed` | `hpMultiplier` | `maxAttackers` |
|---|---|---|---|---|---|---|---|
| Easy | 430 | 0.42 | 0.15 | 0.35 | 0.86 | 0.90 | **1** |
| Medium | 310 | 0.58 | 0.28 | 0.25 | 0.96 | 1.00 | **2** |
| Hard | 220 | 0.70 | 0.40 | 0.18 | 1.05 | 1.08 | **2** |
| Expert | 150 | 0.84 | 0.52 | 0.12 | 1.12 | 1.16 | **3** |

`maxAttackers` — how many enemies may be **mid-swing** at the same instant — is
the single most effective difficulty control the genre has. The wave is still
dangerous with one: it is the *others* closing in while you deal with it that do
the work. But it is the number that decides whether a mistake costs one hit or
three.

**Controls.** ← → walk along the street, ↑ ↓ step in and out of the plane,
**Space** attack (three-hit string), **X** magic (50 meter). Touch gets a full
four-way `TouchDPad` — losing `down` would take away the one input the whole
game is built around — plus two `TouchButton`s, ATTACK and MAGIC, which
dispatch the same `Space` / `KeyX` codes so there is exactly one input path.

**Level.** Composed once from `nightshade-arcade-tilesheet.png` rather than
rendered from a map — the `.tsx` tileset the Tiled maps reference does not exist
in the repo. `LEVEL_W = 3200` is five `STAGE_W`-wide screens, one per wave, and
`zoneCamX(i) = i * 640`.

**The camera is the wall.** During a walk the camera lerps toward
`player.x − STAGE_W/2` clamped between the previous and the next zone, and the
player is clamped to `camX + WALL_X .. camX + STAGE_W − WALL_X`. That makes the
screen edges the player's bounds with no separate arena logic. At
`zoneCamX(waveIndex) + STAGE_W − WALL_X − 24` the camera has already stopped
advancing, so **walking into the stopped camera is what starts the wave** — and
once it starts, the camera locks to `zoneCamX(waveIndex)` and does not move
until the wave is cleared. The gate and the arena are the same number.

**Economy ids** (derived from the registry id `sunflower-brawler`, so the
economy editor must publish them): `Mint-Raven-Coin-SunflowerBrawler`,
`Free Run Token - SunflowerBrawler`, `Grant-Free-Run-SunflowerBrawler`,
`Start-Free-Run-SunflowerBrawler`.

## Mobile support (every cabinet)

Two shared primitives, both under `src/components/ui/`, so twelve cabinets do
not each grow their own copy:

| Primitive | File | Job |
|-----------|------|-----|
| `<FitStage>` | `FitStage.tsx` | Scales a fixed-size playfield down to fit, and reserves the scaled footprint so it leaves no dead space |
| `<TouchDPad>` / `<TouchMoveBar>` / `<TouchButton>` | `TouchControls.tsx` | On-screen controls, shown only on `(pointer: coarse)` |

### Why scale rather than reflow

A cabinet's geometry is written in fixed logical pixels and the physics reads
those constants every frame. Re-deriving them from a measured container would
mean a playfield that changes size mid-run — a maze with a different tile count,
a paddle suddenly narrower than the ball it is trying to bounce. So the
playfield renders at its logical size and is *scaled*, and **every pointer
handler that converts a screen position into a board position must divide the
scale back out**: `getBoundingClientRect` reports the scaled box, so a tap is
otherwise off by exactly the factor the board was shrunk by. Raven Bubbles is
the one cabinet that needs this (`toLogicalPoint` does it); the other five are
keyboard-driven and draw from state, so they do not.

Two things `FitStage` measures rather than assumes, both of which were wrong
before it existed:

- **Width comes from the nearest box the layout sizes** — a walk up from the
  frame to the first ancestor whose computed `display` is `block`/`flex`/`grid`/
  `flow-root`, minus that element's own padding. It originally budgeted a flat
  32px off the dialog, which ignored the `Modal`'s `p-2` and the OuterPanel and
  InnerPanel borders and padding underneath: ~36px in total, 68px on Raven
  Bubbles, which cut 12–15px off the right of every board. Inline boxes are
  skipped on the way up because they size themselves to their content and would
  echo the frame's own width back, so the budget could never shrink.
- **Height comes from summing the stage's siblings**, minus the chrome. A
  hardcoded reserve is only correct for the one window it was guessed at, and the
  first thing a narrower viewport does is wrap the header onto a second line.

Every cabinet's panel shell also changed from `w-[min(98vw,1100px)]` to
`w-full max-w-[1100px]`, because a viewport-relative shell is *wider* than the
popup content box that holds it (382px vs 358px on a 390px phone), so the shell
overflowed and the centred board was clipped. It now fills its container and
cannot exceed it. This is a no-op at desktop widths.

`minScale` is a floor on the **height** budget only, and never on width. A floor
is a constant but the width a board actually gets is not — it depends on every
border and padding between the stage and the screen edge, which on a 320px phone
came to 46px, not the 32px the floors were first derived from. Applying the floor
to width therefore demanded a scale *wider* than the container allowed and pushed
9–15px of board past the edge, out of reach without a sideways scroll. Width is
always fitted exactly; the floor exists for a short landscape window where the
height budget runs out, and past it the panel scrolls rather than the board
shrinking to a smear.

### Why touch controls dispatch keyboard events

Every cabinet already listens for `ArrowLeft`/`ArrowRight` and polls them for
held movement, or takes a direction once on keydown. Rather than teach twelve
games a second input path and then keep it in step with the first, a touch
button **is** the key it replaces: it dispatches a real `keydown` when the finger
lands and a `keyup` when it lifts, on `window`, where the cabinets listen. The
behaviour is then identical to the keyboard by construction.

The two paddle cabinets (Barley Breaker, Goblin Invaders) do not reuse that for
*movement* — `TouchMoveBar` reports the finger's absolute 0..1 position, because
a paddle that creeps sideways at a fixed rate is a paddle that is always behind
the ball. They share one extracted clamp with the keyboard path so both stop at
the same walls, and their **fire** button still dispatches the real `Space` pair,
so the launch is not a second code path.

### Per-cabinet decisions

| Cabinet | Approach | Touch |
|----------|----------|-------|
| Raven Bubbles | `FitStage`, `minScale` 0.5 | drag to aim, lift to fire (already had it) |
| Sunflower Brawler | **no `FitStage`** — the slot fills the panel, the canvas letterboxes itself (see below) | `TouchDPad` with **all four directions** (there is no jump) + two `TouchButton`s, ATTACK and MAGIC |
| Frogger | `FitStage`, `minScale` 0.38 | `TouchDPad`, **no down arrow** |
| Pac-Man | `FitStage`, `minScale` 0.51 | `TouchDPad` |
| Barley Breaker | `FitStage`, `minScale` 0.38 | `TouchMoveBar` + `Space` to launch |
| Goblin Invaders | `FitStage`, `minScale` 0.38 | `TouchMoveBar` + `Space` to fire |
| Tetris | `FitStage` on the **board only** — see below | four `TouchButton`s in a row |
| Go Fish, UNO, Solitaire, Poker, Blackjack | **no stage** — measured and patched | n/a (tap-driven) |

**Sunflower Brawler drops `FitStage`.** `FitStage` caps its scale at
`Math.min(1, …)`, so a 640×360 stage could never render larger than 640×360 CSS
pixels — on a 1100px-wide cabinet that left a stamp floating in the middle of a
mostly empty panel. The canvas also has no pointer handlers, so the footprint
`FitStage` reserves buys nothing here. Instead the slot is a
`flex-1 min-h-[180px]` div that takes whatever height is left under the HUD, and
the canvas fills it with `h-full w-full object-contain` plus
`image-rendering: pixelated`; the browser does the aspect-correct letterbox. On
desktop the stage now renders ~1050 px wide instead of 640, on a phone the slot
is the same leftover-height budget it always was, and `min-h-[180px]` stops a
short window (touch pad included) from squeezing the stage out of existence —
past that the column scrolls rather than the fight shrinking to a smear.

**Frogger has no down arrow.** It is a one-way trip up the screen, so `ArrowDown`
is not a direction that can be travelled. A button in the middle of the thumb's
arc that cannot do anything is worse than no button, so `TouchDPad` takes a
`directions` prop and Frogger asks for `["up", "left", "right"]`.

**The `TouchMoveBar` sets a target, it does not teleport.** Applying the finger's
position directly let a thumb flicked across the strip cross the whole arena
between two frames, which read as teleporting and made lining a shot up on a
column impossible. Goblin Invaders now stores `playerTargetX` and the tick walks
toward it at `PLAYER_SPEED` — the keyboard's own speed — so the ship still parks
under the finger but cannot outrun the play. A held arrow key cancels the target,
since that is a direct order.

**Tetris scales only the board.** Its two *fixed* 190px side panels were the
real problem — scaling the whole row to 0.62 would render a `text-xs` legend at
~7px. So the panels were made responsive (`w-full md:w-[190px]`), the keyboard
legend is `hidden md:block` on a phone (the touch buttons carry their own labels,
so it was ~150px of the budget spent on instructions for hardware the player does
not have), and the **board alone** went into `FitStage` to take whatever height
is left. `TILE_SIZE` is deliberately *not* reduced: it is read by the drop logic,
the piece matrix and the rendering, so changing it would change the game
mid-piece. A transform leaves it alone.

**Barley Breaker multiball has no cap and keeps its momentum.** Collecting one
used to rebuild the ball array from scratch into exactly three balls at fixed
angles, which discarded both the count and the velocity — a second multiball
with eight balls out collapsed them to three, and every ball snapped to a heading
the player never hit. Now the pickup reads the heading off a live ball, adds two
balls rotated a few degrees either side of it, and leaves every existing ball
with its own velocity untouched. `POWERUP_MAX_BALLS` is gone.

**Pac-Man goblins path rather than home in on the target.** `chooseGhostDir`
minimises straight-line distance, which is the classic hunting rule and is still
used when a goblin chases the player. It has no notion of *reachability*, though,
and the ghost house is walled internally, so a goblin released inside with its
target flipped to the doorway above it walks a closed four-tile cycle on its way
out — `(12,13) → (11,13) → (11,14) → (12,14) → (12,13)`, visible as a goblin
pacing in the house. Navigation legs (an eaten goblin heading home, or any goblin
heading for the house or its exit) now take the first step of a breadth-first
path instead. Measured over all 310 walkable tiles of the real maze, parsed out of
the source: the greedy rule revisits a tile on **310/310** journeys out of the
house and BFS on **0/310**, and the worst-case walk home drops from 55 steps to
38. An unreachable target still falls through to the greedy rule rather than
freezing.

Note this was found by simulation, not by play: the desktop browser window here
is not visible, so `requestAnimationFrame` is throttled and no live run is
observable. A goblin permanently frozen rather than briefly cycling has therefore
**not** been reproduced, and if the player still sees one after this change, the
next place to look is the release condition itself (`mode === "eaten"` plus the
house bounding box, which must be hit while snapped to a tile centre) rather than
the direction rule.

Tetris uses a flat four-button row rather than `TouchDPad`: a 3×3 pad is a fixed
168px tall against a 64px strip, and Tetris alternates between lateral slide and
rotate so every button wants to be one hop from the last — while a 3×3 plus puts
rotate in the middle, under nobody's thumb.

**The card games were measured, not wrapped.** At a 358px viewport Go Fish and
UNO were genuinely broken: their panels used `overflow-hidden`, which threw away
~300px of content instead of scrolling it, so Go Fish's *Your Hand* — the only
tap target in the game — sat 237px below the fold, and UNO's was worse: the hand
row was `flex-1 min-h-0`, and `flex: 1 1 0%` needs free space to grow into, which
a phone column does not have, so **the player's hand rendered at 0px tall**.
Solitaire needed nothing. Poker and Blackjack had only 28px rules buttons, now
44px hit targets with the visible circle unchanged.

### Known limits

- The floor on a **landscape** phone still leaves the page scrollable: a 20-row
  Tetris board is 480px tall and a 358px-tall viewport cannot hold it at any
  legible size. Past the floor the panel scrolls, which is the intended outcome.
- `useHeldKeys` dispatches one `keydown` per press, so a *held* left/right in
  Tetris moves one cell rather than repeating to the wall. Desktop still gets OS
  key-repeat. Per-tap one cell is the standard mobile control and the safe
  default at a 24px tile.

### The arcade's on-screen stick

The walking stick is the `phaser3-rex-plugins` `VirtualJoystick`, built in
`ArcadeTiledScene.initialiseControls` and read **every frame** by
`ArcadeBaseScene.updatePlayer` as `joystick.force ? joystick.angle : undefined`.
So a joystick left holding a non-zero force walks the avatar until a wall stops
it — the reported symptom was leaving a cabinet and finding the avatar already
off in one direction.

The plugin only clears itself from `scene.input`'s `pointerup`, which is not
enough: a finger that lifts while a cabinet's popup has the pointer delivers its
`pointerup` to the popup, not the scene, and `TouchCursor` can be left mid-drag
when its pointer is released out from under it. Either way the force survives and
nothing in the plugin will ever clear it. `ArcadeTiledScene` therefore binds its
own release on the window for **every** source that can end a gesture —
`pointerup`, `pointercancel`, `blur`, and `visibilitychange` — unbinding on scene
`SHUTDOWN`, because these scenes restart on every floor change and a leaked
listener would accumulate one more per visit. It goes through
`setEnable(false)`/`setEnable(true)`, which is how the plugin itself drops a held
pointer, rather than poking at `force`.

> **A duplicate scene was deleted.** `src/features/arcade/scene/` held
> `NightshadeArcadeScenePage.tsx` and `NightshadeArcadeScene.ts`, neither of which
> had a single importer — the shipping scene is
> `src/features/arcade/NightshadeArcadeScene.ts` (chain
> `NightshadeArcadeScene -> ArcadeTiledScene -> ArcadeBaseScene`). A stick fix
> was written and passed every verification against the dead copy before this
> turned up, which is what two divergent copies of a scene invites. If a change
> to the arcade scene appears to have no effect, check that you are editing the
> copy under `src/features/arcade/` and not under `scene/`.
- Q (hold/swap) and Space (hard drop) in Tetris remain keyboard-only. A fifth
  `TouchButton` is a one-line addition.
- `BACK TO ARCADE` in Poker and Blackjack is 40px tall, under the 44px thumb
  guideline. It is full-width, so it is not a small target in practice, and it is
  the only control in the twelve cabinets still below it.
- Touch controls are `sticky bottom-0` so they survive a scrolling panel — at
  320×640 Pac-Man's down key sat 26px below the fold and did nothing until the
  panel was scrolled.
- Verified by driving headless Chromium over CDP at a real 358×800 and 320×640
  viewport (mobile emulation + touch, with `scrollbarPx` confirmed 0 at every
  level of the chain), plus hit-testing the boards' right edges with
  `elementFromPoint` rather than trusting `getBoundingClientRect` alone. Touch
  input was synthesised via CDP, not real hardware.

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
