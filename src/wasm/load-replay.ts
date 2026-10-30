import { DEFAULT_LOAD_OPTIONS, type ReplayLoadOptions } from "./load-options";
import { parseDemoFile, requestWinProbability } from "./boon";
import type { ReplayProbability } from "../ml/types";

export interface LoadingProgress {
  phase: string;
  completed: number;
  total: number;
  unit?: "ticks" | "predictions";
}

/** Resolve only after parsing and prediction finish; model errors leave the replay usable. */
export async function loadReplay(
  file: File,
  sampleEvery: number,
  report: (progress: LoadingProgress) => void,
  signal: AbortSignal,
  options: Readonly<ReplayLoadOptions> = DEFAULT_LOAD_OPTIONS,
) {
  const parsed = await parseDemoFile(
    file,
    sampleEvery,
    (completed, total, phase) =>
      report({
        phase: phase ?? "Parsing replay",
        completed,
        total: phase ? 0 : total,
        unit: phase ? undefined : "ticks",
      }),
    signal,
    options,
  );
  if (signal.aborted) throw new DOMException("Loading cancelled", "AbortError");
  if (!options.winProbability)
    return {
      parsed,
      probability: {
        enabled: false,
        points: [],
        progress: null,
      } as ReplayProbability,
    };
  let probability: ReplayProbability;
  try {
    const result = await requestWinProbability(
      file,
      (progress) =>
        report({
          phase:
            progress.phase === "Reading replay state"
              ? "Preparing win probability snapshots"
              : progress.phase,
          completed: progress.completed,
          total: progress.total,
          unit:
            progress.phase === "Computing win probabilities"
              ? "predictions"
              : "ticks",
        }),
      signal,
    );
    probability = { ...result, enabled: true, progress: null };
  } catch (error) {
    if (signal.aborted) throw error;
    probability = {
      enabled: true,
      points: [],
      progress: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { parsed, probability };
}
