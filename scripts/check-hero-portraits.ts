import { resolve } from "node:path";
import version from "../src/data/boon-version.json";
import portraits from "../src/data/hero-portraits.json";
import { checkWebpFiles } from "./lib/check-webp-files";

const root = resolve(import.meta.dir, "..");
const catalog = await Bun.file(resolve(root, "public/boon-data", version.client_version, "heroes.json")).json() as {
  records: { hero_id: number | null; hero_name: string }[];
};
const urls = portraits as Record<string, string>;
const missing = catalog.records
  .filter((hero) => hero.hero_id !== null && hero.hero_id > 0 && !urls[String(hero.hero_id)])
  .map((hero) => `${hero.hero_name} (${hero.hero_id})`);
if (missing.length) throw new Error(`Missing hero portrait mappings: ${missing.join(", ")}`);

await checkWebpFiles(Object.values(urls), resolve(root, "public"));
console.log(`Checked ${Object.keys(urls).length} hero mappings and all portrait files.`);
