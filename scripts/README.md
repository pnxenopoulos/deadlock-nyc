# Updating game data

deadlock-nyc renders game-derived item and ability icons, hero portraits,
competitive rank badges, and the player stat panel.

## One-command refresh

On the WSL development machine, run:

```bash
bun run refresh
```

This pulls the latest GameTracking data, embeds the matching Boon catalogs,
extracts only referenced images plus the property-icon set from the installed
Windows game, optimizes them, rebuilds the Boon WASM module, and verifies the
production build. It auto-detects the current local paths:

- Source 2 Viewer: `../cli-linux-x64/Source2Viewer-CLI`
- Deadlock: Windows Steam libraries mounted under `/mnt/<drive>/`

Override either with `SOURCE2VIEWER_CLI=/path/to/Source2Viewer-CLI` or
`DEADLOCK_VPK=/path/to/pak01_dir.vpk`. Set `SOURCE2VIEWER_THREADS` to change
the extraction concurrency.

## What lives where

| Data | Source of truth | Refreshed by |
| --- | --- | --- |
| Demo names, calculated stats, imbues, and player-state names | versioned `boon-data` catalogs | `boon get <version>`, then `bun run catalog` |
| Stat and status **icons** | Deadlock `panorama/images/icons/properties/` | `bun run extract-images` → `bun run property-icons` (also included in `bun run images`) |
| Item **icon paths** (name → `.png`) | `abilities.vdata` `m_strShopIconLarge` | `bun run sync` → `src/data/item-icons.json` |
| Item **display names** (name → "Extra Charge") | `citadel_gc_mod_names_english.txt` | `bun run sync` → `src/data/item-names.json` |
| Item **category + cost** (name → gun/vitality/spirit, souls) | `abilities.vdata` `m_eItemSlotType` + `m_iItemTier`; tier→cost is hardcoded in the script | `bun run sync` → `src/data/item-stats.json` |
| Hero **portrait paths** (id → `.webp`) | installed `heroes.vdata`, preferring small portraits with minimap/vertical/card fallbacks | `bun run extract-images` → `src/data/hero-portraits.json` (`bun run sync` also generates an initial manifest) |
| Ability/item-active **icon paths** (name → `.webp`) | installed `abilities.vdata` `m_strAbilityImage` | `bun run extract-images` → `src/data/ability-icons.json` (`bun run sync` also generates an initial manifest) |
| Ability **display names** (internal id → in-game English) | installed `citadel_heroes_english.txt` + `citadel_gc_mod_names_english.txt` | `bun run extract-images` → `src/data/ability-names.json` (`bun run sync` also generates an initial manifest) |
| Competitive **rank badges** (packed rank → tier `.webp`) | `panorama/images/ranked/badges/rankXX_lg_psd.vtex_c` | `bun run images` → `public/ranks/` + `src/data/rank-icons.json` |
| Item / hero / ability / minimap **images** | game VPKs | `bun run extract-images`, then `bun run images` → `public/` |

## Tier 1 — pull from GameTracking (runs anywhere)

```bash
bun run sync                         # latest GameTracking-Deadlock
DEADLOCK_REF=<branch|tag|commit> bun run sync   # pinned (recommended)
```

This sparse-clones `SteamTracking/GameTracking-Deadlock`, drops `abilities.vdata`,
`heroes.vdata`, and the English item/hero localization files into
`scripts/.vdata/` (gitignored), and regenerates `src/data/item-icons.json`,
`src/data/item-names.json`, `src/data/item-stats.json`,
`src/data/hero-portraits.json`, `src/data/ability-icons.json`, and
`src/data/ability-names.json`. Item and ability names come from localization (not
slugs), so tooltips use the labels shown in game.

**Pin `DEADLOCK_REF`** to the build your images were extracted from and that
matches your `boon-proto` version — otherwise the generated slugs (e.g.
`hornet_sm`) can drift ahead of the PNGs you actually have on disk.

You can re-run a single generator without re-cloning:
`bun run items` / `bun run item-names` / `bun run item-stats` /
`bun run portraits` / `bun run ability-icons` / `bun run ability-names` (they
read `scripts/.vdata/`).

> **Note:** item soul costs are not in any game file we sync — `build-item-stats.ts`
> derives them from each item's tier via a hardcoded `TIER_COST` table
> (800 / 1600 / 3200 / 6400 / 6400). Re-verify those after a shop economy patch.

## Tier 2 — needs the Deadlock machine + Source 2 Viewer

GameTracking does not ship images. These steps run on a machine with Deadlock
installed and require Source 2 Viewer plus `cwebp` (Ubuntu:
`sudo apt install webp`; macOS: `brew install webp`).

### Images

