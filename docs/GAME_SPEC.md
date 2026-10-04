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
`Start-Free-Run-RavenBubbles`. See
[Free runs](#free-runs-one-coherent-decision-not-three-lookups) for what happens
before all four are published.

## Sunflower Brawler (`src/features/arcade/games/sunflowerbrawler/`)

The twelfth cabinet, on `Machine 12` — the second cabinet the original arcade
left empty. A **side-scrolling beat 'em up**: one champion walks a scrolling
street, fights fifteen scripted waves in three blocks with a boss closing each,
and then goes **endless**. It was a one-on-one fighting game until that game
turned out to be a button masher — see
[Why the genre changed](#why-the-genre-changed).

| Rule | Value |
|------|-------|
| Format | **One run** — 15 waves, `MAX_LIVES` (3) lives, then **endless** until lives run out |
| Blocks | 1–5 **goblins** · 6–10 **undead** · 11–15 **elites**, a boss closing each |
| Bosses | `GUNTER` (5) → `GILDA` (10) → `GORGA` (15) |
| Clock | **None.** A run lasts as long as the player takes |
| Clearing | Kill every enemy in a wave → `WAVE_CLEAR_MS` banner → walk to the next screen |
| Health | **Carried over for the whole run** — only a life restores it |
| Defeat | Lives reaching 0 → `GAME OVER`, with the wave reached |
| Endless | Past wave 15, **all fifteen waves replay** — bosses included — at `endlessHpScale` per loop |
| Reward win | Clear wave 15 → **1 Raven Coin**, paid on `reachedFinale` and kept even if the player then dies in endless |
| Difficulty | 4 levels, UTC-day seeded for reward runs (weights **3 / 3 / 2 / 1**) |
| Roster | Barlow (Bumpkin), Graxle (Goblin), Nyx (Nightshade), Reginald (Sunflorian) |

### The lobby never scrolls

The lobby is a **fixed-height flex column with `overflow-hidden`** — one page,
always, at every window size. That is a layout constraint rather than a styling
preference, so the three things it depends on are load-bearing:

* **`min-h-0` on the one flexible child.** A flex item will not shrink below its
  content without it, so the column would overflow and the page would scroll —
  which is exactly what this replaced.
* **The champion panel is the only elastic section.** Everything else is text of a
  known size, so the panel absorbs the difference between a tall window and a
  short one and the controls and buttons below it never leave the screen. It is
  capped (`sm:max-h-[280px]`) so growth stays bounded, and the column centres
  itself past that rather than stretching four cards around a small character.
* **Grid rows are `minmax(min-content, 1fr)`, never `minmax(0, 1fr)`.** A card
  must never be shorter than the stats inside it. With a `0` floor the portrait
  took whatever was left and pushed `HP`/`SPEED`/`COMBO`/`SPELL` out of the card
  entirely — on the two-column layout only, where four champions make two rows.

`NPCIcon` sizes a canvas backing store, so it needs a **pixel** height rather than
a CSS length. The portrait box is therefore measured with a `ResizeObserver` and
the number handed down, clamped to 40–96px. Measuring the element rather than
computing the number from the other panels' text means the portrait cannot drift
out of sync with the layout.

The "are you sure?" box is **absolutely positioned** inside a zero-height wrapper.
In flow its ~180px pushed the buttons it was asking about off a short screen, and
with no scrollbar there was nothing to rescue it; overlaid, the layout is
identical whether or not it is showing.

Verified with no overflow and every card's text visible: **900 → 440px** panel
height on the four-across layout, **900 → 520px** on the two-column one (≈ 463px
and ≈ 547px of browser viewport). Below those floors the champion panel clips
rather than overlapping the controls. The start buttons sit **side by side** above
`sm` — as two full-width blocks they were ~130px of a ~400px non-negotiable
budget, and there is 1100px of width to spend on them.

### The champion select is a sheet on narrow screens

Below `sm` the lobby shows **only the chosen champion's name and a CHANGE
button**. CHANGE opens a sheet with the four cards and a CONFIRM / CANCEL pair;
CONFIRM commits, CANCEL discards, and the name on the menu updates only if the
choice actually changed.

The cards were the whole budget on a phone. Two rows of cards, each with a
portrait, name, faction and four stat lines, is ~270px of a ~640px lobby — and it
is the section that gets squeezed, because everything else is `shrink-0`. Below
about a 620px panel the cards ended up with a portrait at its 40px floor and
`HP`/`SPEED`/`COMBO`/`SPELL` pushed out of the card entirely. Collapsing to a
name moves the fit floor from **620px to 500px** and removes the squeeze
altogether; desktop is untouched, because there is room for the cards inline.

**Two pieces of state, not one.** Tapping a card in the sheet is a *proposal*
(`draftPlayerId`); `playerId` is the committed choice. CANCEL is only a true
no-op because the taps went somewhere else — with one piece of state, "cancel
without changing" would mean not letting the player tap anything at all.

The cards are rendered **once**, by whichever branch is live, because the sheet
needs them somewhere CSS cannot move them. `useIsNarrowLayout` reads the same
`sm` breakpoint the Tailwind classes do. A sheet may scroll (`max-h` +
`overflow-y-auto`), unlike the menu behind it — that rule exists so the *menu* is
always whole, and a sheet the player opened on purpose is a different thing. Its
grid declares both rows and floors them at `min-content`, or the portrait's
`ResizeObserver` measures zero and every card renders at its 40px floor in the
one place the player opened specifically to look at the characters.

`FighterCard` inherits its text colour, so the sheet sets `text-slate-900` on the
grid rather than inheriting the modal's `text-white` — which renders every
champion's name white-on-white. Measured 16–18:1 contrast on all four.

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
   to `Z_MAX` (210, near); ←→ walk along the plane, ↑↓ step into and out of it.
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
| **Barlow** | Bumpkin | 110 | 232 | `attack` **11** → `attack` **12** → `hammering` **23** dmg, 480 px/s finisher | **34 dmg** |
| **Graxle** | Goblin | 120 | 250 | `axe` **10** → `axe` **11** → `mining` **19** dmg, **340 px/s lunge** | **30 dmg** |
| **Nyx** | Nightshade | 90 | 244 | `attack` **10** → `attack` **11** → `mining` **18** dmg, 520 px/s `z` scatter | **36 dmg** |
| **Reginald** | Sunflorian | 100 | 228 | `attack` **12** → `axe` **14** → `hammering` **26** dmg | **42 dmg** |

Graxle is the fastest to startup and the lightest hitter; Reginald is the
slowest and the heaviest; Nyx has the least health and the quickest finisher.
Health runs 90–120 and speed 228–250, so picking a champion is a real choice
rather than a colour swap.

**Every champion is the fastest thing on the street.** Walk speeds are 228–250
against a grunt's 142–172 and a heavy's 76–108, and the enemies were *not*
scaled up with them. This is the load-bearing number for the whole genre: it
makes repositioning a free action, because escaping a crowd costs only time and
time is something the player has. So the answer to being surrounded is to move,
not to mash — and the depth plane is worth using on its own, not only as a way
of dodging a swing.

**Champions also out-range the common street.** A melee hitbox runs from 10 px
*behind* the attacker to `reach` in front, and every one of the twelve combos was
widened by **+12 px** — the opening hit lands 74–82 px out against a grunt's
60–66 and a heavy's 68–84. A whiffed swing is the most frustrating thing in a
brawler and it is disproportionately a *spacing* failure, not a timing one: the
player is a few pixels short while reading a crowd, not a few frames early.

The advantage is **not** total, and where it stops is the design:

| | Jab / combo 1 | Heaviest |
|---|---|---|
| Champions | **74–82** | 86–94 |
| Grunts & heavies | 60–92 | 68–112 |
| Specialists (Wizard, Blacksmith) | **92**, **84** | **138**, 104 |
| Bosses | **100–108** | **128–136** |

So the answer to a wave-2 goblin is to walk in and hit it, and the answer to the
Wizard or to Gunter is *not* — which is what makes a roster readable rather than
a stat sheet. What the advantage does cost is that one common enemy can no
longer catch a player who keeps their distance, so the pressure has to come from
two sides at once: the depth plane and `maxAttackers`.

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
for it: `Z_MAX = 210` against a 99 px body is a bit over three body-heights, deep
enough that a wave can spread out across the plane and a player has somewhere to
reposition *to*, and shallow enough that the whole band stays on screen without
the camera ever tilting.

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

### Three blocks, a boss closing each

Fifteen waves, one per screen of the level, laid out in `enemies.ts`. The run is
three blocks of five and the blocks are built to ask *different* questions, so
that wave 11 does not feel like wave 6 with more bodies:

| # | Name | Spawns |
|---|------|--------|
| 1 | `GOBLIN PATROL` | 2 Scout, 1 Brute |
| 2 | `GOBLIN RAIDERS` | 2 Sneak, 1 Scout, 1 Brute |
| 3 | `PICKPOCKETS` | 2 Gold Tooth, 2 Sneak, 1 Brute |
| 4 | `GOLD RUSH` | 3 Gold Tooth, 1 Grimtooth, 2 Scout |
| 5 | **`GUNTER`** | boss |
| 6 | `THE BONEYARD` | 3 Skeleton, 1 Zombie |
| 7 | `GRAVE LEGION` | 2 Skeleton, 1 Banshee, 1 Dreadhorn |
| 8 | `DEAD CREW` | 2 Phantom Face, 2 Skeleton, 1 Zombie |
| 9 | `THE FOUNDRY` | 2 Skeleton, 1 Zombie, 1 Dreadhorn |
| 10 | **`GILDA`** | boss |
| 11 | `ELDRIC'S GUARD` | 2 Eldric, 2 Skeleton, 1 Dreadhorn |
| 12 | `THE WIZARD` | 1 Wizard, 2 Banshee, 1 Zombie |
| 13 | `THE CHAMPION` | 1 Chun Long, 2 Eldric, 1 Dreadhorn |
| 14 | `THE FORGE` | 1 Blacksmith, 2 Chun Long, 1 Eldric, 1 Zombie |
| 15 | **`GORGA`** | boss, 1 Grimtooth |

* **Goblins** (22–62 HP, 108–172 px/s) are fast and frail. They close distance
  and poke, so the answer is to hold a line and make them come to you.
* **The undead** (32–80 HP, 76–134 px/s) are slow and tanky. They walk straight
  in and absorb the string, so the answer is the depth axis — step off their
  line, let them pass, hit them from the line they are not on.
* **Elites** have no single answer, which is the point: by wave 11 the player
  should be reading the *crowd* rather than the block.

Seventeen distinct enemy NPCs across the three blocks, every one verified to
serve the full animation vocabulary from the CDN.

Spawn positions alternate between the left and right edge (`index % 3`) and are
spread across the whole `z` range, so a wave never arrives as a single file
column walking in from one side. The boss is the exception: it spawns **already
on screen** at `camX + STAGE_W − 240`, mid-plane, facing the player, with no
spawn fade — it is simply already there when the banner clears.

### Difficulty comes from the wave, not only from the setting

`hpMultiplier` and its siblings in `session.ts` set the *difficulty band*. What
makes wave 14 harder than wave 4 is a separate per-wave multiplier applied on
top, so the roster stays legible and the stat sheet grows:

| Function | Per wave | Effect |
|---|---|---|
| `waveHpScale` | **+6 %** | wave 15 is 1.84× wave 1 |
| `waveSpeedScale` | +1.2 %, capped | hardest grunts stay *readable* |

Linear rather than exponential on purpose. An exponential ramp turns wave 14
into a wall of health that reads as a bug, while a linear one keeps every
individual fight winnable and lets *more enemies plus worse specials* do the
late work. The speed cap is the same argument from the other side: past about
15 % above a grunt's base the AI stops being something you read and starts being
something that happens to you.

### Enemies are separated by behaviour, not by colour

Every entry in `ENEMY_SPECS` is a different **shape of threat**, carried by the
move table rather than the sprite. Every enemy has a `jab` (cheap, safe) and a
`heavy` (slow, long, high `zReach` — the one that punishes standing still). Some
also have a **`special`**, which is the move that makes that enemy *that* enemy:

| Enemy | Special | The answer |
|---|---|---|
| Goblin Sneak | second dash | keep moving |
| Gold Tooth | 96 px pickpocket swipe, narrow `z` | step off the line, do not back off |
| Grimtooth | slow `z`-splitting overhead | be elsewhere along `x` |
| Phantom Face | flat, very wide sweep, `z` 78 | depth, and it will not chase |
| Zombie | grab, `z` throw 620 | it wins the positional argument outright |
| Eldric | 300 px/s lunge-through | actually hold the line |
| Blacksmith | one-shot, `hammering` at 40 fps | believe the one-second windup and leave |
| Wizard | 138 px reach, zero advance | close the gap; he is worst up close |
| Chun Long | fast, low-damage, high-volume | volume, not any one hit |
| **Gunter** | CHARGE — 380 px/s, arrives swinging | commit to the trade |
| **Gilda** | DISSOLVE — `z` 96 and a 520 `z` scatter | there is no clean answer; you lose ground |
| **Gorga** | QUAKE — `z` 118, advances while winding up | a trade-off, not a correct response |

`specialAt` (`far` / `close` / `inRange`) says when a special is worth spending,
so a lunge is spent closing a gap rather than poking at your face, and
`specialCooldownMs` stops any of them becoming a one-button monster — which at
Expert, where the AI re-rolls every 150 ms, it otherwise would.

### Health carries over; lives are the safety net

`finishWave` used to set `player.hp = maxHp`. It no longer does — **health is
carried across every wave boundary for the whole run**, and the only thing that
restores it is `respawn`, which costs a life.

The refill was the genre's standard pacing device (the wave banner as the run's
only breathing room), and the argument for it was that fifteen waves would
otherwise compound every mistake into an unwinnable run. The owner's call is the
opposite, and it is the better one: with a refill the bar was **decorative**,
because the only thing that ever moved it was the wave you had just finished.
Carrying it is what makes the `+30 HP` food drops worth walking for, and it makes
a long run a resource being managed rather than a sequence of resets — which is
what fifteen waves and then endless actually asks for.

Measured with the scripted bot, best wave reached per band, refill removed:

| Band | With refill | Carried over |
|------|-------------|--------------|
| Easy | 11 | **11** |
| Medium | 9 | **9** |
| Hard | 6 | **6** |
| Expert | 5 | **4** |

Effectively unchanged, and slightly *easier* than the numbers suggest in real
play: the bot does not walk onto pickups, so it gets none of the healing the
carry-over makes worth having. **Lives remain the run's difficulty curve** —
three of them across fifteen waves.

### Endless

Clearing wave 15 does **not** end the run. `finishWave` increments and the game
continues into endless, which replays **all fifteen waves — all three bosses
included** — with `endlessHpScale` compounding **1.35× per loop**. Lives run out
eventually; that is the only ending there is.

Replaying from wave 1 rather than skipping ahead is deliberate: replaying from
wave 6 was tried and drops Gorga entirely, because Gorga *is* wave 15, so the
run's final boss never appears again and the loop loses the punctuation that
makes a boss wave feel different from an ordinary one.

Two things make this possible on a finite canvas, and one of them was a bug:

* **`zoneCamX` is unbounded** and `stageOffset` wraps *in the blit*. Wrapping
  used to happen in `zoneCamX`, which inverted the camera's walk range for wave
  15 (`[13440, 0]`) and pinned the camera at 13 440 forever — no wave could
  ever open. Positions are now ordinary and continuous; the canvas recycles.
  The street is periodic, so the wrap is invisible, and actors are drawn in world
  space so nothing jumps.
* **The reward pays on `reachedFinale`,** which latches the instant wave 15 is
  cleared and *stays* true. Not on `result === "victory"`, which no longer
  exists: a player who clears wave 15 and dies on wave 40 has still completed
  the run, and keying the payout off a terminal state would take the coin away
  for playing well.
* **`FINALE_BONUS_SCORE`** (2 500) is paid once for beating the run rather than
  surviving it — the only reward that specifically pays for clearing the finale,
  which keeps it worth chasing after the coin is already banked.

### The bosses are ordinary actors with ordinary sheets

The boss was originally `src/features/arcade/assets/big_goblin.png`, copied from
Sunflower Land's `RetreatScene`: a 108×35 strip of four 27×35 frames played at
6 fps. It has an idle cycle and nothing else — no walk, no attack, no death —
so every one of its states had to be **faked**. `drawBoss` leaned the sprite
through each swing and swapped the strip's four frames in as poses, which read
as a boss in a still screenshot and as a slideshow in motion.

It is gone. All three bosses are `NPC_WEARABLES` entries like every other
fighter, so the animation CDN serves them the same full cycle vocabulary
(`idle`/`walking`/`hurt`/`death`/`attack`/`axe`) at the same 96×64 frame size.
That collapses the entire special case: there is no boss-only draw path, no
`isBoss` flag, no strip geometry, and no second art file. A boss is an
`ActorRT` drawn by `drawSheetActor` exactly like a grunt; `tier: "boss"` alone
makes it bigger and puts a bar on the HUD.

**A caveat worth stating plainly, because it is visible.** In the main game's
data `gunter`, `gilda` and `gorga` share a body, shirt and tool — Infernal
Goblin, Fossil Armor, Infernal Pitchfork — and differ in hair, with Gunter
having no horns. They are three closely-related infernal figures rather than
three unrelated ones, which is a defensible reading for a faction's three
wardens and is what the main game ships. In play they are separated by scale,
colour and move set rather than silhouette. If they ever want to be visually
distinct, that is an edit to `NPC_WEARABLES` in the main game — not something
this cabinet should paper over.

Being a boss is now **three numbers and nothing else**: `scale`, `rx`, `rz`.
Each enters already on screen, mid-plane, facing the player, with no spawn fade.

Boss health is the easiest number in the game to get wrong by a factor of two,
so it is worth recording how these were set. A full string does ~40 damage, and
each was measured against a bot that keeps its distance and dodges depth:

| Boss | Wave | Base HP | At wave | Measured |
|---|---|---|---|---|
| `GUNTER` | 5 | 200 | ~250 | ~31 s |
| `GILDA` | 10 | 260 | ~400 | ~64 s |
| `GORGA` | 15 | 340 | ~625 | ~77 s |

A first draft ran 300 / 400 / 520 and measured at **58 / 125 / 100 seconds** —
a wall rather than a fight, and with 15 waves to play there is no room for a
boss that eats two minutes. The step between Gunter and Gilda is only a third
because the *move set* is what escalates, not the health: more health on top of
a harder fight just makes the same fight longer.

Each boss's three moves have **three different tells**:

* **Gunter** — SWIPE (line, step off it) · SLAM (`zReach` 70, a third of the
  plane, go elsewhere in `x`) · **CHARGE**, 380 px/s closing that arrives already
  swinging, so holding a line has to be a real commitment.
* **Gilda** — SWIPE · SLAM · **DISSOLVE**, `zReach` 96 covering nearly half the
  plane with a 520 `z` scatter. The first move in the game that loses you the
  positional argument outright rather than testing it.
* **Gorga** — SWIPE · SLAM · **QUAKE**, `zReach` 118 (over half the plane) that
  also advances 200 px/s while winding up over a 600 ms telegraph. There is no
  single correct answer: step off the line and you are behind it, stay and you
  take 30. Every other move has a response; this one has a trade-off, which is
  what makes it a finale rather than a bigger wave 10.

### AI re-rolls on a tick, it does not cheat

`stepEnemyAi` runs once per decision, on a timer. Everything is a roll against a
parameter today's difficulty sets, so "hard" never means the AI cheats at the
physics — it re-rolls more often, commits more often, and commits to the heavy
instead of the jab more often.

The branch order matters, and it is in four numbered steps now that a `special`
exists:

1. **The special**, if this enemy has one and it is worth spending — gated on
   `specialAt`, so a lunge is spent closing a gap rather than poking at your
   face, and on `specialCooldown`, which is *not* the same timer as the decision
   tick. Those answer different questions: `timer` is "when may I decide
   something", the cooldown is "when may I use *that*". Rolling them together is
   what would turn a strong special into a one-button monster at Expert.
2. **Committing**, so an enemy already in range never walks *past* you to
   reposition. Still subject to `maxAttackers`, and so is the special — that
   budget is the single most effective difficulty control the genre has.
3. **Repositioning** (`spacingChance`), so a wave that has just been hit gets a
   beat to breathe.
4. **Approach**, which stops at `jab.reach` rather than walking into the
   separation radius, so an enemy waiting for an opening holds its ground
   instead of grinding against you frame after frame.

Special cooldowns are **staggered on spawn** (400–1300 ms) so a wave's specials
do not all come off cooldown on the same tick, which would read as a
synchronised attack rather than a crowd.

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
**Space** attack (three-hit combo), **X** magic (50 meter). Touch gets a
`TouchAnalogStick` plus two `TouchButton`s, ATTACK and MAGIC, which dispatch the
same `Space` / `KeyX` codes so there is exactly one input path.

The stick replaces a `TouchDPad` here specifically. A d-pad is four separate DOM
buttons and a thumb can only reliably hold one, so there was **no way to walk and
step into the plane at the same time** — the most important move in a beat 'em
up, and the one the whole depth plane exists for. The stick reads two axes at
once and gets diagonals for free, and `x` and `z` are independent axes, so
"right *and* into the plane" is a real move. It mirrors the arcade floor's
`VirtualJoystick`: same 7-on-15 thumb-to-base ratio, same 13% deadzone (the
floor's `forceMin: 2` on a radius-15 base), same pin-to-rim travel. See
`TouchControls.tsx` for why it is a DOM component rather than the Phaser plugin.

The whole play screen is `select-none`: a long press on a phone otherwise
started selecting the HUD — champion name, wave counter, score — with a copy
callout over the stage.

**Level.** Composed once from `nightshade-arcade-tilesheet.png` rather than
rendered from a map — the `.tsx` tileset the Tiled maps reference does not exist
in the repo. `LEVEL_W = 14400` is fifteen `STAGE_W`-wide screens (960×540), one
per wave, and `zoneCamX(i) = i * 960`.

**The canvas is finite and the world is not.** `zoneCamX` returns an ordinary
unbounded position, so an endless run's wave 40 has its camera at 38 400 px.
`stageOffset(camX)` does the wrap, and it is applied **in the blit** and nowhere
else. That location matters: wrapping used to happen inside `zoneCamX`, which
inverted the camera's walk range at wave 15 (`[13440, 0]`) and pinned the camera
at 13 440 forever, so no wave could ever open. Unbounded positions keep that
clamp well-ordered for every index; the backdrop recycles underneath a stationary
camera. The street is periodic — the stall row cycles four colours, the treeline
repeats on its own pitch — so the seam is invisible, and actors are drawn in
world space so nothing jumps at the wrap.

**The camera is the wall.** During a walk the camera lerps toward
`player.x − STAGE_W/2` clamped between the previous and the next zone, and the
player is clamped to `camX + WALL_X .. camX + STAGE_W − WALL_X`. That makes the
screen edges the player's bounds with no separate arena logic.

**The camera gates the wave, not the player's position.** A wave opens when
`|camX − zoneCamX(waveIndex)| ≤ CAMERA_SETTLED_EPSILON` — that is, the moment
the sideways scroll stops — and the player must additionally be at least
`WAVE_ENTRY_X` (half a screen) into the zone. Once it starts, the camera locks to
`zoneCamX(waveIndex)` and does not move until the wave is cleared.

This used to be a gate on the player's `x` at
`zoneCamX(waveIndex) + STAGE_W − WALL_X − 24`, a third of a screen *past* where
the camera stops advancing — so every wave opened with a forced walk across dead
screen, holding right with nothing on it. Two things follow from the new rule.
The wave opens the instant the scroll halts, and the player therefore chooses
**where** the fight starts by choosing when to stop. The `WAVE_ENTRY_X` half of
the test exists only for zone 0, whose camera range is `[0, 0]` and is therefore
"settled" from the first frame; for every later zone, reaching a camera position
already means standing past it.

### Ambushes on the walk

The walk between waves is the one stretch of a run with nothing to do — a held
direction across empty street. The genre's own answer is a couple of enemies
stepping out of a doorway, and that is what `startRoam` does.

* **One or two, never a heavy.** A pair is enough that the depth plane matters
  (one on your line, one on another is a real decision) and few enough that an
  ambush stays an interruption rather than a second wave. Only
  `tier === "grunt"` ids are eligible, so an ambush can never open with a
  Dreadhorn — a heavy mid-walk, while the player is mid-stride, is the fastest
  way to make the walk feel unfair rather than eventful.
* **The pool is derived from the wave it walks into** (`roamPool(waveIndex)`),
  not hand-written. This fixed a shipped bug: the old `ROAM_POOL` was free to
  name an NPC that appeared in no wave's roster — its wave-3 entry offered
  `banshee`, whose sheet (`boneyard betty`) belongs to wave 4. Nothing preloaded
  it during the walk to wave 3, so an ambush could open on an actor whose sheets
  were still in flight, and an actor with no sheet draws as `drawSheetActor`'s
  coloured-box fallback: **a purple square standing in the street.** Deriving the
  pool removes the class of bug — an ambush can now only be made of enemies the
  wave itself is made of, so its art is by construction already requested by the
  wave preload. The three boss waves (5, 10, 15) spawn a boss alone, so their
  pools are empty and those walks have no ambush, which is also the right pacing:
  the boss should be the thing that ends the run.
* **The preload is derived per NPC too** — `enemyAnimsFor(npc)`, not one shared
  list. This fixed the same bug wearing a different hat: **seven NPCs flashed a
  coloured square through every attack.** `ENEMY_ANIMS` was a flat
  `[idle, walking, hurt, death, attack, axe]`, written when enemies had two moves
  each and none of them cast, with a comment saying so. Then the specials landed
  and moves began naming `hammering`, `casting` and `mining` — and nothing
  noticed, because a *missing cycle* does not throw. `renderMatch` found no image
  and drew the placeholder body instead, so the character kept its art, size,
  facing and position and only its body turned into a flat rectangle, which reads
  as a baffling intermittent visual glitch rather than a preload bug:

  | NPC | cycle never loaded | when |
  | --- | --- | --- |
  | Grimtooth, Dreadhorn, Blacksmith, **Gorga** | `hammering` | special |
  | **Wizard**, Gilda | `casting` | Wizard: *every jab*; Gilda: special |
  | Eldric | `mining` | special |

  The Wizard was the worst of it, since its basic attack is a cast. Deriving each
  character's set from **its own moves** makes the bug unwritable — a move cannot
  name a cycle its own NPC will not be asked to load — and it is cheaper than the
  blunt fix: **106 sheets** against the 153 a full union would fetch, and only 4
  more than the broken 102. The Wizard now needs five sheets, not six; it never
  plays `attack` or `axe`.
* **Endless reuses the same machinery.** `roamPool` resolves through
  `getWaveSpec`, so an endless wave's ambush is drawn from *that* wave's roster
  — which is one of the fifteen, already cached, so a mid-walk encounter in loop
  3 opens on real sprites exactly as it does in the finite run.
* **HP at 0.72×.** An ambush should cost a little health at worst, not a life.
* **Placement.** The first steps out *ahead* on an offset line, so it is
  something to walk into; a second comes from *behind*, so the player is then
  walking away from something and the screen edges stop being safe. Both are
  placed relative to the player, not the camera, so they stay meaningful as the
  view scrolls under them. Alternating `z` keeps the two off one line.
* **An ambush delays the wave, never replaces it.** The wave gate is tested
  *after* the ambush trigger, so a player who reaches both in one frame gets the
  ambush and must clear it; `roaming > 0` holds the wave shut until the street
  is empty.
* **Where.** Progress along the walk, as a fraction of it (`roamPoints`), because
  a walk's length varies with where the last fight ended. One point at 0.55 when
  the walk is under a screen and a fifth, two points (0.3, 0.72) when it is
  longer. Measured on a full run: the first lands at 0.56 of a 326 px walk, the
  rest at 0.55 of an 850–1100 px walk.
* **No leash, deliberately.** A champion outwalks a scout, so a leash would let
  "hold right forever" trivialise an ambush *and* stall the wave behind it. An
  outrun roamer is instead solved by turning round — which is the interaction
  the street is meant to provoke. A player who never attacks at all dies on wave
  1 for all four champions, so the run cannot be stalled.
* **The ambush is a real fight.** `stepMatch`'s hostility test is
  `phase === "fighting" || roaming > 0`, not the phase alone — otherwise an
  ambush would be two statues the player walks past. For the same reason
  `respawn` returns to `walking` when `roaming > 0`, so dying to an ambush does
  not announce a wave that does not exist.
* **The HUD counts them separately.** `AMBUSH — 2 LEFT` rather than folding them
  into the wave counter, which would claim a wave still had three enemies when it
  had none and the street had two.

### Pickups

A beat 'em up is a resource game wearing a costume: the health bar is the real
difficulty curve, so without anything to recover a run is decided by the first
mistake. Drops make a bad wave survivable rather than rewarding a good one.

Two kinds, and the choice between them is the point. **Health** (30 HP, drawn as
a **plate of food** from the main game) is the panic button and is only worth
anything when low. **Magic** (34 meter, drawn as a **Raven Coin**) compounds —
the meter is built from damage and kills, so a cast is funded by playing well,
and banking a coin lets you enter a wave with the spell already charged.

Both are drawn as the things they are rather than as abstract resources. Food and
a coin are the genre's shorthand and read instantly at 38 px — a plate of
vegetables says "eat this to get better" where a heart or a flower says
"resource" — and both are already things a Sunflower Land player recognises from
the main game, so a pickup needs no explanation.

* **Chance on death**, weighted by tier via `dropChance`: 0.28–0.34 for grunts,
  0.6–0.72 for heavies, and a guaranteed 1 for the boss. So the *choice* is
  interesting — a grunt is a coin-flip worth little, a heavy is close to certain
  and worth a bar.
* **Which** kind is decided by need at the moment of the drop (`rollPickup`):
  below 40 % health is always health; below 34 % meter is magic; full on both is
  a coin flip, so a well-fought wave still pays out.
* **On the plane.** A drop sits in `(x, z)`, bobs on its own phase, and is
  collected inside `PICKUP_REACH_X` (52) × `PICKUP_REACH_Z` (30) — a
  *rectangle*, matching the shape of an attack's hitbox. Stepping onto a drop's
  line is how you take it, which keeps the depth axis paying off outside combat
  and stops a health drop under your feet being a freebie while retreating. The
  `z` arm is slightly wider than an attack's 26, deliberately: a swing is a
  commitment you have to aim, a pickup is a thing you walk over.
* **Drops do not expire.** No lifetime, no timer, no blink, no fade. There were
  two — 14 s, then 32 s with a 4 s blink — and both were wrong for the same
  reason: **a clock cannot see what the player is doing.** A wave's interesting
  moment is not the first kill, it is the moment you have spent the meter, taken a
  hit and backed off to let a crowd thin out. That is exactly when a countdown
  kills the drop you were going back for, and it kills it *quietly enough* that
  the player reads it as the game forgetting to spawn it. Worse, it punishes the
  correct read of a crowd, which is the opposite of what a pickup is for.

  Two things now remove a drop, and both are the player's own doing: **collecting
  it**, or **walking far enough past it that the camera leaves it behind**
  (`PICKUP_DESPAWN_PAD`, 170 px). The street scrolls one way and the player always
  walks forward, so "out of frame" is overwhelmingly *behind* them.

  The pad is deliberately wider than `ARENA_PAD` (150), the margin an enemy may
  stand in before entering. An enemy can die while still off-screen, and a drop
  that vanished the instant it was born would be a kill that paid nothing for
  reasons the player never sees. This replaces the old `finishWave` sweep, which
  deleted every drop the moment a wave cleared — including ones the player was
  still close enough to walk back for.

  Measured: a drop survives three minutes of simulated standing still, and a
  15-wave run never has more than **one** drop on the street at a time.
* **Art is copied in, not fetched.** The main game's `food/` folder is not
  published on the arcade's asset CDN — `food/roast_veggies.png` and its
  siblings all 404 there, while `icons/`, `decorations/` and `npcs/` resolve —
  so `src/features/arcade/assets/food_roast_veggies.png` is committed (448
  bytes, following the `RavenCoin.webp` precedent). Note the source is 12×11, so
  `PICKUP_SIZE` is a ~3.5× upscale; it stays crisp only because `renderMatch`
  disables image smoothing for the frame.
* Collection pushes a floating label (`+18 HP` / `+34 MAGIC`) — the one event in
  the game the player cannot infer from the HUD, since the bar jumps but *why*,
  and what was just spent, is not visible.

**Economy ids** (derived from the registry id `sunflower-brawler`, so the
economy editor must publish them): `Mint-Raven-Coin-SunflowerBrawler`,
`Free Run Token - SunflowerBrawler`, `Grant-Free-Run-SunflowerBrawler`,
`Start-Free-Run-SunflowerBrawler`. All four are now in
`nightshade-arcade-editor-sample.json`; `npm run freerun:audit` reports what a
real economy is still missing and prints the JSON to paste.

### Free runs: one coherent decision, not three lookups

The rule is **one free reward run per cabinet for VIP, one for the whole arcade
for everyone else**. It is enforced entirely by published economy data: a cabinet's
`Free Run Token` is minted once a day, burned when a free run *starts*, and its
absence is the signal that the allowance is spent. Burning on the open rather than
on the payout is what makes it unrefundable — losing, quitting or refreshing all
leave the token destroyed.

The bug this cabinet surfaced was that the **gate, the grant and the burn each
resolved their token independently**: the gate by item *name*, the other two by
action *id*. Nothing checked they matched, and a cabinet is four ids, so every
half-published state was wrong in a different direction:

| published        | gate watched | open burned | result                                     |
| ---------------- | ------------ | ----------- | ------------------------------------------ |
| nothing          | —            | 565         | gate closed, demands a ticket              |
| item only        | **567**      | **565**     | **gate never closes — unlimited free runs** |
| item + open      | 567          | 567         | correct                                    |
| item + grant     | **567**      | **565**     | **gate never closes — unlimited free runs** |
| all four         | 567          | 567         | correct                                    |

The dangerous rows are the ones where the item is published but the actions are
not, because `Start-Free-Run-*` falls back to the arcade-wide action: the gate
watches a per-cabinet token nothing ever burns, so it reads "still holding a
token" forever and **every run is free** — one Raven Coin per attempt, silently.

`resolveFreeRunEntitlement` in `lib/ravenCoin.ts` now answers all three at once,
and reads the token out of the open action's `burn` map rather than guessing the
name, because that map *is* the answer. The grant is cross-checked against it, and
anything incoherent fails closed to "charges a Play Ticket" with the reason named
in the dev console. A coherent entitlement cannot grant one token and burn
another, so the leak is unreachable by construction.

Two consequences worth stating plainly:

- **A VIP no longer falls back to the arcade-wide allowance** on an unpublished
  cabinet. It did not used to either (the name lookup found no token), and
  allowing it would have granted an extra free run per unpublished machine. An
  unpublished cabinet now simply has no VIP free run.
- **`onStartFreeRun` no longer has an "ok, free" branch.** It used to return
  `{ ok: true, funding: "free" }` when no run-open was published — an
  unconditional *run for free*. That branch was unreachable from the UI (the gate
  was already closed), and it is gone.

## Mobile support (every cabinet)

Two shared primitives, both under `src/components/ui/`, so twelve cabinets do
not each grow their own copy:

| Primitive | File | Job |
|-----------|------|-----|
| `<FitStage>` | `FitStage.tsx` | Scales a fixed-size playfield down to fit, and reserves the scaled footprint so it leaves no dead space |
| `<TouchAnalogStick>` / `<TouchDPad>` / `<TouchMoveBar>` / `<TouchButton>` | `TouchControls.tsx` | On-screen controls, shown only on `(pointer: coarse)` |

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
| Sunflower Brawler | **no `FitStage`** — the slot fills the panel, the canvas letterboxes itself (see below) | `TouchAnalogStick` (analog, so walk and plane-step can happen together) + two `TouchButton`s, ATTACK and MAGIC |
| Frogger | `FitStage`, `minScale` 0.38 | `TouchDPad`, **no down arrow** |
| Pac-Man | `FitStage`, `minScale` 0.51 | `TouchDPad` |
| Barley Breaker | `FitStage`, `minScale` 0.38 | `TouchMoveBar` + `Space` to launch |
| Goblin Invaders | `FitStage`, `minScale` 0.38 | `TouchMoveBar` + `Space` to fire |
| Tetris | `FitStage` on the **board only** — see below | four `TouchButton`s in a row |
| Go Fish, UNO, Solitaire, Poker, Blackjack | **no stage** — measured and patched | n/a (tap-driven) |

**Sunflower Brawler drops `FitStage`.** `FitStage` caps its scale at
`Math.min(1, …)`, so the stage could never render larger than its own backing
resolution in CSS pixels — on a 1100px-wide cabinet that left a stamp floating in
the middle of a mostly empty panel. The canvas also has no pointer handlers, so
the footprint `FitStage` reserves buys nothing here. Instead the slot is a
`flex-1 min-h-[180px]` div that takes whatever height is left under the HUD, and
the canvas fills it with `h-full w-full object-contain` plus
`image-rendering: pixelated`; the browser does the aspect-correct letterbox. On
desktop the stage fills the panel width, on a phone the slot
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
