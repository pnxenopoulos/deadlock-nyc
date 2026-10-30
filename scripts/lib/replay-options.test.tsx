import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReplayOptionsFields,
  FeatureRequired,
} from "../../src/components/replay-options";
import { DEFAULT_LOAD_OPTIONS } from "../../src/wasm/load-options";
import { WinProbabilityCard } from "../../src/components/win-probability-card";
import { TimelinePanel } from "../../src/components/timeline-panel";
import type { MatchSummary } from "../../src/wasm/boon";

test("both expensive loading features default off", () => {
  expect(DEFAULT_LOAD_OPTIONS).toEqual({
    modifiers: false,
    winProbability: false,
  });
  const html = renderToStaticMarkup(
    <ReplayOptionsFields value={DEFAULT_LOAD_OPTIONS} onChange={() => {}} />,
  );
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).not.toContain('checked=""');
  expect(html).toContain("Statuses/modifiers");
  expect(html).toContain("Win probability");
});
test("disabled probability panels ask for reparsing and never display a fake curve", () => {
  const shared = {
    probability: { enabled: false, points: [], progress: null },
    onRetry: () => {},
    onEnable: () => {},
    currentTick: 10,
    firstTick: 0,
    lastTick: 100,
    onSeek: () => {},
    formatTick: String,
  };
  const card = renderToStaticMarkup(<WinProbabilityCard {...shared} />);
  const timeline = renderToStaticMarkup(
    <TimelinePanel
      {...shared}
      enabled
      onEnabledChange={() => {}}
      players={[]}
      summary={{} as MatchSummary}
    />,
  );
  for (const html of [card, timeline]) {
    expect(html).toContain("Enable win probability and reparse");
    expect(html).not.toContain("Preparing predictions");
    expect(html).not.toContain("<polyline");
  }
});
test("status notices clearly distinguish disabled data from no recorded effects", () => {
  const html = renderToStaticMarkup(
    <FeatureRequired feature="Statuses/modifiers" onEnable={() => {}} />,
  );
  expect(html).toContain("loaded without statuses/modifiers");
  expect(html).toContain("Enable statuses/modifiers and reparse");
});
