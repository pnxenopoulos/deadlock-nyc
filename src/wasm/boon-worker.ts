/// <reference lib="webworker" />
import type { ProbabilityRequest, ProbabilityResponse } from "../ml/types";

import { loadBoonCatalog, selectBoonCatalog, type CatalogInfo } from "./catalog";
import type { PlayerDetails, PlayerDetailsRequest, PlayerDetailsResponse } from "./player-details";

// Loads the boon WASM module inside a Web Worker so the heavy parse pass
// doesn't block the UI thread. The main thread sends a parse request with
// the demo bytes; the worker replies with the extracted data.

export type ParseRequest = {
  type: "parse";
  id: number;
  bytes: ArrayBuffer;
  sampleEvery: number;
  modifiers: boolean;
  catalogBase: string;
};

export type ParseResponse =
  | { id: number; progress: true; tick: number; total: number; phase?: string }
  | {
      id: number;
      ok: true;
      header: unknown;
      players: unknown;
      positions: unknown;
      winner: number | null;
      summary: unknown;
      statuses: unknown;
      checkpointed: boolean;
      catalog: CatalogInfo;
    }
  | { id: number; ok: false; error: string };

interface BoonModule {
  default: () => Promise<unknown>;
  DemoParser: new (bytes: Uint8Array) => {
    loadCatalog(heroes: Uint8Array, abilities: Uint8Array, modifiers: Uint8Array, misc: Uint8Array): void;
    fileHeader(): unknown;
    playerPositions(
      sampleEvery: number,
      progress: (tick: number, total: number) => void,
      modifiers?: boolean,
    ): unknown;
    summary(): unknown;
    playerStatusHistory(ticks: Int32Array): unknown;
    prepareStats(): boolean;
    playerDetails(tick: number, steamId: string): PlayerDetails;
    prepareWinProbability(roster: [string, number][], progress: (tick: number, total: number) => void): number;
    winProbabilityBatch(start: number, count: number): import("../ml/types").RawGraph[];
    clearWinProbability(): void;
    free(): void;
  };
}

const PACKED_FRAME_KEYS = [
  "frame_ticks",
  "frame_reg_ticks",
  "player_offsets",
  "player_i32",
  "player_f32",
  "trooper_offsets",
  "troopers",
  "urn_offsets",
  "urns",
] as const;

function packedFrameTransfers(
  positions: Record<string, unknown>,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const key of PACKED_FRAME_KEYS) {
    const value = positions[key];
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
      buffers.add(value.buffer);
    }
  }
  return [...buffers];
}

let modulePromise: Promise<BoonModule> | null = null;
let parser: InstanceType<BoonModule["DemoParser"]> | undefined;

function loadModule(): Promise<BoonModule> {
  if (!modulePromise) {
    // Let Vite bundle the wasm-pack glue + .wasm (emitted as hashed assets and
    // URL-rewritten). A /* @vite-ignore */ runtime import would skip bundling,
    // so the .wasm would be missing from the production build.
    modulePromise = import("./pkg/boon_wasm.js").then(async (mod) => {
      const m = mod as unknown as BoonModule;
      await m.default();
      return m;
    });
  }
  return modulePromise;
}

