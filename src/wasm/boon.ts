import type { PositionsResult } from "@/components/map-view";
import type { PlayerInfo } from "@/components/player-roster";
import { FrameStore, type PackedFrameData } from "./frames";
import type { ParseRequest, ParseResponse } from "./boon-worker";
import { boonCatalogBase, type CatalogInfo } from "./catalog";
import { StatusStore, type StatusHistory } from "./statuses";
import type { PlayerDetails, PlayerDetailsRequest, PlayerDetailsResponse } from "./player-details";

/** One post-match snapshot for a player (running totals at a sampled time).
 * Team is resolved from the roster by `hero_id`. From `DemoParser::summary`. */
export interface SnapshotStat {
  time_s: number;
  hero_id: number;
  net_worth: number;
  kills: number;
  deaths: number;
  assists: number;
  creep_kills: number;
  neutral_kills: number;
  player_damage: number;
  denies: number;
  ability_points: number;
  player_healing: number | null | undefined;
  self_healing: number | null | undefined;
  teammate_healing: number | null | undefined;
  player_damage_taken: number | null | undefined;
  creep_damage: number | null | undefined;
  neutral_damage: number | null | undefined;
  boss_damage: number | null | undefined;
  damage_absorbed: number | null | undefined;
  damage_mitigated: number | null | undefined;
  heal_prevented: number | null | undefined;
  heal_lost: number | null | undefined;
  possible_creeps: number | null | undefined;
  // Per-source souls (gold + orbs), for the player souls-by-source view.
  souls_players: number;
  souls_lane: number;
  souls_neutral: number;
  souls_boss: number;
  souls_treasure: number;
  souls_denies: number;
  souls_assists: number;
  souls_team_bonus: number;
  souls_other: number;
}

/** Total hero-damage dealt from one hero to another over the whole match.
 * Powers the hero-vs-hero Matrix view. From `DemoParser::summary`. */
export interface DamagePair {
  dealer_hero: number;
  target_hero: number;
  damage: number;
}

/** A dealer hero's cumulative damage in one coarse source category
 * (Bullet/Ability/Melee/Misc/…), summed over targets and sampled at
 * `MatchSummary.damage_sample_times`. Powers the Timeline damage-by-source view. */
export interface DamageSourceSeries {
  hero_id: number;
  source: string;
  values: number[];
}

/** Post-match summary. `snapshots` is empty if the demo lacks PostMatchDetails. */
export interface MatchSummary {
  snapshots: SnapshotStat[];
  /** Shared time axis (seconds) for the `damage_by_source` cumulative series. */
  damage_sample_times: number[];
  /** Hero-vs-hero total damage (Matrix view). */
  damage_matrix: DamagePair[];
  /** Per (hero, coarse category) cumulative damage series (Timeline view). */
  damage_by_source: DamageSourceSeries[];
  /** Specific sources only: healing provided by this hero. */
  healing_by_source: DamageSourceSeries[];
  /** Specific sources only: regeneration received by this hero. */
  regen_by_source: DamageSourceSeries[];
  assigned_lanes: { hero_id: number; lane: number | null | undefined }[];
}

export interface ParsedDemo {
  catalog: CatalogInfo;
  statuses: StatusStore;
  checkpointed: boolean;
  header: unknown;
  players: PlayerInfo[];
  positions: PositionsResult;
  winner: number | null;
  summary: MatchSummary;
}

type PackedPositionsResult = Omit<PositionsResult, "frames"> & PackedFrameData;

function unpackPositions(raw: PackedPositionsResult): PositionsResult {
  const {
    frame_ticks,
    frame_reg_ticks,
    player_offsets,
    player_i32,
    player_f32,
    player_i32_stride,
    player_f32_stride,
    trooper_offsets,
    troopers,
    urn_offsets,
    urns,
    ...metadata
  } = raw;
  return {
    ...metadata,
    frames: new FrameStore({
      frame_ticks,
      frame_reg_ticks,
      player_offsets,
      player_i32,
      player_f32,
      player_i32_stride,
      player_f32_stride,
      trooper_offsets,
      troopers,
      urn_offsets,
      urns,
    }),
  };
}

let worker: Worker | null = null;
let nextId = 0;
let loadedFile: File | undefined;
const detailRequests = new Map<number, { resolve: (v: PlayerDetails) => void; reject: (e: Error) => void }>();
const pending = new Map<
  number,
  {
    resolve: (v: ParsedDemo) => void;
    reject: (e: Error) => void;
    onProgress?: (tick: number, total: number, phase?: string) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./boon-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<ParseResponse | PlayerDetailsResponse>) => {
      const msg = e.data;
      const detail = detailRequests.get(msg.id);
      if (detail && "ok" in msg) {
        detailRequests.delete(msg.id);
        if (msg.ok && "details" in msg) detail.resolve(msg.details);
        else if (!msg.ok) detail.reject(new Error(msg.error));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      if ("progress" in msg) {
        p.onProgress?.(msg.tick, msg.total, msg.phase);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok && "positions" in msg) {
        try {
          p.resolve({
            catalog: msg.catalog,
            statuses: new StatusStore(msg.statuses as StatusHistory),
            checkpointed: msg.checkpointed,
            header: msg.header,
            players: msg.players as PlayerInfo[],
            positions: unpackPositions(
              msg.positions as PackedPositionsResult,
            ),
            winner: msg.winner,
            summary: msg.summary as MatchSummary,
          });
        } catch (error) {
          p.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          disposeDemo();
        }
      } else if (!msg.ok) {
        p.reject(new Error(msg.error));
        disposeDemo();
      }
    };
    worker.onerror = (event) => disposeDemo(new Error(event.message || "Replay worker failed"));
    worker.onmessageerror = () => disposeDemo(new Error("Could not read replay worker response"));
  }
  return worker;
}

/** Release the retained parser/checkpoints when leaving or replacing a demo. */
export function disposeDemo(error = new Error("Replay was closed")) {
  worker?.terminate();
  worker = null;
  loadedFile = undefined;
  for (const request of pending.values()) request.reject(error);
  for (const request of detailRequests.values()) request.reject(error);
  pending.clear();
  detailRequests.clear();
}

export function requestPlayerDetails(file: File, tick: number, steamId: string): Promise<PlayerDetails> {
  if (!worker || loadedFile !== file) return Promise.reject(new Error("This demo is not loaded"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    detailRequests.set(id, { resolve, reject });
    worker!.postMessage({ type: "details", id, tick, steamId } satisfies PlayerDetailsRequest);
  });
}

/** Release the previous WASM heap before allocating a replacement file buffer. */
export async function parseDemoFile(
  file: File,
  sampleEvery: number,
  onProgress?: (tick: number, total: number, phase?: string) => void,
): Promise<ParsedDemo> {
  disposeDemo();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseDemo(bytes, sampleEvery, onProgress, file);
}

export function parseDemo(
  bytes: Uint8Array,
  sampleEvery: number,
  onProgress?: (tick: number, total: number, phase?: string) => void,
  file?: File,
): Promise<ParsedDemo> {
  disposeDemo();
  loadedFile = file;
  const w = getWorker();
  const id = nextId++;
  return new Promise<ParsedDemo>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const req: ParseRequest = {
      type: "parse",
      id,
      bytes: bytes.buffer as ArrayBuffer,
      sampleEvery,
      catalogBase: boonCatalogBase(document.baseURI),
    };
    // Transfer the buffer to avoid copying; the original Uint8Array is
    // consumed and shouldn't be used after this call.
    w.postMessage(req, [req.bytes]);
  });
}
