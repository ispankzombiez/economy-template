# VALIDATION.md

> **Audience:** Humans shipping a fork of this template. **Not** automated CI (unless you add it later).

## Agent summary

Before calling a mini-game **shippable**, a human must manually confirm the checklist below. Agents should not claim “done” without pointing a maintainer at this list.

## Pre-ship checklist (manual)

### Playability

- [ ] Game **loads** without console errors in a clean browser profile.
- [ ] **First session** can be played **end-to-end** (see `GAME_SPEC.md` win condition).
- [ ] **Anonymous** user can complete at least one core loop (if applicable).

### Win / lose / retry

- [ ] **Win state** is visible (screen or popup) and matches `GAME_SPEC.md`.
- [ ] **Lose state** is visible when fail condition triggers.
- [ ] **Retry** path exists and resets the correct state (per spec — lives, level, inventory).

### Economy & persistence (if implemented)

- [ ] **Coins** (or primary currency) update in UI when earned/spent.
- [ ] **API** errors show a safe message (no stack traces to players).

### Free reward runs (every cabinet)

The rule is **one free run per cabinet for VIP, one for the whole arcade otherwise**.
It is enforced by published economy data, not by code, so a cabinet that has not
been published is a cabinet that does not honour it.

- [ ] `npm run freerun:audit` exits **0**. It reports every cabinet's four ids and
      prints the JSON to paste for anything missing.
- [ ] A new cabinet's ids were generated, not hand-typed:
      `npm run freerun:add -- <exported-economy.json>`. It derives the ids from
      `GAME_REGISTRY`, clones the shape of a cabinet that already works in your
      economy, picks the next free item id, and refuses to touch a cabinet that is
      already published or only half-published.
- [ ] **VIP** gets one free run on *every* cabinet, including the newest one, and a
      refresh does not hand it back.
- [ ] **Non-VIP** gets exactly **one** free run across the whole arcade — spending it
      on any cabinet closes the others.
- [ ] A cabinet that is **half** published charges a Play Ticket rather than paying
      out, and the dev console names the missing id. (Half-published is the normal
      state while wiring a new machine; see `GAME_SPEC.md`,
      *Free runs: one coherent decision, not three lookups*.)

### UI / mobile

- [ ] **Primary action** reachable on a **narrow** viewport without horizontal scroll.
- [ ] Popups **dismiss** reliably; only **one** popup at a time (template constraint).

### Content & tone

- [ ] Copy is **PG** and **brief** (`DESIGN.md`).
- [ ] No placeholder **TODO** left in user-visible strings.

### Art (Phaser)

- [ ] World tiles and pickups use **`@sl-assets`** via **`icons.config.ts` / `resources.config.ts`** (see **`src/examples/pacman/pacman.config.ts`** if you ship that example), not ad-hoc URLs or `Graphics`-drawn stand-ins.
- [ ] Bumpkin roles use **`BumpkinContainer`** (animation CDN + silhouette), not primitive shapes.
  - *Arcade cabinets are the documented exception.* **Sunflower Brawler** draws its fighters straight from the animation CDN (`animations.sunflower-land.com`, via `npcSheetUrl` in `fighters.ts`) and its stage from the committed `nightshade-arcade-tilesheet.png`, because a side-scroller needs the raw frame sheets rather than a silhouetted container. Its boss, Gorga, is an `NPC_WEARABLES` entry like every other fighter, so it comes from the same CDN vocabulary — there is no bespoke boss art file. The rule it still has to honour is the *spirit* of the line: real character art, never primitive-shape stand-ins.
  - **A missing animation cycle must never draw the placeholder body.** This is
    its own line because it is the failure that actually shipped: seven NPCs
    flashed a coloured square for the length of every attack, because their moves
    named cycles (`hammering`, `casting`, `mining`) that the preload list never
    asked for. A missing cycle is invisible in review — it throws nothing, it just
    swaps a character's art for a flat rectangle until the animation ends, which
    reads as an intermittent visual glitch rather than a preload bug.
    - [ ] Changing a move? Its `anim` lands in that NPC's **derived** set
          (`enemyAnimsFor(npc)`), which is computed from the moves, so it is
          automatic. Hand-writing a preload list instead reintroduces the bug.
    - [ ] Dev console on load warns by name if anything asks for a cycle that will
          not be loaded: `[brawler] "wizard" needs the "casting" cycle…`
    - [ ] A *missing cycle* falls back to the character's own `walking`, then
          `idle` — a stiff pose, briefly. The coloured body is reserved for a
          character with **no** usable sheet at all, i.e. the CDN still loading.
          So a coloured box on screen now means a preload or CDN problem and
          nothing else.

### Performance (smoke)

- [ ] No obvious **memory** growth over 10 minutes of casual play (subjective check).

## Related docs

- `GAME_SPEC.md` — what “win” and “retry” mean for your game.
- `UI_UX_GUIDELINES.md` — win/lose presentation.
