import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_EVENT_VISIBILITY,
  probabilityEvents,
} from "../../src/lib/win-probability-events";
import { ProbabilityEventTooltip } from "../../src/components/win-probability-event-tooltip";
import { WinProbabilityEventControls } from "../../src/components/win-probability-event-controls";
import { TimelinePanel } from "../../src/components/timeline-panel";
import type { MatchSummary } from "../../src/wasm/boon";
import { WinProbabilityCard } from "../../src/components/win-probability-card";
import { WinProbabilityChart } from "../../src/components/win-probability-chart";
import type { PlayerInfo } from "../../src/components/player-roster";
import type { ObjectiveEvent } from "../../src/components/map-view";
const players: PlayerInfo[] = [
  {
    hero_id: 1,
    hero_name: "Seven",
    name: "A",
    steam_id: "1",
    team: 3,
    rank: 0,
  },
  {
    hero_id: 2,
    hero_name: "Kelvin",
    name: "B",
    steam_id: "2",
    team: 2,
    rank: 0,
  },
];
const objective = (
  kind: ObjectiveEvent["kind"],
  action: ObjectiveEvent["action"],
  tick: number,
  team = 2,
): ObjectiveEvent => ({
  kind,
  action,
  tick,
  team,
  killer_hero_id: 1,
  x: 0,
  y: 0,
});
const events = probabilityEvents(
  players,
  [{ tick: 20, attacker_hero_id: 1, victim_hero_id: 2, x: 0, y: 0 }],
  [
    objective("walker", "destroyed", 10),
    objective("patron", "phase_one_destroyed", 30, 3),
    objective("mid_boss", "killed", 40, -1),
    objective("mid_boss", "spawns", 5),
    objective("urn", "picked_up", 15),
  ],
);

test("markers use the objective owner and death team, with explicit Mid Boss handling", () => {
  expect(events.map((e) => e.tick)).toEqual([10, 20, 30, 40]);
  expect(events.map((e) => e.kind)).toEqual([
    "objective",
    "death",
    "objective",
    "mid_boss",
  ]);
  expect(events[0].team).toBe(2);
  expect(events[1].team).toBe(2);
  expect(events[2].title).toContain("first phase");
  expect(events[3].team).toBeNull();
  expect(events[1].detail).toContain("Seven — A (Archmother)");
  expect(events[1].detail).toContain("Kelvin — B (Hidden King)");
});
test("unknown actors do not invent team ownership or an attacker", () => {
  const marker = probabilityEvents(
    [],
    [{ tick: 10, attacker_hero_id: 0, victim_hero_id: 99, x: 0, y: 0 }],
    [],
  )[0];
  expect(marker.team).toBeNull();
  expect(marker.detail).toContain("Unknown/non-player");
});
test("full and mini timelines both support solid objective/Mid Boss lines and dotted deaths", () => {
  const render = (compact = false) =>
    renderToStaticMarkup(
      <WinProbabilityChart
        compact={compact}
        events={events}
        points={[{ tick: 0, seconds: 0, archmother: 0.5 }]}
        complete
        currentTick={0}
        firstTick={0}
        lastTick={100}
        onSeek={() => {}}
        formatTick={String}
      />,
    );
  const html = render();
  expect(html.match(/data-timeline-event=/g)).toHaveLength(4);
  expect(html).toContain("dotted #5b8df7");
  expect(html).toContain("solid #5b8df7");
  expect(html).toContain("solid #e0b84a");
  expect(html).toContain("Mid Boss killed");
  const mini = render(true);
  expect(mini.match(/data-timeline-event=/g)).toHaveLength(4);
  expect(mini).toContain("dotted #5b8df7");
  expect(mini).toContain("solid #5b8df7");
  expect(mini).toContain("solid #e0b84a");
  expect(mini).not.toContain('role="tooltip"');
});

