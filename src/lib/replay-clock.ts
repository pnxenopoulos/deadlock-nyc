import type { FrameStore } from "../wasm/frames";

/** Read the sampled regulation clock, adjusting unsampled event ticks without
 * advancing through pauses. Avoid materializing player frames for feed rows. */
export function regulationTicksAt(
  frames: FrameStore,
  tick: number,
  pauses: readonly { start: number; end: number }[],
): number {
  const index = frames.indexAtOrAfter(tick);
  if (index < 0) return 0;
  const sampledTick = frames.tickAt(index)!;
  const start = Math.min(tick, sampledTick);
  const end = Math.max(tick, sampledTick);
  let elapsed = end - start;
  for (const pause of pauses) {
    elapsed -= Math.max(0, Math.min(end, pause.end) - Math.max(start, pause.start));
  }
  return Math.max(0, frames.regTicksAt(index)! + (tick >= sampledTick ? elapsed : -elapsed));
}
