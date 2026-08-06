/// <reference lib="webworker" />

// Loads the boon WASM module inside a Web Worker so the heavy parse pass
// doesn't block the UI thread. The main thread sends a parse request with
// the demo bytes; the worker replies with the extracted data.

export type ParseRequest = {
  id: number;
  bytes: ArrayBuffer;
  sampleEvery: number;
};

export type ParseResponse =
  | { id: number; progress: true; tick: number; total: number }
  | {
      id: number;
      ok: true;
      header: unknown;
      players: unknown;
      positions: unknown;
      winner: number | null;
      summary: unknown;
    }
  | { id: number; ok: false; error: string };

interface BoonModule {
  default: () => Promise<unknown>;
  DemoParser: new (bytes: Uint8Array) => {
    fileHeader(): unknown;
    playerPositions(
      sampleEvery: number,
      progress: (tick: number, total: number) => void,
    ): unknown;
    summary(): unknown;
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

self.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const { id, sampleEvery } = e.data;
  try {
    const mod = await loadModule();
    let input: Uint8Array | null = new Uint8Array(e.data.bytes);
    // wasm-bindgen copies the file into WASM synchronously. Drop every
    // JavaScript reference to the transferred source buffer immediately so it
    // can be reclaimed while the much longer parse pass is running.
    e.data.bytes = new ArrayBuffer(0);
    const parser = new mod.DemoParser(input);
    input = null;
    const header = parser.fileHeader();
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
    ) as Record<string, unknown>;
    // Roster and winner are collected in the entity/event pass above. Remove
    // them from the positions payload so they have one owner on the main thread.
    const players = positions.players;
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
    };
    try {
      summary = parser.summary();
    } catch {
      // keep the empty fallback
    }
    parser.free();
    const reply: ParseResponse = {
      id,
      ok: true,
      header,
      players,
      positions,
      winner,
      summary,
    };
    // Moving the packed columns avoids a second copy of the largest result.
    // The remaining event/metadata objects are comparatively small.
    (self as unknown as Worker).postMessage(
      reply,
      packedFrameTransfers(positions),
    );
  } catch (err) {
    const reply: ParseResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
