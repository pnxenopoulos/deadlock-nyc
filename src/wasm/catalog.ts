import boonVersion from "../data/boon-version.json";

export interface CatalogInfo { version: string; demoVersion?: string }

export function selectBoonCatalog(header: unknown): CatalogInfo {
  const directory = header && typeof header === "object" ? (header as Record<string, unknown>).game_directory : undefined;
  const demoVersion = typeof directory === "string" ? directory.match(/(?:^|[\\/])citadel_v(\d+)(?:[\\/]|$)/)?.[1] : undefined;
  return {
    version: demoVersion && boonVersion.supported_versions.includes(demoVersion) ? demoVersion : boonVersion.client_version,
    demoVersion,
  };
}

export function boonCatalogBase(baseURI: string, version = boonVersion.client_version): string {
  return new URL(`boon-data/${version}/`, baseURI).href;
}

// Both replay workers need the same snapshot: map modifiers use its lifetime
// rules, and player details use its stat definitions. Browser caching shares
// the downloads without retaining catalog buffers on the main thread.
export async function loadBoonCatalog(base: string): Promise<[
  Uint8Array, Uint8Array, Uint8Array, Uint8Array,
]> {
  const files = await Promise.all(["heroes", "abilities", "modifiers", "misc"].map(
    async (name) => {
      const response = await fetch(new URL(`${name}.json`, base));
      if (!response.ok) {
        throw new Error(`Could not load boon-data ${name}.json (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  ));
  return [files[0], files[1], files[2], files[3]];
}
