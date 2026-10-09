// Reads abilities.vdata, walks each top-level entry, and pulls
// `m_strAbilityImage` out, mapping each ability name to the icon URL the public
// tree serves: `hud/abilities/astro/gravity_lasso.psd` ->
// `/hud/abilities/astro/gravity_lasso_psd.webp` (the optimized WebP that
// scripts/build-images.ts writes from the panorama PNG).
//
// This is the ability-feed counterpart to build-item-manifest.ts: that one maps
// purchasable upgrades via m_strShopIconLarge; this one maps the ability/item
// *usage* icons the ImportantAbilityUsed feed shows, which live under
// hud/abilities/ (hero abilities) and upgrades/ (item actives). Keyed by the
// same entry name the message's ability_name carries (citadel_ability_*,
// ability_*), so the feed can look up an icon directly.
//
// Input:  $VDATA_DIR/abilities.vdata, cached installed-game definitions, or
//         scripts/.vdata (falling back to the repo-root copy).
// Output: src/data/ability-icons.json
//
// Run via the sync script, or standalone: `bun run ability-icons`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { topLevelEntries, field, imageUrlFromPanorama } from "./lib/kv3";

const ROOT = resolve(import.meta.dir, "..");
const installedDirectory = resolve(ROOT, "scripts/.vdata/installed-game/scripts");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : existsSync(resolve(installedDirectory, "abilities.vdata"))
    ? installedDirectory
    : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/ability-icons.json");

const synced = resolve(VDATA_DIR, "abilities.vdata");
const INPUT = existsSync(synced) ? synced : resolve(ROOT, "abilities.vdata");

if (!existsSync(INPUT)) {
  console.error(
    `abilities.vdata not found. Run scripts/sync-game-data.sh first ` +
      `(looked in ${VDATA_DIR} and the repo root).`,
  );
  process.exit(1);
}

const text = await Bun.file(INPUT).text();

const out: Record<string, string> = {};
let count = 0;
for (const { name, body } of topLevelEntries(text)) {
  const icon = field(body, "m_strAbilityImage");
  if (!icon) continue;
  const url = imageUrlFromPanorama(icon);
  if (!url) continue;
  // Skip vector sources cwebp can't rasterize (a handful of generic HUD glyphs);
  // build-images would only warn and skip them anyway.
  if (url.endsWith("_svg.webp")) continue;
  out[name] = url;
  count++;
}

// Emit sorted by key for a stable, reviewable diff.
const sorted: Record<string, string> = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];

await Bun.write(OUTPUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${count} ability icons -> ${OUTPUT} (from ${INPUT})`);
