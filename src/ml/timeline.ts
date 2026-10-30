import type { ProbabilityPoint } from "./types";
/** Previous observation only: playback must not borrow a future prediction. */
export function probabilityAt(
  points: readonly ProbabilityPoint[],
  tick: number,
): ProbabilityPoint | undefined {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return points[lo - 1];
}
export function tickAtPosition(
  x: number,
  left: number,
  width: number,
  first: number,
  last: number,
): number {
  if (width <= 0 || last <= first) return first;
  return Math.round(
    first + Math.max(0, Math.min(1, (x - left) / width)) * (last - first),
  );
}