test("event controls expose independent pressed states and default to less clutter", () => {
  expect(DEFAULT_EVENT_VISIBILITY).toEqual({
    death: false,
    objective: true,
    mid_boss: true,
  });
  const html = renderToStaticMarkup(
    <WinProbabilityEventControls
      value={DEFAULT_EVENT_VISIBILITY}
      onChange={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Timeline event markers"');
  expect(html).toContain('aria-pressed="false" aria-label="Show player kills"');
  expect(html).toContain(
    'aria-pressed="true" aria-label="Hide objective kills"',
  );
  expect(html).toContain('aria-pressed="true" aria-label="Hide mid boss"');
  for (const icon of ["lucide-crosshair", "lucide-castle", "lucide-skull"])
    expect(html).toContain(icon);
});

test("death tooltips separate the victim and killer identities and colors", () => {
  const event = events[1];
  if (event.kind !== "death") throw new Error("Expected death marker");
  expect(event.victim).toBe(players[1]);
  expect(event.killer).toBe(players[0]);
  const html = renderToStaticMarkup(
    <ProbabilityEventTooltip event={event} formatTick={String} />,
  );
  expect(html).toContain('style="color:#5b8df7" data-event-row="victim"');
  expect(html).toContain('style="color:#e08438" data-event-row="killer"');
  expect(html).toContain("lucide-skull");
  expect(html).toContain("lucide-crosshair");
  expect(html).toContain("Kelvin — B (Hidden King)");
  expect(html).toContain("Seven — A (Archmother)");
  expect(html.match(/<img /g)).toHaveLength(2);
});

test("objective and Mid Boss tooltips show the correct icon and killing team", () => {
  const walker = renderToStaticMarkup(
    <ProbabilityEventTooltip event={events[0]} formatTick={String} />,
  );
  expect(walker).toContain("lucide-bomb");
  expect(walker).toContain("lucide-castle");
  expect(walker).toContain("Walker");
  expect(walker).toContain("Destroyed by");
  expect(walker).toContain('style="color:#e08438" data-event-row="killer"');
  expect(walker.match(/<img /g)).toHaveLength(1);
  const phase = renderToStaticMarkup(
    <ProbabilityEventTooltip event={events[2]} formatTick={String} />,
  );
  expect(phase).toContain("Patron · first phase");
  const midBoss = renderToStaticMarkup(
    <ProbabilityEventTooltip event={events[3]} formatTick={String} />,
  );
  expect(midBoss).toContain("40 · Mid Boss killed");
  expect(midBoss).toContain("Killed by");
  expect(midBoss).toContain('style="color:#e08438" data-event-row="killer"');
  expect(midBoss.match(/<img /g)).toHaveLength(1);
});

test("unknown killers have a neutral tooltip without an invented portrait", () => {
  const [event] = probabilityEvents(
    [],
    [],
    [{ ...objective("guardian", "destroyed", 10), killer_hero_id: 0 }],
  );
  const html = renderToStaticMarkup(
    <ProbabilityEventTooltip event={event} formatTick={String} />,
  );
  expect(html).toContain("Unknown/non-player");
  expect(html).toContain('style="color:#94a3b8" data-event-row="killer"');
  expect(html).not.toContain("<img");
});

test("the full probability panel applies its default event visibility", () => {
  const html = renderToStaticMarkup(
    <TimelinePanel
      enabled
      onEnabledChange={() => {}}
      probability={{
        enabled: true,
        points: [{ tick: 0, seconds: 0, archmother: 0.5 }],
        progress: null,
      }}
      onRetry={() => {}}
      players={players}
      summary={{} as MatchSummary}
      killEvents={[
        { tick: 20, attacker_hero_id: 1, victim_hero_id: 2, x: 0, y: 0 },
      ]}
      objectiveEvents={[
        objective("walker", "destroyed", 10),
        objective("mid_boss", "killed", 40),
      ]}
      currentTick={0}
      firstTick={0}
      lastTick={100}
      onSeek={() => {}}
      formatTick={String}
    />,
  );
  expect(html).not.toContain('data-timeline-event="death"');
  expect(html).toContain('data-timeline-event="objective"');
  expect(html).toContain('data-timeline-event="mid_boss"');
});

test("the Live card supplies its events, default filters and compact accessible controls", () => {
  const html = renderToStaticMarkup(
    <WinProbabilityCard
      probability={{
        enabled: true,
        points: [{ tick: 0, seconds: 0, archmother: 0.5 }],
        progress: null,
      }}
      players={players}
      killEvents={[
        { tick: 20, attacker_hero_id: 1, victim_hero_id: 2, x: 0, y: 0 },
      ]}
      objectiveEvents={[
        objective("walker", "destroyed", 10),
        objective("mid_boss", "killed", 40),
        objective("guardian", "destroyed", 200),
      ]}
      onRetry={() => {}}
      currentTick={0}
      firstTick={0}
      lastTick={100}
      onSeek={() => {}}
      formatTick={String}
    />,
  );
  expect(html).toContain('aria-label="Live win probability"');
  expect(html).toContain('aria-label="Show player kills"');
  expect(html).toContain('aria-label="Hide objective kills"');
  expect(html).toContain('aria-label="Hide mid boss"');
  expect(html).toContain('class="sr-only">Player kills');
  expect(html.match(/data-timeline-event=/g)).toHaveLength(2);
  expect(html).not.toContain('data-timeline-event="death"');
  expect(html).toContain('data-timeline-event="objective"');
  expect(html).toContain('data-timeline-event="mid_boss"');
});
