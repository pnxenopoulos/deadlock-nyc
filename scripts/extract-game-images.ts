// Extract only the compiled Deadlock textures referenced by the generated
// manifests, then decompile them into panorama/images/ for build-images.ts.

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findSource2ViewerCli, source2ViewerEnv } from "./source2viewer";
import minimapImages from "../src/data/minimap-images.json";

const ROOT = resolve(import.meta.dir, "..");
const HEROES_ONLY = process.argv.includes("--heroes-only");
const ABILITIES_ONLY = process.argv.includes("--abilities-only");
const MINIMAP_ONLY = process.argv.includes("--minimap-only");
const MANIFESTS = [
  "src/data/item-icons.json",
  "src/data/hero-portraits.json",
  "src/data/ability-icons.json",
];
const MINIMAP_SOURCES = Object.values(minimapImages).map((layer) => layer.sourceRel);
const RANK_FILTER = "panorama/images/ranked/badges/";
const PROPERTY_ICON_FILTER = "panorama/images/icons/properties/";

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function findDeadlockVpk(): string | null {
  if (process.env.DEADLOCK_VPK) {
    const configured = resolve(process.env.DEADLOCK_VPK);
    if (!existsSync(configured)) die(`DEADLOCK_VPK does not exist: ${configured}`);
    return configured;
  }

  const candidates = [
    join(homedir(), ".steam/steam/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk"),
  ];

  if (existsSync("/mnt")) {
    for (const entry of readdirSync("/mnt", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z]$/i.test(entry.name)) continue;
      const drive = join("/mnt", entry.name);
      candidates.push(
        join(drive, "Program Files (x86)/Steam/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk"),
        join(drive, "Program Files/Steam/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk"),
        join(drive, "SteamLibrary/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk"),
        join(drive, "Steam/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk"),
      );
    }
  }

  return candidates.find(existsSync) ?? null;
}

function referencedResources(): string[] {
  const resources = new Set<string>();
  for (const manifest of MANIFESTS) {
    if (MINIMAP_ONLY) continue;
    if (HEROES_ONLY && manifest !== "src/data/hero-portraits.json") continue;
    if (ABILITIES_ONLY && manifest !== "src/data/ability-icons.json") continue;
    const path = resolve(ROOT, manifest);
    if (!existsSync(path)) die(`manifest not found: ${path} (run \`bun run sync\` first)`);
    const urls = Object.values(
      JSON.parse(readFileSync(path, "utf8")) as Record<string, string>,
    );
    for (const url of urls) {
      resources.add(`panorama/images/${url.replace(/^\//, "").replace(/\.webp$/, ".vtex_c")}`);
    }
  }
  for (const source of HEROES_ONLY || ABILITIES_ONLY ? [] : MINIMAP_SOURCES) {
    resources.add(`panorama/images/${source.replace(/\.png$/, ".vtex_c")}`);
  }
  return [...resources].sort();
}

async function run(cli: string, args: string[], label: string) {
  console.log(label);
  const child = Bun.spawn([cli, ...args], {
    cwd: ROOT,
    env: source2ViewerEnv(cli),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    die(`Source 2 Viewer exited with code ${code}\n${stderr.trim() || stdout.trim()}`);
  }
}

async function refreshDefinitions(cli: string, vpk: string) {
  // Generate mappings from the same installation as the textures instead of
  // silently omitting new heroes/abilities when GameTracking's cache is stale.
  const installedDirectory = resolve(ROOT, "scripts/.vdata/installed-game");
  const definitions = [
    ...(!ABILITIES_ONLY ? ["scripts/heroes.vdata_c"] : []),
    ...(!HEROES_ONLY ? ["scripts/abilities.vdata_c"] : []),
  ];
  await run(
    cli,
    ["-i", vpk, "-o", installedDirectory, "-d", "-f", definitions.join(",")],
    "Refreshing image definitions from the installed game...",
  );
  const cachedScripts = join(installedDirectory, "scripts");
  if (!HEROES_ONLY) {
    // Localization is shipped as loose files alongside the VPK.
    for (const name of ["citadel_heroes", "citadel_gc_mod_names"]) {
      const file = `${name}_english.txt`;
      const source = join(dirname(vpk), "resource/localization", name, file);
      if (!existsSync(source)) die(`English ability localization not found: ${source}`);
      copyFileSync(source, join(cachedScripts, file));
    }
  }
  const generators = [
    ...(!ABILITIES_ONLY ? ["build-hero-portraits"] : []),
    ...(!HEROES_ONLY ? ["build-ability-icons", "build-ability-names"] : []),
  ];
  for (const name of generators) {
    const generator = Bun.spawn([process.execPath, "run", `scripts/${name}.ts`], {
      cwd: ROOT,
      env: { ...process.env, VDATA_DIR: cachedScripts },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await generator.exited) !== 0) die(`${name} failed`);
  }
}

async function main() {
  if ([HEROES_ONLY, ABILITIES_ONLY, MINIMAP_ONLY].filter(Boolean).length > 1) {
    die("Choose only one of --heroes-only, --abilities-only or --minimap-only");
  }
  const cli = findSource2ViewerCli(ROOT);
  if (!cli) {
    die("Source2Viewer-CLI not found; set SOURCE2VIEWER_CLI to its executable path");
  }
  const vpk = findDeadlockVpk();
  if (!vpk) {
    die("Deadlock pak01_dir.vpk not found; set DEADLOCK_VPK to its path");
  }

  const requestedThreads = Number(process.env.SOURCE2VIEWER_THREADS);
  const threads = Number.isInteger(requestedThreads) && requestedThreads > 0
    ? requestedThreads
    : Math.min(8, availableParallelism());
  console.log(`Source 2 Viewer: ${cli}`);
  console.log(`Deadlock VPK: ${vpk}`);

  if (!MINIMAP_ONLY) await refreshDefinitions(cli, vpk);

  const resources = referencedResources();
  console.log(`Extracting ${resources.length} referenced textures with ${threads} threads...`);

  await run(
    cli,
    [
      "-i", vpk,
      "-o", ROOT,
      "-d",
      "-e", "vtex_c",
      "-f", resources.join(","),
      "--threads", String(threads),
    ],
    "Decompiling referenced textures...",
  );

  if (HEROES_ONLY || ABILITIES_ONLY || MINIMAP_ONLY) {
    console.log("Done. Extracted images into panorama/images/.");
    return;
  }

  // build-images.ts decompiles rank textures on demand, so preserve these as
  // their original compiled resources instead of exporting them as PNG only.
  await run(
    cli,
    ["-i", vpk, "-o", ROOT, "-e", "vtex_c", "-f", RANK_FILTER],
    "Extracting compiled rank badges...",
  );

  await run(
    cli,
    [
      "-i", vpk,
      "-o", ROOT,
      "-d",
      "-e", "vsvg_c",
      "-f", PROPERTY_ICON_FILTER,
      "--threads", String(threads),
    ],
    "Decompiling stat property icons...",
  );

  console.log("Done. Extracted game images into panorama/images/.");
}

await main();
