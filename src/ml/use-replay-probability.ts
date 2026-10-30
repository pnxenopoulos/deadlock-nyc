import * as React from "react";
import { requestWinProbability } from "../wasm/boon";
import type { ReplayProbability } from "./types";
export type { ReplayProbability } from "./types";

/** Start with the loading result. Only an explicit retry runs inference in the viewer. */
export function useReplayProbability(file: File, initial: ReplayProbability) {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<ReplayProbability>(initial);
  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  React.useEffect(() => {
    if (attempt === 0 || initial.enabled === false) {
      setState(initial);
      return;
    }
    const controller = new AbortController();
    setState({
      enabled: true,
      points: [],
      progress: {
        phase: "Loading win probability model",
        completed: 0,
        total: 0,
      },
    });
    void requestWinProbability(
      file,
      (progress) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            progress,
            modelVersion: progress.modelVersion ?? previous.modelVersion,
            backend: progress.backend ?? previous.backend,
            points: progress.points?.length
              ? [...previous.points, ...progress.points]
              : previous.points,
          }));
      },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setState({ ...result, enabled: true, progress: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            progress: null,
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => controller.abort();
  }, [file, initial, attempt]);
  return { ...state, retry };
}
