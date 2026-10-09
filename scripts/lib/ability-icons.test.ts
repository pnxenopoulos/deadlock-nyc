import { expect, test } from "bun:test";
import icons from "../../src/data/ability-icons.json";
import names from "../../src/data/ability-names.json";
import { checkWebpFiles } from "./check-webp-files";
import { resolve } from "node:path";

for (const [name, label, icon] of [
  ["ability_ratking_scrap_grenade", "Scrap Grenade", "ratking_grenade"],
  ["ability_ratking_ratnibble", "Rat Swarm", "ratking_swarm"],
  ["ability_ratking_ratarmor", "Royal Pestments", "ratking_shield"],
  ["ability_ratking_standard_bearer", "Rule, Ratannia!", "ratking_flag"],
]) {
  test(`Rat King's ${label} has its localized name and icon asset`, async () => {
    const url = `/hud/abilities/ratking/${icon}_psd.webp`;
    expect((icons as Record<string, string>)[name]).toBe(url);
    expect((names as Record<string, string>)[name]).toBe(label);
    await checkWebpFiles([url], resolve(import.meta.dir, "../../public"));
  });
}
