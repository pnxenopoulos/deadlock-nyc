// Extract only the compiled Deadlock textures referenced by the generated
// manifests, then decompile them into panorama/images/ for build-images.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { findSource2ViewerCli, source2ViewerEnv } from "./source2viewer";

const ROOT = resolve(import.meta.dir, "..");
const MANIFESTS = [
  "src/data/item-icons.json",
  "src/data/hero-portraits.json",
  "src/data/ability-icons.json",
];
const MINIMAP_SOURCES = [
  "minimap/base/minimap_midtown_mid_psd_dd4bcbf9.png",
  "minimap/base/minimap_midtown_mid_tunnels_psd.png",
];
const RANK_FILTER = "panorama/images/ranked/badges/";

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
    const path = resolve(ROOT, manifest);
    if (!existsSync(path)) die(`manifest not found: ${path} (run \`bun run sync\` first)`);
    const urls = Object.values(
      JSON.parse(readFileSync(path, "utf8")) as Record<string, string>,
    );
    for (const url of urls) {
      resources.add(`panorama/images/${url.replace(/^\//, "").replace(/\.webp$/, ".vtex_c")}`);
    }
  }
  for (const source of MINIMAP_SOURCES) {
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

async function main() {
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
  const resources = referencedResources();

  console.log(`Source 2 Viewer: ${cli}`);
  console.log(`Deadlock VPK: ${vpk}`);
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
    "Decompiling referenced item, hero, ability, and minimap textures...",
  );

  // build-images.ts decompiles rank textures on demand, so preserve these as
  // their original compiled resources instead of exporting them as PNG only.
  await run(
    cli,
    ["-i", vpk, "-o", ROOT, "-e", "vtex_c", "-f", RANK_FILTER],
    "Extracting compiled rank badges...",
  );

  console.log("Done. Extracted game images into panorama/images/.");
}

await main();
