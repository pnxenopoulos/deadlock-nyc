import { WinProbabilityCard } from "../../src/components/win-probability-card";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { encodeGraphs, validateEncoder } from "../../src/ml/features";
import { probabilityAt, tickAtPosition } from "../../src/ml/timeline";
import { TimelinePanel } from "../../src/components/timeline-panel";
import fixture from "../fixtures/win-probability-features.json";
import type { Encoder, RawGraph } from "../../src/ml/types";
import type { MatchSummary } from "../../src/wasm/boon";

test("browser encoding matches Python features, categories, connections and masks", () => {
  const encoder = fixture.encoder as Encoder;
  validateEncoder(encoder);
  const encoded = encodeGraphs(fixture.graphs as RawGraph[], encoder);
  for (const [name, input] of Object.entries(encoded)) {
    const expected = fixture.inputs[name as keyof typeof fixture.inputs];
    expect(input.dims).toEqual(expected.dims);
    expect(input.type).toBe(expected.type);
    expect(input.data.length).toBe(expected.data.length);
    input.data.forEach((v, i) =>
      expect(
        Math.abs(Number(v) - Number(expected.data[i])),
      ).toBeLessThanOrEqual(input.type === "float32" ? 2e-6 : 0),
    );
  }
  expect(() => encodeGraphs([], encoder)).toThrow("empty");
});
test("unknown feature schemas fail before inference", () => {
  const encoder = structuredClone(fixture.encoder) as Encoder;
  encoder.numeric_features[0][0] = "future_score";
  expect(() => validateEncoder(encoder)).toThrow("Unsupported");
});
test("playback readout takes the previous prediction and never a future sample", () => {
  const points = [
    { tick: 10, seconds: 0, archmother: 0.4 },
    { tick: 74, seconds: 1, archmother: 0.8 },
  ];
  expect(probabilityAt(points, 9)).toBeUndefined();
  expect(probabilityAt(points, 10)?.archmother).toBe(0.4);
  expect(probabilityAt(points, 73)?.archmother).toBe(0.4);
  expect(probabilityAt(points, 74)?.archmother).toBe(0.8);
  expect(probabilityAt(points, 100)?.archmother).toBe(0.8);
});
test("chart seeking respects plot bounds and degenerate recordings", () => {
  expect(tickAtPosition(50, 0, 100, 10, 110)).toBe(60);
  expect(tickAtPosition(-5, 0, 100, 10, 110)).toBe(10);
  expect(tickAtPosition(200, 0, 100, 10, 110)).toBe(110);
  expect(tickAtPosition(50, 0, 0, 10, 110)).toBe(10);
});
test("the probability toggle starts off and the recorded timeline stays visible", () => {
  const summary = {
    snapshots: [],
    damage_sample_times: [],
    damage_matrix: [],
    damage_by_source: [],
    healing_by_source: [],
    regen_by_source: [],
    assigned_lanes: [],
  } as MatchSummary;
  const html = renderToStaticMarkup(
    <TimelinePanel
      enabled={false} onEnabledChange={() => {}}
      probability={{ points: [], progress: null }}
      onRetry={() => {}}
      players={[]}
      summary={summary}
      currentTick={10}
      firstTick={10}
      lastTick={100}
      onSeek={() => {}}
      formatTick={String}
    />,
  );
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain("No post-match summary");
  expect(html).not.toContain("Preparing predictions");
});

test("the Live card shows completed probabilities and a replay-synced playhead", () => {
  const html = renderToStaticMarkup(
    <WinProbabilityCard
      probability={{
        points: [{ tick: 10, seconds: 1, archmother: 0.7 }],
        progress: null,
      }}
      onRetry={() => {}}
      currentTick={20}
      firstTick={10}
      lastTick={100}
      onSeek={() => {}}
      formatTick={String}
    />,
  );
  expect(html).toContain('aria-label="Live win probability"');
  expect(html).toContain('aria-label="Win probability replay timeline"');
  expect(html).toContain('aria-valuenow="20"');
  expect(html).toContain("70.0%");
  expect(html).toContain("30.0%");
  expect(html).not.toContain("Preparing predictions");
});

test("the Live card offers a model retry without hiding the replay", () => {
  const html = renderToStaticMarkup(
    <WinProbabilityCard
      probability={{ points: [], progress: null, error: "model unavailable" }}
      onRetry={() => {}}
      currentTick={20}
      firstTick={10}
      lastTick={100}
      onSeek={() => {}}
      formatTick={String}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("model unavailable");
  expect(html).toContain("Retry");
});