let probabilityGeneration = 0;
let probabilityRequestId: number | undefined;
let probabilityTask: Promise<void> = Promise.resolve();
let modifiersEnabled = false;
let probabilityRoster: [string, number][] = [];
self.onmessage = async (e: MessageEvent<ParseRequest | PlayerDetailsRequest | ProbabilityRequest>) => {
  if (e.data.type === "cancel-probability") {
    if (e.data.id === probabilityRequestId) probabilityGeneration++;
    return;
  }
  if (e.data.type === "win-probability") {
    const { id, modelBase } = e.data;
    const generation = ++probabilityGeneration;
    probabilityRequestId = id;
    probabilityTask = probabilityTask.catch(() => {}).then(async () => {
      if (generation !== probabilityGeneration) return;
      try {
        if (!parser) throw new Error("Load a replay before calculating win probability");
        const { inferWinProbability } = await import("../ml/inference");
        const probabilities = await inferWinProbability(parser, probabilityRoster, modelBase,
          (probabilityProgress) => self.postMessage({ id, probabilityProgress } satisfies ProbabilityResponse),
          () => generation !== probabilityGeneration);
        self.postMessage({ id, ok: true, probabilities } satisfies ProbabilityResponse);
      } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ProbabilityResponse);
      }
    });
    return;
  }
  if (e.data.type === "details") {
    const { id, tick, steamId } = e.data;
    try {
      if (!parser) throw new Error("Load a demo before querying stats");
      if (!modifiersEnabled) throw new Error("Enable statuses/modifiers and reparse this replay.");
      self.postMessage({ id, ok: true, details: parser.playerDetails(tick, steamId) } satisfies PlayerDetailsResponse);
    } catch (error) {
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies PlayerDetailsResponse);
    }
    return;
  }
  const { id, sampleEvery } = e.data;
  try {
    modifiersEnabled = e.data.modifiers;
    const mod = await loadModule();
    let input: Uint8Array | null = new Uint8Array(e.data.bytes);
    // wasm-bindgen copies the file into WASM synchronously. Drop every
    // JavaScript reference to the transferred source buffer immediately so it
    // can be reclaimed while the much longer parse pass is running.
    e.data.bytes = new ArrayBuffer(0);
    parser = new mod.DemoParser(input);
    input = null;
    const header = parser.fileHeader();
    const catalog = selectBoonCatalog(header);
    const catalogs = await loadBoonCatalog(new URL(`../${catalog.version}/`, e.data.catalogBase).href);
    parser.loadCatalog(...catalogs);
    // The WASM parse calls this periodically; forward it to the main thread so
    // it can render a progress bar. Cheap — ~a couple hundred messages total.
    const onProgress = (tick: number, total: number) => {
      (self as unknown as Worker).postMessage({
        id,
        progress: true,
        tick,
        total,
      } satisfies ParseResponse);
    };
    const positions = parser.playerPositions(
      sampleEvery,
      onProgress,
      modifiersEnabled,
    ) as Record<string, unknown>;
    let statuses: unknown = { values: [], players: [] };
    let checkpointed = false;
    if (modifiersEnabled) {
      self.postMessage({ id, progress: true, tick: 0, total: 1, phase: "Indexing recorded statuses" } satisfies ParseResponse);
      statuses = parser.playerStatusHistory(positions.frame_ticks as Int32Array);
      self.postMessage({ id, progress: true, tick: 0, total: 1, phase: "Preparing player modifiers and statuses" } satisfies ParseResponse);
      checkpointed = parser.prepareStats();
    }
    // Roster and winner are collected in the entity/event pass above. Remove
    // them from the positions payload so they have one owner on the main thread.
    const players = positions.players;
    probabilityRoster = (players as { steam_id: string; team: number }[]).map(p => [p.steam_id, p.team]);
    const winner = (positions.winner as number | null | undefined) ?? null;
    delete positions.players;
    delete positions.winner;
    // Defensive: a malformed/absent post-match summary must not fail the whole
    // parse (the map/heatmap views don't depend on it).
    let summary: unknown = {
      snapshots: [],
      damage_sample_times: [],
      damage_matrix: [],
      damage_by_source: [],
      healing_by_source: [],
      regen_by_source: [],
      assigned_lanes: [],
    };
    try {
      summary = parser.summary();
    } catch {
      // keep the empty fallback
    }
    const reply: ParseResponse = {
      id,
      ok: true,
      header,
      players,
      positions,
      winner,
      summary,
      statuses,
      checkpointed,
      catalog,
    };
    // Moving the packed columns avoids a second copy of the largest result.
    // The remaining event/metadata objects are comparatively small.
    (self as unknown as Worker).postMessage(
      reply,
      packedFrameTransfers(positions),
    );
  } catch (err) {
    parser?.free();
    parser = undefined;
    const reply: ParseResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
