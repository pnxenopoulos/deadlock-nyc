import type { Encoder, Manifest, RawGraph, RawNode, RawValue } from "./types";

export interface Input {
  type: "float32" | "int64" | "bool";
  data: Float32Array | BigInt64Array | Uint8Array;
  dims: number[];
}
const types = ["global", "player", "objective", "zipline"];
const columns = [
  "global_numeric",
  "player_numeric",
  "objective_numeric",
  "zipline_numeric",
];
function finite(value: RawValue | undefined): number | null {
  if (typeof value === "boolean") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function numeric(node: RawNode, name: string): number | null {
  if (name === "health_fraction") {
    const health = finite(node.health),
      max = finite(node.max_health);
    return health !== null && max !== null && max > 0 ? health / max : null;
  }
  if (name === "upgrade_count" || name === "item_count") {
    const ids = node[name === "upgrade_count" ? "upgrade_ids" : "item_ids"];
    return Array.isArray(ids) ? ids.length : null;
  }
  return finite(node[name]);
}
export function validateEncoder(encoder: Encoder): void {
  if (
    encoder.format_version !== 1 ||
    encoder.node_type_order.join(",") !== types.join(",")
  )
    throw new Error("Unsupported model feature schema.");
  const supported = new Set([
    "elapsed_seconds",
    "mid_boss_up",
    "next_midboss",
    "x",
    "y",
    "z",
    "health",
    "max_health",
    "health_fraction",
    "barrier",
    "level",
    "souls",
    "spent_souls",
    "respawn_time",
    "is_alive",
    "health_regen",
    "has_rebirth",
    "has_rejuvenator",
    "has_ultimate_trained",
    "ultimate_cooldown_start",
    "ultimate_cooldown_end",
    "ap_net_worth",
    "gold_net_worth",
    "upgrade_count",
    "item_count",
    "destroyed",
    "capturable",
    "cumulative_distance",
    ...[
      "weapon_damage",
      "fire_rate",
      "move_speed",
      "stamina",
      "bullet_resist",
      "spirit_resist",
    ].map((n) => "baseline_" + n),
  ]);
  if (
    encoder.numeric_features.length !== 4 ||
    encoder.categorical_features.length !== 4
  )
    throw new Error("Invalid model feature groups.");
  encoder.numeric_features.forEach((names, i) => {
    if (
      names.some((n) => !supported.has(n)) ||
      encoder.means[i]?.length !== names.length ||
      encoder.scales[i]?.length !== names.length ||
      encoder.means[i].some((v) => !Number.isFinite(v)) ||
      encoder.scales[i].some((v) => !Number.isFinite(v) || v <= 0)
    )
      throw new Error("Unsupported model numeric features.");
  });
  for (const names of encoder.categorical_features)
    for (const name of names) {
      if (
        !["hero_id", "objective_type", "lane", "phase"].includes(name) ||
        !encoder.vocabularies[name]
      )
        throw new Error("Unsupported model categories.");
    }
  if (
    encoder.categorical_features[0].length ||
    !encoder.vocabularies.upgrade_ids
  )
    throw new Error("Unsupported global or inventory encoding.");
}
/** Match dwp GraphEncoder + GraphBatch, with one masked slot for absent types. */
export function encodeGraphs(
  graphs: RawGraph[],
  encoder: Encoder,
): Record<string, Input> {
  if (!graphs.length) throw new Error("A prediction batch cannot be empty.");
  const tables = graphs.map((g) => [
    [g.global_info],
    g.players,
    g.objectives,
    g.ziplines,
  ]);
  const counts = types.map((_, i) =>
    Math.max(1, ...tables.map((t) => t[i].length)),
  );
  const offsets = [
    0,
    counts[0],
    counts[0] + counts[1],
    counts[0] + counts[1] + counts[2],
  ];
  const b = graphs.length,
    n = counts.reduce((a, v) => a + v, 0);
  const tokens = Math.max(
    1,
    ...graphs.flatMap((g) =>
      g.players.map((p) =>
        Array.isArray(p.upgrade_ids) ? p.upgrade_ids.length : 0,
      ),
    ),
  );
  const out: Record<string, Input> = {};
  const teams = new BigInt64Array(b * n),
    positions = new Float32Array(b * n * 3),
    known = new Uint8Array(b * n),
    valid = new Uint8Array(b * n),
    connections = new Uint8Array(b * n * n),
    connectionsKnown = new Uint8Array(b * n),
    upgrades = new BigInt64Array(b * counts[1] * tokens);
  const teamIndex = new Map(encoder.team_indices.map((t) => [t.raw, t.index]));
  for (let i = 0; i < 4; i++) {
    const names = encoder.numeric_features[i],
      cats = encoder.categorical_features[i],
      numericData = new Float32Array(b * counts[i] * names.length * 2),
      categoryData = new BigInt64Array(b * counts[i] * cats.length);
    tables.forEach((tables, row) =>
      tables[i].forEach((node, j) => {
        const index = row * n + offsets[i] + j;
        valid[index] = 1;
        teams[index] = BigInt(
          teamIndex.get(
            typeof node.team_num === "number" ? node.team_num : null,
          ) ?? 0,
        );
        const xyz = ["x", "y", "z"].map((axis) => finite(node[axis]));
        if (xyz.every((v) => v !== null)) {
          known[index] = 1;
          xyz.forEach(
            (v, axis) =>
              (positions[index * 3 + axis] = Math.fround(
                Math.fround(v!) / 10000,
              )),
          );
        }
        names.forEach((name, k) => {
          const value = numeric(node, name),
            base = (row * counts[i] + j) * names.length * 2;
          if (value !== null) {
            const transformed = Math.sign(value) * Math.log1p(Math.abs(value));
            numericData[base + k] =
              (transformed - encoder.means[i][k]) / encoder.scales[i][k];
            numericData[base + names.length + k] = 1;
          }
        });
        cats.forEach((name, k) => {
          const value = node[name];
          categoryData[(row * counts[i] + j) * cats.length + k] = BigInt(
            value == null
              ? 0
              : (encoder.vocabularies[name][String(value)] ?? 1),
          );
        });
        if (i === 1 && Array.isArray(node.upgrade_ids))
          node.upgrade_ids.forEach((id, k) => {
            upgrades[(row * counts[1] + j) * tokens + k] = BigInt(
              encoder.vocabularies.upgrade_ids[String(id)] ?? 1,
            );
          });
      }),
    );
    out[columns[i]] = {
      type: "float32",
      data: numericData,
      dims: [b, counts[i], names.length * 2],
    };
    if (i > 0)
      out[types[i] + "_categorical"] = {
        type: "int64",
        data: categoryData,
        dims: [b, counts[i], cats.length],
      };
  }
  graphs.forEach((g, row) => {
    const handles = new Map(
      g.ziplines.map((node, i) => [node.node_handle, offsets[3] + i]),
    );
    g.ziplines.forEach((node, i) => {
      if (Array.isArray(node.connections)) {
        connectionsKnown[row * n + offsets[3] + i] = 1;
        for (const handle of node.connections) {
          const target = handles.get(handle);
          if (target !== undefined)
            connections[(row * n + offsets[3] + i) * n + target] = 1;
        }
      }
    });
  });
  return {
    ...out,
    upgrades: { type: "int64", data: upgrades, dims: [b, counts[1], tokens] },
    teams: { type: "int64", data: teams, dims: [b, n] },
    positions: { type: "float32", data: positions, dims: [b, n, 3] },
    position_known: { type: "bool", data: known, dims: [b, n] },
    connections: { type: "bool", data: connections, dims: [b, n, n] },
    connections_known: { type: "bool", data: connectionsKnown, dims: [b, n] },
    valid: { type: "bool", data: valid, dims: [b, n] },
  };
}

export function validateManifest(manifest: Manifest): void {
  if (
    manifest.format_version !== 1 ||
    manifest.versions?.["boon-deadlock"] !== "0.19.0" ||
    manifest.data_version != null
  )
    throw new Error(
      "This model requires a newer feature extractor. Please update the viewer.",
    );
}
