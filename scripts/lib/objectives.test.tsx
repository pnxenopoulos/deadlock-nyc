import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MapView, ObjectiveNode, type ObjectiveHealthEvent, type ObjectiveInfo } from "../../src/components/map-view";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { objectivesAt } from "../../src/lib/objectives";

const patron: ObjectiveInfo = {
  id: 1920, kind: "patron", team: 3, x: 1280, y: 8048,
  max_health: 12000, spawn_tick: 1, death_tick: 185985,
};
const samples: ObjectiveHealthEvent[] = [
  { id: 1920, tick: 1, health: 12000, max_health: 12000, phase: 0, x: 1280, y: 8048 },
  { id: 1920, tick: 169355, health: 1, max_health: 18000, phase: 2, x: 1280, y: 8048 },
  { id: 1920, tick: 169500, health: 12500, max_health: 12500, phase: 1, x: 1280, y: 8048 },
  { id: 1920, tick: 182816, health: 13350, max_health: 13350, phase: 1, x: 1280, y: 8048 },
  { id: 1920, tick: 185985, health: 0, max_health: 13800, phase: 1, x: 1280, y: 8048 },
];

test("Patron remains on the map through transformation and phase two until final death", () => {
  expect(objectivesAt([patron], samples, 0)).toEqual([]);
  expect(objectivesAt([patron], samples, 169354)[0].phase).toBe(0);
  expect(objectivesAt([patron], samples, 169355)[0].phase).toBe(2);
  expect(objectivesAt([patron], samples, 182816)[0]).toMatchObject({ phase: 1, health: 13350 });
  expect(objectivesAt([patron], samples, 185985)).toEqual([]);
  expect(objectivesAt([patron], samples, 185984)[0].phase).toBe(1);
});

test("objective reconstruction uses recorded positions without future samples or invented phase data", () => {
  const moved = samples.map((sample) => sample.phase === 1 ? { ...sample, x: 1000, y: 7000 } : sample);
  expect(objectivesAt([patron], moved, 169355)[0]).toMatchObject({ x: 1280, y: 8048 });
  expect(objectivesAt([patron], moved, 169500)[0]).toMatchObject({ x: 1000, y: 7000 });
  const old = objectivesAt([patron], [{ id: 1920, tick: 1, health: 50, max_health: 100 }], 2)[0];
  expect(old).toMatchObject({ x: 1280, y: 8048, health: 50, max_health: 100 });
  expect(old.phase).toBeUndefined();
});

test("Patron rings distinguish phase-one health, pending phase two, and active phase-two health", () => {
  const render = (phase: number) => renderToStaticMarkup(<svg><ObjectiveNode objective={{
    kind: "patron", x: 0, y: 0, health: 50, max_health: 100, color: "#fbbf24", phase,
  }} /></svg>);
  const first = render(0);
  const activeRings = (html: string) => [...html.matchAll(/r="(\d+)"[^>]*transform="rotate\(-90\)"/g)].map((match) => match[1]);
  expect(first).toContain("Outer ring: phase 1; inner ring: phase 2 (pending)");
  expect(first).toContain('r="360" fill="none" stroke="#fbbf24"');
  expect(first.match(/data-phase-track=/g)).toHaveLength(2);
  expect(activeRings(first)).toEqual(["360"]);
  expect(first).toContain('stroke-dasharray="45 35"');
  const transition = render(2);
  expect(transition).toContain("transforming");
  expect(transition.match(/stroke-opacity=/g)).toHaveLength(2);
  expect(activeRings(transition)).toEqual([]);
  const final = render(1);
  expect(final).toContain('r="240" fill="none" stroke="#fbbf24"');
  expect(final.match(/data-phase-track=/g)).toHaveLength(2);
  expect(activeRings(final)).toEqual(["240"]);
  expect(final).not.toContain("pending");
});

test("other objectives and missing Patron phase data keep the single health ring", () => {
  for (const kind of ["walker", "patron"] as const) {
    const html = renderToStaticMarkup(<svg><ObjectiveNode objective={{
      kind, x: 0, y: 0, health: 50, max_health: 100, color: "#fbbf24",
    }} /></svg>);
    expect(html).not.toContain('r="240"');
    expect(html.match(/stroke="#fbbf24"/g)).toHaveLength(1);
  }
});

test("map displays the Patron ring legend and yellow breakable markers", () => {
  const html = renderToStaticMarkup(<TooltipProvider><MapView frame={undefined}
    objectiveStates={[{ kind: "patron", x: 0, y: 0, health: 50, max_health: 100, color: "#5b8df7", phase: 1 }]}
    breakableMarkers={[{ tick: 1, id: 7, serial: 1, subclass_name: "citadel_breakable_crate", team: 0, x: 0, y: 0, z: 1000 }]}
  /></TooltipProvider>);
  expect(html).toContain("Patron rings: outer = phase 1 · inner = phase 2");
  expect(html).toContain("Dashed = pending");
  expect(html).toContain("Crate broken");
  expect(html).toContain('stroke="#facc15"');
  expect(html).not.toContain("#fb923c");
});
