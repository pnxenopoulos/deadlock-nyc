// Reads heroes.vdata and maps each hero's numeric m_HeroID to a portrait URL:
//   hero 1  -> /heroes/inferno_sm_psd.png
//   hero 3  -> /heroes/hornet_sm_png.png
//
// The slug is read straight from the vdata's image reference rather than
// hardcoded, so it always matches assets re-extracted from the same game
// build. Prefer small portraits, then minimap, vertical, and card portraits.
// Development slots without any portrait use Valve's generic image.
//
// Input:  $VDATA_DIR/heroes.vdata, or cached installed-game definitions,
//         falling back to scripts/.vdata/heroes.vdata
// Output: src/data/hero-portraits.json
//
// Run via the sync script, or standalone: `bun run portraits`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { heroPortraitsFromVdata } from "./lib/hero-portraits";

const ROOT = resolve(import.meta.dir, "..");
const installedDirectory = resolve(ROOT, "scripts/.vdata/installed-game/scripts");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : existsSync(resolve(installedDirectory, "heroes.vdata"))
    ? installedDirectory
    : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/hero-portraits.json");

const INPUT = resolve(VDATA_DIR, "heroes.vdata");
if (!existsSync(INPUT)) {
  console.error(
    `heroes.vdata not found in ${VDATA_DIR}. Run scripts/sync-game-data.sh first.`,
  );
  process.exit(1);
}

const text = await Bun.file(INPUT).text();

// hero_id -> portrait URL. Keyed by string id to round-trip cleanly as JSON.
const out = heroPortraitsFromVdata(text);

// Emit sorted by numeric id for a stable, reviewable diff.
const sorted: Record<string, string> = {};
for (const k of Object.keys(out).sort((a, b) => Number(a) - Number(b))) {
  sorted[k] = out[k];
}

await Bun.write(OUTPUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} hero portraits -> ${OUTPUT} (from ${INPUT})`);
