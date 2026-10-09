import { expect, spyOn, test } from "bun:test";
import { boonCatalogBase, loadBoonCatalog, selectBoonCatalog } from "../../src/wasm/catalog";
import version from "../../src/data/boon-version.json";

test("catalog URLs respect root and sub-path deployments", () => {
  expect(boonCatalogBase("https://deadlock.nyc/")).toBe(
    `https://deadlock.nyc/boon-data/${version.client_version}/`,
  );
  expect(boonCatalogBase("https://example.com/deadlock-nyc/")).toBe(
    `https://example.com/deadlock-nyc/boon-data/${version.client_version}/`,
  );
});

test("selects a bundled matching catalog rather than decoding old enum IDs with the latest build", () => {
  expect(selectBoonCatalog({ game_directory: "/opt/srcds/deadlock/citadel_v6746/citadel" })).toEqual({ version: "6746", demoVersion: "6746" });
  expect(selectBoonCatalog({ game_directory: "C:\\Deadlock\\citadel_v6759\\citadel" }).version).toBe("6759");
  expect(selectBoonCatalog({ game_directory: "/citadel_v9999/citadel" })).toEqual({ version: version.client_version, demoVersion: "9999" });
  expect(selectBoonCatalog(null).version).toBe(version.client_version);
  expect(selectBoonCatalog({ game_directory: 6746 }).demoVersion).toBeUndefined();
  expect(boonCatalogBase("https://example.com/deadlock-nyc/", "6746")).toBe("https://example.com/deadlock-nyc/boon-data/6746/");
});

test("bundled catalog enum definitions match the regression demo's original build", async () => {
  const data = await Bun.file(new URL("../../public/boon-data/6746/abilities.json", import.meta.url)).json();
  expect(data.client_version).toBe("6746");
  expect(data.modifier_value_types[94]).toBe("MODIFIER_VALUE_FIRE_RATE");
  expect(data.modifier_value_types[101]).toBe("MODIFIER_VALUE_COOLDOWN_REDUCTION_PERCENTAGE");
  expect(data.modifier_value_types[163]).toBe("MODIFIER_VALUE_TECH_POWER");
});

test("the replay worker receives the four catalogs in loadCatalog order", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const name = new URL(String(url)).pathname.split("/").at(-1)!;
    return new Response(name);
  });
  try {
    const catalogs = await loadBoonCatalog("https://example.com/data/");
    expect(catalogs.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "heroes.json", "abilities.json", "modifiers.json", "misc.json",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally {
    fetcher.mockRestore();
  }
});

test("a missing catalog reports its name and HTTP status", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(null, { status: 404 }),
  );
  try {
    await expect(loadBoonCatalog("https://example.com/data/")).rejects.toThrow(
      "Could not load boon-data heroes.json (404)",
    );
  } finally {
    fetcher.mockRestore();
  }
});
