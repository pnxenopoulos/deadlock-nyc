import { requestPlayerDetails } from "./boon";
import { LatestQuery } from "./latest-query";

export interface StatContribution {
  stat: string;
  input: string;
  kind: string;
  value: number;
  source: string;
  definition_path: string;
  modifier_serial?: bigint;
}

export interface HeroStatRow {
  stat: string;
  value?: number;
  unit: string;
  status: "calculated" | "partial" | "unresolved";
  diagnostic?: string;
}

export interface AbilityStatRow {
  ability_id: number;
  ability_name?: string;
  stat: string;
  value?: number;
  unit: string;
  status: "calculated" | "partial" | "unresolved";
  diagnostic?: string;
}

export interface AbilityContribution {
  ability_id: number;
  stat: string;
  value?: number;
  source: string;
  source_ability_id?: number;
  property_name?: string;
  definition_path: string;
  scope: string;
  state: string;
  included: boolean;
  diagnostic?: string;
}

export interface ImbueBinding {
  item_id: number;
  item_name?: string;
  ability_id: number;
  ability_name?: string;
  status: string;
  diagnostic?: string;
}

export interface PlayerStatus {
  states?: string[];
  enabled_states?: string[];
  disabled_states?: string[];
  unknown_states: number[];
  unknown_enabled_states: number[];
  unknown_disabled_states: number[];
}

export interface PlayerDetails {
  hero_stats: {
    values: HeroStatRow[];
    contributions: StatContribution[];
    metadata: { data_version: string; source_commit: string };
  };
  ability_stats: {
    values: AbilityStatRow[];
    contributions: AbilityContribution[];
  };
  imbues: { bindings: ImbueBinding[] };
  status?: PlayerStatus;
}

export type PlayerDetailsRequest = {
  type: "details";
  id: number;
  tick: number;
  steamId: string;
};

export type PlayerDetailsResponse =
  | { id: number; ok: true; details: PlayerDetails }
  | { id: number; ok: false; error: string };

let loadedFile: File | null = null;
let queue = new LatestQuery<PlayerDetails>();
const cache = new Map<string, PlayerDetails>();

export function queryPlayerDetails(
  file: File,
  tick: number,
  steamId: string,
  signal?: AbortSignal,
): Promise<PlayerDetails> {
  if (loadedFile !== file) {
    disposePlayerDetails();
    loadedFile = file;
  }
  if (signal?.aborted) return Promise.reject(new DOMException("Query cancelled", "AbortError"));
  const key = `${steamId}:${tick}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const currentQueue = queue;
  return queue.query(key, async () => {
    const details = await requestPlayerDetails(file, tick, steamId);
    if (queue === currentQueue) {
      cache.set(key, details);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return details;
  }, signal);
}

export function disposePlayerDetails(): void {
  queue.cancel();
  queue = new LatestQuery<PlayerDetails>();
  loadedFile = null;
  cache.clear();
}
