import type {
  Encoder,
  Manifest,
  ProbabilityPoint,
  ProbabilityProgress,
  ProbabilityResult,
  RawGraph,
} from "./types";
import { encodeGraphs, validateEncoder, validateManifest } from "./features";
import { createRuntime, fallBackToCPU, type Runtime } from "./runtime";
import type * as Ort from "onnxruntime-web";

export interface ProbabilityParser {
  prepareWinProbability(
    roster: [string, number][],
    progress: (tick: number, total: number) => void,
  ): number;
  winProbabilityBatch(start: number, count: number): RawGraph[];
  clearWinProbability(): void;
}
let cached: (Runtime & { version: string; encoder: Encoder }) | undefined;
async function verified(url: URL, digest: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Could not load the win probability model (${response.status}).`,
    );
  const bytes = await response.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== digest)
    throw new Error(
      "Model files changed during download. Please reload and try again.",
    );
  return bytes;
}
async function loadModel(base: string) {
  const response = await fetch(new URL("manifest.json", base), {
    cache: "no-cache",
  });
  if (!response.ok)
    throw new Error(
      "Win probability model is unavailable. Please try again later.",
    );
  const manifest = (await response.json()) as Manifest;
  validateManifest(manifest);
  if (cached?.version === manifest.model_version) return cached;
  if (
    !/^[a-f0-9]{64}$/.test(manifest.sha256?.["model.onnx"] ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256?.["encoder.json"] ?? "")
  )
    throw new Error("Invalid model checksums.");
  const [model, metadata] = await Promise.all([
    verified(
      new URL(
        `model.onnx?v=${encodeURIComponent(manifest.model_version)}`,
        base,
      ),
      manifest.sha256["model.onnx"],
    ),
    verified(
      new URL(
        `encoder.json?v=${encodeURIComponent(manifest.model_version)}`,
        base,
      ),
      manifest.sha256["encoder.json"],
    ),
  ]);
  const encoder = JSON.parse(new TextDecoder().decode(metadata)) as Encoder;
  validateEncoder(encoder);
  const runtime = await createRuntime(model);
  await cached?.session.release();
  cached = { version: manifest.model_version, encoder, ...runtime };
  return cached;
}
export async function inferWinProbability(
  parser: ProbabilityParser,
  roster: [string, number][],
  modelBase: string,
  report: (p: ProbabilityProgress) => void,
  cancelled: () => boolean,
): Promise<ProbabilityResult> {
  const check = () => {
    if (cancelled())
      throw new DOMException("Prediction cancelled", "AbortError");
  };
  report({ phase: "Loading win probability model", completed: 0, total: 0 });
  const model = await loadModel(modelBase);
  check();
  report({
    phase: "Reading replay state",
    completed: 0,
    total: 0,
    modelVersion: model.version,
  });
  const points: ProbabilityPoint[] = [],
    pending: ProbabilityPoint[] = [];
  let lastReport = performance.now();
  try {
    const total = parser.prepareWinProbability(roster, (completed, total) =>
      report({
        phase: "Reading replay state",
        completed,
        total,
        modelVersion: model.version,
      }),
    );
    if (!total)
      throw new Error(
        "No playable pre-game-over snapshots were found in this replay.",
      );
    for (let start = 0; start < total;) {
      // Bounded batches keep memory use low and allow playback requests between runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      check();
      const graphs = parser.winProbabilityBatch(
        start,
        Math.min(model.backend === "webgpu" ? 4 : 2, total - start),
      );
      const encoded = encodeGraphs(graphs, model.encoder);
      const feeds: Record<string, Ort.Tensor> = {};
      let result: Ort.InferenceSession.ReturnType | undefined;
      try {
        for (const [name, input] of Object.entries(encoded))
          feeds[name] = new model.ort.Tensor(
            input.type,
            input.data,
            input.dims,
          );
        try {
          result = await model.session.run(feeds);
        } catch (error) {
          if (model.backend === "wasm") throw error;
          // Some adapters only fail at their first shader dispatch. Retry this batch on CPU.
          await fallBackToCPU(model);
          check();
          result = await model.session.run(feeds);
        }
        const values = result.archmother_win_probability?.data;
        if (!values || values.length !== graphs.length)
          throw new Error("Unexpected win probability output.");
        graphs.forEach((g, i) => {
          const probability = Number(values[i]);
          if (
            !Number.isFinite(probability) ||
            probability < 0 ||
            probability > 1
          )
            throw new Error("The model returned an invalid probability.");
          const point = {
            tick: g.tick,
            seconds: g.elapsed_seconds,
            archmother: probability,
          };
          points.push(point);
          pending.push(point);
        });
      } finally {
        for (const tensor of Object.values(result ?? {})) tensor.dispose();
        for (const tensor of Object.values(feeds)) tensor.dispose();
      }
      const completed = Math.min(start + graphs.length, total);
      if (performance.now() - lastReport >= 200 || completed === total) {
        report({
          phase: "Computing win probabilities",
          backend: model.backend,
          completed,
          total,
          points: pending.splice(0),
          modelVersion: model.version,
        });
        lastReport = performance.now();
      }
      start = completed;
    }
    check();
    return { points, modelVersion: model.version, backend: model.backend };
  } finally {
    parser.clearWinProbability();
  }
}
