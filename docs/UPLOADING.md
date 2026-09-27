# Uploading a build (hosted preview)

The preview lives at:

```
https://sunflower-land.com/play/#/economy/Nightshade-Arcade
```

## The whole flow

```bash
npm run build:hosted     # typecheck + build + upload preflight check
```

Then upload **one folder** in the site's upload dialog:

```
dist/
```

Reload the preview URL. Nothing else needs uploading.

## Why only `dist/`

| What you pick        | Entries   | Result |
| -------------------- | --------- | ------ |
| repo root            | ~350      | ✗ rejected — over the 300-per-batch cap |
| `dist/`              | ~36       | ✓ accepted |

The upload dialog has two hard rules:

1. **Max 300 entries per batch** — the repo is over that, `dist/` is not.
2. **One folder or file per selection** — so it must be a single folder, not a
   scatter of files. `dist/` *is* that folder.

## Filenames the CDN refuses

The host behind `*.economies.sunflower-land.com` returns **403** (not 404) for
any object key containing a space, so those files upload but never load. That
is what caused:

```
403  /world/Teeny%20Tiny%20Pixls5.png
[minigame] phaser_preloader_scene File load error {"name":"Teeny Tiny Pixls", ...}
```

`Teeny Tiny Pixls5.png` / `.xml` were renamed to `Teeny_Tiny_Pixls5.*`.
`npm run build:hosted` now fails if any output file has a space or non-ASCII
character in its name, so this cannot regress silently.

Check a build at any time:

```bash
npm run upload:check
```

## Scripted check

`scripts/checkUpload.mjs` verifies:

- `dist/` exists and is non-empty
- entry count ≤ 300
- no unsafe filenames
- `index.html` and `assets/` are present

Exit code `1` blocks the build.