`extract-game-images.ts` reads the generated manifests and asks Source 2
Viewer for only the referenced textures. On WSL it reads the Windows VPK
directly through `/mnt/<drive>/`; no game copy or Windows CLI is needed. It
writes decompiled PNGs to the gitignored `panorama/images/` tree and retains
compiled rank textures for the rank pipeline. It first refreshes hero and
ability definitions from that same VPK plus the installation's loose English
localization files, so GameTracking lag cannot omit new heroes or abilities.
Vertical portraits are cropped to square icons; development slots without
portraits use Valve's generic image. The portrait, ability-icon, and
ability-name generators reuse installed definitions when available, unless
`VDATA_DIR` is set explicitly.

```bash
bun run extract-images
bun run images --dry-run
bun run images
bun run check-portraits
bun run check-ability-icons
```

The production build also checks every Boon catalog hero has a mapping and
every mapped hero/ability WebP exists. Missing hero or ability source images
fail the image build instead of silently leaving broken icons.

To refresh only hero portraits without touching item or ability images:

```bash
bun run extract-images --heroes-only
bun run images --heroes-only
```

For ability icons and their English names only:

```bash
bun run extract-images --abilities-only
bun run images --abilities-only
```

For the surface and tunnels map images only:

```bash
bun run extract-images --minimap-only
bun run images --minimap-only
```

Map paths are shared by the viewer and both scripts in
`src/data/minimap-images.json`. Scoped refreshes do not prune files used by
other manifests.

`bun run extract-images` and `bun run images` are the image-only workflow.
`bun run refresh` also refreshes manifests, WASM, and the production build.

`build-images.ts` reads the set the app references (the `item-icons.json`,
`hero-portraits.json`, and `ability-icons.json` values plus the two minimap
layers), discovers `rankXX_lg_psd.vtex_c` under `ranked/badges/`, pulls only
those files out of the dump, downscales each to display resolution, and writes
a `.webp` into the matching `public/` subdir (item icons
~23KB PNG → ~1.5KB WebP). In every directory it writes into it prunes files it
didn't produce, so the shipped tree (`public/{items,heroes,minimap,hud,upgrades,ranks}`,
~2.7 MB total) holds exactly the referenced set — that's what gets committed and
deployed; hand-authored files outside those dirs (`public/hud/golden_idol.png`,
`public/teams/*.svg`) are never touched. The first run also replaces the legacy
whole-dump symlinks (`public/items -> deadlock-images/…`) with real directories;
the dumps behind them are left untouched.

Rank textures are compiled `.vtex_c` resources, so that part also needs the
ValveResourceFormat command-line tool as `Source2Viewer-CLI` on `PATH` (or set
`SOURCE2VIEWER_CLI=/path/to/Source2Viewer-CLI`). The script decompiles them to a
temporary PNG before WebP encoding. All six subdivisions share their tier's
badge: `rank06_lg_psd.vtex_c` becomes `public/ranks/06.webp`, and packed ranks
`61` through `66` all map to that URL in `src/data/rank-icons.json`.

## Tier 3 — Boon parser catalogs

Boon 0.16 resolves demo IDs and calculates current hero/ability stats, imbues,
and player states from versioned `boon-data` JSON catalogs. The browser cannot
read Boon's normal filesystem cache, so deadlock.nyc generates its compact
name lookup and copies the matching catalogs into `public/boon-data/` for the
replay worker. Replay modifiers need the same catalog
lifetime rules as stat queries:

```bash
boon get 6759       # current bundled snapshot; only needed if not installed
boon get 6746       # matching snapshot for the regression demo
BOON_CLIENT_VERSION=6759 bun run catalog  # keep the bundled snapshot
bun run wasm
```

The generator reads `~/.boon/<version>/` by default. Set `BOON_DATA_DIR` to a
different cache root or `BOON_CLIENT_VERSION` to override the version. It uses
the `boon-proto` build number in `wasm/Cargo.lock` by default and rejects mixed
catalog snapshots. `bun run refresh` runs the catalog step automatically.
User-facing English ability labels remain separate and come from Valve's
localization via `bun run sync`.

`bun run catalog` also generates `src/data/hero-names.json` for stat-breakdown
source labels and `src/data/ability-id-names.json` for ID-based imbue icons.
Display-only modifier exclusions live in `IGNORED_MODIFIERS` in
`src/lib/modifier-rows.ts`; these suppress effect rows and known missing-definition
warnings, without changing raw replay data, stat totals, or Boon's partial status.

The browser adapter uses the published `boon-deadlock` crate. Catalog-byte
loading, stat-tagged contributions, single-pass stat batches, and replay
checkpoints are upstream APIs; no local Boon checkout is needed.

## Full post-patch checklist

1. Update `boon-deadlock` and `boon-proto` in `wasm/Cargo.toml`, then refresh
   `wasm/Cargo.lock` with `cargo update --manifest-path wasm/Cargo.toml`.
2. Install the matching catalog with `boon get <client-version>`.
3. Run `bun run refresh`.
4. Review `git diff`, especially item tier costs after economy changes.
5. Run `bun run dev` and spot-check a recent demo.
