import { resolve } from "node:path";
import icons from "../src/data/ability-icons.json";
import { checkWebpFiles } from "./lib/check-webp-files";

await checkWebpFiles(Object.values(icons), resolve(import.meta.dir, "../public"));
console.log(`Checked all ${Object.keys(icons).length} ability icon mappings.`);
