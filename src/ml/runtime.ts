import type * as Ort from "onnxruntime-web";

export interface Runtime {
  bytes: ArrayBuffer;
  backend: "webgpu" | "wasm";
  ort: typeof Ort;
  session: Ort.InferenceSession;
}

/** Pair each runtime with its matching WASM glue; GPU initialization may fail on older adapters. */
export async function createRuntime(bytes: ArrayBuffer): Promise<Runtime> {
  const gpu = (
    navigator as unknown as {
      gpu?: { requestAdapter(): Promise<typeof Ort.env.webgpu.adapter | null> };
    }
  ).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  const [ort, { default: wasm }, { default: mjs }] = adapter
    ? await Promise.all([
        import("onnxruntime-web/webgpu"),
        import("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url"),
        import("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url"),
      ])
    : await Promise.all([
        import("onnxruntime-web/wasm"),
        import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
        import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
      ]);
  // Pages lacks isolation headers. Hosts that provide them can use up to four threads.
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, Math.max(1, Math.floor(navigator.hardwareConcurrency / 2)))
    : 1;
  ort.env.wasm.wasmPaths = {
    wasm: new URL(wasm, self.location.href).href,
    mjs: new URL(mjs, self.location.href).href,
  };
  let backend: Runtime["backend"] = adapter ? "webgpu" : "wasm";
  if (adapter) ort.env.webgpu.adapter = adapter;
  let session: Ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    if (backend === "wasm") throw error;
    backend = "wasm";
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
  return { bytes, backend, ort, session };
}

/** Also handle adapters that initialize successfully but fail during shader execution. */
export async function fallBackToCPU(runtime: Runtime): Promise<void> {
  await runtime.session.release().catch(() => {});
  runtime.session = await runtime.ort.InferenceSession.create(runtime.bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  runtime.backend = "wasm";
}
