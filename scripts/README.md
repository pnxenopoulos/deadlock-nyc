# Updating game data

deadlock-nyc renders game-derived item and ability icons, hero portraits,
competitive rank badges, and the player stat panel (modifiers). Each has a
different update path. After a Deadlock patch, work through the tiers below.

## What lives where

| Data | Source of truth | Refreshed by |
| --- | --- | --- |
| Hero **display names** | `boon` crate (`heroes.rs`) | bump `boon`, then `bun run wasm` |
| Item **icon paths** (name → `.png`) | `abilities.vdata` `m_strShopIconLarge` | `bun run sync` → `src/data/item-icons.json` |
| Item **display names** (name → "Extra Charge") | `citadel_gc_mod_names_english.txt` | `bun run sync` → `src/data/item-names.json` |
| Item **category + cost** (name → gun/vitality/spirit, souls) | `abilities.vdata` `m_eItemSlotType` + `m_iItemTier`; tier→cost is hardcoded in the script | `bun run sync` → `src/data/item-stats.json` |
| Hero **portrait paths** (id → `.webp`) | `heroes.vdata` `m_strIconImageSmall` | `bun run sync` → `src/data/hero-portraits.json` |
| Ability/item-active **icon paths** (name → `.webp`) | `abilities.vdata` `m_strAbilityImage` | `bun run sync` → `src/data/ability-icons.json` |
| Ability **display names** (internal id → in-game English) | `citadel_heroes_english.txt` + `citadel_gc_mod_names_english.txt` | `bun run sync` → `src/data/ability-names.json` |
| Competitive **rank badges** (packed rank → tier `.webp`) | `panorama/images/ranked/badges/rankXX_lg_psd.vtex_c` | `bun run images` → `public/ranks/` + `src/data/rank-icons.json` |
| Item / hero / ability / minimap **images** | game VPKs | Source 2 Viewer export → `panorama/`, then `bun run images` → `public/` |
| Modifier **stat-type ids** (`m_eValType`) | `EModifierValue` schema enum | `wasm/src/lib.rs` + `bun run check-modifiers` |

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

GameTracking ships scripts/vdata, not images or schema enums. These steps run
on a machine with Deadlock installed.

### Images

Export the panorama image tree with Source 2 Viewer at the **same game build**
you synced, into `panorama/images/` at the repo root (gitignored — it's the full
multi-MB dump). Source 2 Viewer names exports by source extension —
`inferno_sm.psd` → `inferno_sm_psd.png` — which is exactly the convention the
manifests encode, so matching builds line up automatically.

Then extract just what the app serves and optimize it:

```bash
bun run images          # panorama/images/ -> public/{items,heroes,minimap}/*.webp
bun run images --dry-run   # preview what would be written/pruned
```

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
the dumps behind them are left untouched. Needs `cwebp` (`brew install webp`).

Rank textures are compiled `.vtex_c` resources, so that part also needs the
ValveResourceFormat command-line tool as `Source2Viewer-CLI` on `PATH` (or set
`SOURCE2VIEWER_CLI=/path/to/Source2Viewer-CLI`). The script decompiles them to a
temporary PNG before WebP encoding. All six subdivisions share their tier's
badge: `rank06_lg_psd.vtex_c` becomes `public/ranks/06.webp`, and packed ranks
`61` through `66` all map to that URL in `src/data/rank-icons.json`.

### Modifiers (stat panel)

The stat-viewer ids (`31 → bonus_health`, …) are `EModifierValue` enum values,
absent from GameTracking and boon-proto. To verify them after a patch, dump the
`EModifierValue` enum (Source 2 Viewer schema export, or a source2gen dump) to
`scripts/.vdata/EModifierValue.txt`, then:

```bash
bun run check-modifiers
```

It reports whether each id in `wasm/src/lib.rs` still names the stat we expect,
and lists candidate ids if one moved. Fix the `match vt { … }` arms in
`wasm/src/lib.rs`, then `bun run wasm`.

## Tier 3 — parser name tables (the `boon` crate)

Hero names and the internal ability identifiers attached to demo events come
from `boon::hero_name` / `boon::ability_name`. Refresh them in the `boon` repo
(`scripts/sync-name-tables.sh`), publish, bump the version in `wasm/Cargo.toml`,
and run `bun run wasm`. User-facing English ability labels are refreshed
separately by `bun run sync` from Valve's localization files.

## Full post-patch checklist

1. `DEADLOCK_REF=<patch> bun run sync` — item, ability, and portrait manifests.
2. Re-export images at `<patch>`, retaining `panorama/images/ranked/badges/rankXX_lg_psd.vtex_c`, then `bun run images` (Deadlock machine).
3. Dump `EModifierValue` and `bun run check-modifiers` (Deadlock machine).
4. Bump `boon` if hero/ability names changed, then `bun run wasm`.
5. `bun run dev` and spot-check a recent demo.
