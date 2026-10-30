import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeatmapView } from "../../src/components/heatmap-view";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { FrameStore } from "../../src/wasm/frames";
import { StatusStore, type StatusHistory } from "../../src/wasm/statuses";
import { replayFrames, replayPlayer } from "./replay-fixture";

const offsets = new Uint32Array(4);
const frames = new FrameStore({
  frame_ticks: Int32Array.from([0, 64, 128]), frame_reg_ticks: Int32Array.from([0, 64, 128]),
  player_offsets: offsets, player_i32: new Int32Array(), player_f32: new Float32Array(),
  player_i32_stride: 13, player_f32_stride: 7,
  trooper_offsets: offsets, troopers: new Int32Array(), urn_offsets: offsets, urns: new Float32Array(),
});
const players = [1, 2].map((hero_id) => ({
  hero_id, hero_name: `Hero ${hero_id}`, name: `Player ${hero_id}`, steam_id: String(hero_id), team: 2, rank: 0,
}));
const history: StatusHistory = {
  values: [
    { states: [], enabled_states: ["IN_COMBAT"], unknown_states: [], unknown_enabled_states: [], unknown_disabled_states: [] },
    { states: ["IN_COMBAT"], unknown_states: [], unknown_enabled_states: [], unknown_disabled_states: [] },
  ],
  players: [
    { steam_id: "1", ticks: [0, 32, 64], indices: [0, 1, 0] },
    { steam_id: "2", ticks: [0], indices: [1] },
  ],
};

function render(data: StatusHistory, store = frames, roster = players, pauseIntervals: { start: number; end: number }[] = []) {
  return renderToStaticMarkup(<TooltipProvider>
    <HeatmapView players={roster} killEvents={[]} abilityEvents={[]} frames={store}
      objectives={[]} objectiveEvents={[]} statuses={new StatusStore(data)} pauseIntervals={pauseIntervals} />
  </TooltipProvider>);
}

function statCell(html: string, section: "tbody" | "tfoot", index: number) {
  const body = html.split(`<${section}>`)[1].split(`</${section}>`)[0];
  return [...body.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)][index][1];
}

const combatCell = (html: string, section: "tbody" | "tfoot") => statCell(html, section, 3);

test("heatmap combat cells use recorded status duration and the whole team's average", () => {
  const html = render(history);
  expect(html).toContain("CBT");
  expect(combatCell(html, "tbody")).toContain(">25%</span>");
  expect(combatCell(html, "tfoot")).toBe("63%");
});

test("heatmap combat cells distinguish unknown coverage from known out-of-combat time", () => {
  expect(combatCell(render({ ...history, players: [] }), "tbody")).toContain(">—</span>");
  const known = render({ ...history, players: [{ steam_id: "1", ticks: [0], indices: [0] }] });
  expect(combatCell(known, "tbody")).toContain(">0%</span>");
  expect(combatCell(known, "tfoot")).toBe("0%");
});

test("heatmap stat headings are uppercase with OUTN directly after CBT", () => {
  const html = render(history);
  const head = html.match(/<thead[\s\S]*?<\/thead>/)![0];
  const headers = [...head.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]*>/g, ""));
  expect(headers).toEqual(["HERO", "HALF SPLIT", "PTRN", "CBT", "OUTN", "DIST"]);
});

test("heatmap OUTN shows seconds for the selected hero and the whole-team average", () => {
  const roster = [...players, ...[3, 4].map((hero_id) => ({ ...players[0], hero_id, steam_id: String(hero_id), team: 3 }))];
  const rows = [replayPlayer(1, 2), replayPlayer(2, 2, { x: 4000 }), replayPlayer(3, 3), replayPlayer(4, 3)];
  const store = replayFrames([{ tick: 0, players: rows }, { tick: 64, players: rows }, { tick: 128, players: rows }]);
  const data = { ...history, players: [
    { steam_id: "1", ticks: [0, 64], indices: [1, 0] },
    { steam_id: "2", ticks: [0], indices: [1] },
    { steam_id: "3", ticks: [0], indices: [1] },
    { steam_id: "4", ticks: [0], indices: [1] },
  ] };
  const html = render(data, store, roster);
  expect(statCell(html, "tbody", 4)).toContain(">1.0s</span>");
  expect(statCell(html, "tfoot", 4)).toBe("0.5s");
  const paused = render(data, store, roster, [{ start: 16, end: 48 }]);
  expect(statCell(paused, "tbody", 4)).toContain(">0.5s</span>");
  const unknown = render({ ...data, players: [] }, store, roster);
  expect(statCell(unknown, "tbody", 4)).toContain(">—</span>");
  const known = render({ ...data, players: data.players.map((p) => ({ ...p, indices: p.indices.map(() => 0) })) }, store, roster);
  expect(statCell(known, "tbody", 4)).toContain(">0.0s</span>");
});


test("disabled status metrics show a reparse notice and unknown combat coverage", () => {
  const html = renderToStaticMarkup(<TooltipProvider><HeatmapView players={players} frames={frames} statuses={new StatusStore(history)} killEvents={[]} abilityEvents={[]} objectives={[]} objectiveEvents={[]} pauseIntervals={[]} modifiersEnabled={false} onEnableModifiers={() => {}} /></TooltipProvider>);
  expect(html).toContain("Combat time and outnumbered combat need recorded statuses.");
  expect(html).toContain("Enable statuses/modifiers and reparse");
  expect(combatCell(html, "tbody")).toContain(">—</span>");
});
