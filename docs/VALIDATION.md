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

### UI / mobile

- [ ] **Primary action** reachable on a **narrow** viewport without horizontal scroll.
- [ ] Popups **dismiss** reliably; only **one** popup at a time (template constraint).

### Content & tone

- [ ] Copy is **PG** and **brief** (`DESIGN.md`).
- [ ] No placeholder **TODO** left in user-visible strings.

### Art (Phaser)

- [ ] World tiles and pickups use **`@sl-assets`** via **`icons.config.ts` / `resources.config.ts`** (see **`src/examples/pacman/pacman.config.ts`** if you ship that example), not ad-hoc URLs or `Graphics`-drawn stand-ins.
- [ ] Bumpkin roles use **`BumpkinContainer`** (animation CDN + silhouette), not primitive shapes.
  - *Arcade cabinets are the documented exception.* **Sunflower Brawler** draws its fighters straight from the animation CDN (`animations.sunflower-land.com`, via `npcSheetUrl` in `fighters.ts`) and its stage from the committed `nightshade-arcade-tilesheet.png`, because a side-scroller needs the raw frame sheets rather than a silhouetted container. Its boss uses `src/features/arcade/assets/big_goblin.png`, committed art copied in from Sunflower Land's `RetreatScene`. The rule it still has to honour is the *spirit* of the line: real character art, never primitive-shape stand-ins — `renderMatch` does fall back to a coloured body for an actor whose sheet has not arrived, but that is a load-time degrade, not the shipped look.

### Performance (smoke)

- [ ] No obvious **memory** growth over 10 minutes of casual play (subjective check).

## Related docs

- `GAME_SPEC.md` — what “win” and “retry” mean for your game.
- `UI_UX_GUIDELINES.md` — win/lose presentation.
