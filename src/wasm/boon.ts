import type { PositionsResult } from "@/components/map-view";
import type { PlayerInfo } from "@/components/player-roster";
import { FrameStore, type PackedFrameData } from "./frames";
import type { ParseRequest, ParseResponse } from "./boon-worker";

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
  player_healing: number;
  denies: number;
  ability_points: number;
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
}

export interface ParsedDemo {
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
const pending = new Map<
  number,
  {
    resolve: (v: ParsedDemo) => void;
    reject: (e: Error) => void;
    onProgress?: (tick: number, total: number) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./boon-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<ParseResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if ("progress" in msg) {
        p.onProgress?.(msg.tick, msg.total);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok) {
        try {
          p.resolve({
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
        }
      } else {
        p.reject(new Error(msg.error));
      }
      // Parsing is done and the large numeric columns have been transferred
      // onto the main thread, so the worker is no longer needed. Its WASM memory
      // holds the whole demo plus parse scratch (often 1 GB+) and never shrinks
      // back — only terminating the worker returns it to the OS. We respawn it
      // lazily on the next parseDemo (re-instantiating the small .wasm is cheap).
      disposeWorkerIfIdle();
    };
  }
  return worker;
}

// Tear down the worker (and free its WASM heap) once nothing is in flight.
function disposeWorkerIfIdle() {
  if (worker && pending.size === 0) {
    worker.terminate();
    worker = null;
  }
}

export function parseDemo(
  bytes: Uint8Array,
  sampleEvery: number,
  onProgress?: (tick: number, total: number) => void,
): Promise<ParsedDemo> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<ParsedDemo>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const req: ParseRequest = {
      id,
      bytes: bytes.buffer as ArrayBuffer,
      sampleEvery,
    };
    // Transfer the buffer to avoid copying; the original Uint8Array is
    // consumed and shouldn't be used after this call.
    w.postMessage(req, [req.bytes]);
  });
}
