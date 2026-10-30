export type RawValue = number | string | boolean | null | number[];
export type RawNode = Record<string, RawValue | undefined>;
export interface RawGraph {
  tick: number;
  elapsed_seconds: number;
  global_info: RawNode;
  players: RawNode[];
  objectives: RawNode[];
  ziplines: RawNode[];
}
export interface Encoder {
  format_version: number;
  node_type_order: string[];
  numeric_features: string[][];
  categorical_features: string[][];
  means: number[][];
  scales: number[][];
  vocabularies: Record<string, Record<string, number>>;
  team_indices: { raw: number | null; index: number }[];
}
export interface Manifest {
  format_version: number;
  model_version: string;
  data_version: string | null;
  versions: Record<string, string>;
  sha256: Record<string, string>;
  inputs: { name: string; dtype: string; shape: (number | string)[] }[];
}
export interface ProbabilityPoint {
  tick: number;
  seconds: number;
  archmother: number;
}
export interface ProbabilityResult {
  modelVersion: string;
  backend?: "webgpu" | "wasm";
  points: ProbabilityPoint[];
}
export interface ProbabilityProgress {
  phase: string;
  backend?: "webgpu" | "wasm";
  completed: number;
  total: number;
  points?: ProbabilityPoint[];
  modelVersion?: string;
}
export type ProbabilityRequest =
  | { type: "win-probability"; id: number; modelBase: string }
  | { type: "cancel-probability"; id: number };
export type ProbabilityResponse =
  | { id: number; probabilityProgress: ProbabilityProgress }
  | { id: number; ok: true; probabilities: ProbabilityResult }
  | { id: number; ok: false; error: string };

/** Completed loading result, or a recoverable model error for the viewer. */
export interface ReplayProbability {
  enabled?: boolean;
  points: ProbabilityPoint[];
  progress: ProbabilityProgress | null;
  modelVersion?: string;
  backend?: "webgpu" | "wasm";
  error?: string;
}
