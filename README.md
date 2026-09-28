# The Nightshade Arcade

The Nightshade Arcade is a minigame hub where players earn **Raven** tokens and redeem them for prizes.

This repository starts from the economy-template and now includes:

- A branded base shell for **The Nightshade Arcade**
- A foundational minigame hub UI to browse games and view token balance
- A placeholder reward + prize redemption flow for economy iteration
- A migration queue scaffold for future game ports from `ispankzombiez/Sunflower-Land` (`portal` branch)

## Quick start

```bash
npm install
npm run dev
```

## Current foundation

- **App entry:** `src/App.tsx`
- **Arcade shell:** `src/features/arcade/NightshadeArcadeApp.tsx`
- **Hub config:** `src/features/arcade/data/hubConfig.ts`
- **Portal migration placeholders:** `src/features/arcade/portal/portingPlan.ts`
- **Arcade migration handoff (canonical):** `docs/arcade-migration-handoff.txt`

## Next migration step

Use `portalPortTargets` in `src/features/arcade/portal/portingPlan.ts` to track and prioritize imports from Sunflower-Land's `portal` branch as each minigame is moved into `src/features/arcade/games`.

## Hosted upload testing (Sunflower Land uploader)

For manual uploader testing at:

- `https://Nightshade-Arcade.economies.sunflower-land.com`

Use this flow:

1. Run `npm install`
2. Run `npm run build:hosted`
3. Upload the contents of `dist/` (not the project root)

## Hosted upload files from GitHub Actions

When CI runs on `NA-test`, it now creates two separate outputs:

- **GitHub Pages artifact** (for Pages deploy): built from `npm run build:pages`
- **`hosted-upload-dist` artifact** (for provider upload): built from `npm run build:hosted`

Download **`hosted-upload-dist`** from the workflow run artifacts.  
After extraction, upload the extracted folder contents directly to the provider so `index.html` stays at the top level with `assets/` alongside it.

Notes:

- `dist/index.html` is the required entry file at site root for the uploader.
- Hosted builds use root base `/`, so static paths resolve as `/assets`, `/game`, `/world`.
- The active app entry (`src/App.tsx`) does not use `BrowserRouter`; embedded game flows use in-memory routing where needed, avoiding deep-link refresh routing issues for hosted uploads.
- Runtime minigame session uses:
  - `?jwt=...` (required for authenticated live economy session)
  - `?minigamesApiUrl=...` (optional runtime override)
  - `VITE_MINIGAMES_API_URL` (build-time fallback when query param is absent)

## GitHub Pages preview build

Use this build target for GitHub Pages preview/testing:

```bash
npm run build:pages
```

- Pages builds use base `/economy-template/` so JS/CSS/assets and `/game` + `/world` files resolve under the repository subpath.
- The GitHub Pages workflow (`.github/workflows/deploy.yml`) runs `npm run build:pages` and deploys the `dist/` artifact.
