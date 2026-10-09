import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Catalog<T> = {
  catalog: string;
  client_version: string;
  source_commit: string;
  records: T[];
};

type Hero = {
  hero_id: number | null;
  hero_name: string;
  display_name: string | null;
};

type Ability = {
  ability_id: number;
  ability_name: string;
  display_name: string | null;
};

type Modifier = {
  modifier_id: number;
  modifier_name: string;
  qualified_modifier_id: number;
  qualified_modifier_name: string;
};

type Misc = {
  misc_id: number;
  misc_name: string;
  definition: { _class?: string };
};

const root = resolve(import.meta.dir, "..");
const lockText = await Bun.file(resolve(root, "wasm/Cargo.lock")).text();
const lockedVersion = lockText.match(
  /\[\[package\]\]\s+name = "boon-proto"\s+version = "[^"]+\+(\d+)"/,
)?.[1];

if (!lockedVersion) {
  throw new Error(
    "could not find the boon-proto client version in wasm/Cargo.lock",
  );
}

const requestedVersion = process.env.BOON_CLIENT_VERSION ?? lockedVersion;
if (!/^\d+$/.test(requestedVersion)) {
  throw new Error("BOON_CLIENT_VERSION must be numeric");
}
const cacheRoot = resolve(
  process.env.BOON_DATA_DIR ?? join(homedir(), ".boon"),
);

async function readCatalog<T>(name: string, version = requestedVersion): Promise<Catalog<T>> {
  const path = join(cacheRoot, version, `${name}.json`);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `missing ${path}; install it with \`boon get ${version}\``,
    );
  }
  const catalog = (await file.json()) as Catalog<T>;
  if (catalog.catalog !== name) {
    throw new Error(`expected ${name} catalog, found ${catalog.catalog}`);
  }
  if (catalog.client_version !== version) throw new Error(`expected client ${version} in ${path}`);
  return catalog;
}

function insert(map: Map<number, string>, id: number, name: string): void {
  const existing = map.get(id);
  if (existing !== undefined && existing !== name) {
    throw new Error(
      `conflicting catalog names for ${id}: ${existing} and ${name}`,
    );
  }
  map.set(id, name);
}

function insertName(
  map: Map<string, string>,
  key: string,
  name: string,
): void {
  const existing = map.get(key);
  if (existing !== undefined && existing !== name) {
    throw new Error(
      `conflicting catalog names for ${key}: ${existing} and ${name}`,
    );
  }
  map.set(key, name);
}

function sortedObject(map: Map<number, string>): Record<string, string> {
  return Object.fromEntries(
    [...map]
      .sort(([left], [right]) => left - right)
      .map(([id, name]) => [String(id), name]),
  );
}

const [heroesCatalog, abilitiesCatalog, modifiersCatalog, miscCatalog] =
  await Promise.all([
    readCatalog<Hero>("heroes"),
    readCatalog<Ability>("abilities"),
    readCatalog<Modifier>("modifiers"),
    readCatalog<Misc>("misc"),
  ]);

const catalogs = [
  heroesCatalog,
  abilitiesCatalog,
  modifiersCatalog,
  miscCatalog,
];
const snapshot = catalogs[0];
// Keep the regression demo's original definitions as well as the latest snapshot.
const supportedVersions = [...new Set([snapshot.client_version, "6746"])];
if (
  catalogs.some(
    (catalog) =>
      catalog.client_version !== snapshot.client_version ||
      catalog.source_commit !== snapshot.source_commit,
  )
) {
  throw new Error("Boon name catalogs belong to different snapshots");
}

const heroes = new Map<number, string>();
const heroDisplayNames = new Map<string, string>();
const abilities = new Map<number, string>();
const modifiers = new Map<number, string>();
const breakables = new Map<number, string>();
const abilityDisplayNames = new Map<string, string>();

for (const hero of heroesCatalog.records) {
  heroDisplayNames.set(hero.hero_name, hero.display_name || hero.hero_name);
  if (hero.hero_id !== null) {
    insert(heroes, hero.hero_id, hero.display_name || hero.hero_name);
  }
}
for (const ability of abilitiesCatalog.records) {
  insert(abilities, ability.ability_id, ability.ability_name);
  if (ability.display_name) {
    insertName(abilityDisplayNames, ability.ability_name, ability.display_name);
  }
}
for (const modifier of modifiersCatalog.records) {
  insert(modifiers, modifier.modifier_id, modifier.modifier_name);
  insert(
    modifiers,
    modifier.qualified_modifier_id,
    modifier.qualified_modifier_name,
  );
}
for (const entry of miscCatalog.records) {
  if (entry.definition._class === "citadel_breakable_prop") {
    insert(breakables, entry.misc_id, entry.misc_name);
  }
}

const output = {
  client_version: snapshot.client_version,
  source_commit: snapshot.source_commit,
  heroes: sortedObject(heroes),
  abilities: sortedObject(abilities),
  ability_display_names: Object.fromEntries(
    [...abilityDisplayNames].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ),
  modifiers: sortedObject(modifiers),
  breakables: sortedObject(breakables),
};

const outputPath = resolve(root, "wasm/catalog-names.json");
await Bun.write(outputPath, `${JSON.stringify(output)}\n`);

const versionPath = resolve(root, "src/data/boon-version.json");
await Bun.write(
  versionPath,
  `${JSON.stringify({
    client_version: snapshot.client_version,
    source_commit: snapshot.source_commit,
    supported_versions: supportedVersions,
  }, null, 2)}\n`,
);

await Bun.write(
  resolve(root, "src/data/hero-names.json"),
  `${JSON.stringify(Object.fromEntries([...heroDisplayNames].sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`,
);

await Bun.write(
  resolve(root, "src/data/ability-id-names.json"),
  `${JSON.stringify(sortedObject(abilities), null, 2)}\n`,
);

// The browser has no filesystem API, so serve the matching boon-data snapshot
// as static assets for replay lifetimes and on-demand player-detail stats.
for (const version of supportedVersions) {
  const names = ["heroes", "abilities", "modifiers", "misc"];
  const files = await Promise.all(names.map((name) => readCatalog<unknown>(name, version)));
  if (files.some((file) => file.source_commit !== files[0].source_commit)) {
    throw new Error(`Boon client ${version} catalogs belong to different snapshots`);
  }
  const directory = resolve(root, "public/boon-data", version);
  mkdirSync(directory, { recursive: true });
  for (const name of names) copyFileSync(join(cacheRoot, version, `${name}.json`), join(directory, `${name}.json`));
}
console.log(
  `Wrote Boon client ${snapshot.client_version} metadata and browser catalogs ` +
    `(${heroes.size} heroes, ${abilities.size} abilities, ${modifiers.size} modifiers, ${breakables.size} breakables).`,
);
