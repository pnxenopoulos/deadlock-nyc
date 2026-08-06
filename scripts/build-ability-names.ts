// Build a compact internal-id -> in-game English ability name manifest.
//
// Inputs are copied into scripts/.vdata by sync-game-data.sh. Restricting the
// output to top-level abilities.vdata entries avoids shipping the full Valve
// localization catalog in the browser bundle.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { topLevelEntries } from "./lib/kv3";

const ROOT = resolve(import.meta.dir, "..");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : resolve(import.meta.dir, ".vdata");
const OUTPUT = resolve(ROOT, "src/data/ability-names.json");
const ABILITIES = resolve(VDATA_DIR, "abilities.vdata");
const LOCALIZATION = [
  resolve(VDATA_DIR, "citadel_heroes_english.txt"),
  resolve(VDATA_DIR, "citadel_gc_mod_names_english.txt"),
];

for (const input of [ABILITIES, ...LOCALIZATION]) {
  if (!existsSync(input)) {
    console.error(`Missing ${input}. Run: bun run sync`);
    process.exit(1);
  }
}

const localized = new Map<string, string>();
const pair = /^\s*"([^"]+)"\s+"([^"]*)"/;
for (const input of LOCALIZATION) {
  const text = await Bun.file(input).text();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(pair);
    if (match) localized.set(match[1], match[2]);
  }
}

const output: Record<string, string> = {};
const abilities = await Bun.file(ABILITIES).text();
for (const { name } of topLevelEntries(abilities)) {
  const displayName = localized.get(name);
  if (displayName) output[name] = displayName;
}

const sorted = Object.fromEntries(
  Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
);
await Bun.write(OUTPUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} localized ability names to ${OUTPUT}`);