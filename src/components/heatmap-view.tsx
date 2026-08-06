import * as React from "react";
import { Crosshair, MapPin, Maximize, Skull, ZoomIn, ZoomOut } from "lucide-react";

import { AbilityIcon, prettifyAbilityName } from "@/components/ability-icon";
import {
  LAYERS,
  WORLD_MIN,
  WORLD_SIZE,
  type AbilityEvent,
  type KillEvent,
  type MapLayer,
  type ModifierSpan,
  type ObjectiveEvent,
  type ObjectiveInfo,
  type PositionFrame,
} from "@/components/map-view";
import {
  compactNumber,
  heroPortraitUrl,
  TEAM_COLORS,
  TEAM_NAMES,
  type PlayerInfo,
} from "@/components/player-roster";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { assetUrl, cn } from "@/lib/utils";
import type { FrameStore } from "@/wasm/frames";

const TICKS_PER_SECOND = 64;
// Bins per axis for the density grid (over the 21504² world square).
const GRID = 56;
const OBJECTIVE_BAR = "#e0b84a";

/** What the center density layer represents. */
type HeatMode = "presence" | "deaths" | "kills" | "casts";

const HEAT_MODES: { value: HeatMode; label: string }[] = [
  { value: "presence", label: "Presence" },
  { value: "deaths", label: "Deaths" },
  { value: "kills", label: "Kills" },
  { value: "casts", label: "Casts" },
];

// Elapsed match time (seconds from the first frame) -> m:ss.
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "#rrggbb" + alpha -> "rgba(...)" for canvas fills.
function rgba(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

// Pan is in container pixels; at zoom z the content is z× its base size, so the
// max pan that keeps the edges in view is ((z - 1) * dim) / 2.
function clampPan(
  zoom: number,
  pan: { x: number; y: number },
  width: number,
  height: number,
) {
  const maxX = ((zoom - 1) * width) / 2;
  const maxY = ((zoom - 1) * height) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

// World (x, y) -> percentage offsets on the square minimap. The world is a
// centered 21504² square; Y is flipped (world +Y is "up").
function project(x: number, y: number): { left: number; top: number } {
  return {
    left: ((x - WORLD_MIN) / WORLD_SIZE) * 100,
    top: ((WORLD_SIZE - (y - WORLD_MIN)) / WORLD_SIZE) * 100,
  };
}

// Nearest frame to a tick (frames are tick-ordered). Kill/ability events carry
// no (or only a death) position, so we look up where the hero was nearby.
function nearestFrame(
  frames: FrameStore,
  tick: number,
): PositionFrame | undefined {
  return frames.nearest(tick);
}

type Marker = {
  left: number;
  top: number;
  team: number;
  kind: "death" | "kill" | "cast";
  name?: string;
};

type Cell = { x: number; y: number; w: number }; // all 0..1

// Bin world points into a normalized density grid for the heat canvas.
function binCells(points: { x: number; y: number }[]): Cell[] {
  const grid = new Float32Array(GRID * GRID);
  let max = 0;
  for (const p of points) {
    const fx = (p.x - WORLD_MIN) / WORLD_SIZE;
    const fy = (WORLD_SIZE - (p.y - WORLD_MIN)) / WORLD_SIZE;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    const gx = Math.min(GRID - 1, Math.floor(fx * GRID));
    const gy = Math.min(GRID - 1, Math.floor(fy * GRID));
    const v = (grid[gy * GRID + gx] += 1);
    if (v > max) max = v;
  }
  if (max === 0) return [];
  const out: Cell[] = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const v = grid[gy * GRID + gx];
      if (v <= 0) continue;
      // Gamma < 1 lifts sparse cells so they stay visible next to hotspots.
      out.push({ x: (gx + 0.5) / GRID, y: (gy + 0.5) / GRID, w: (v / max) ** 0.6 });
    }
  }
  return out;
}

const pctDelta = (n: number) => `${Math.round(n)}%`;
const avgOf = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// A signed delta vs the team average — green when above, red when below.
function Delta({
  value,
  avg,
  fmt,
}: {
  value: number;
  avg: number | null;
  fmt: (n: number) => string;
}) {
  if (avg == null) return null;
  const d = value - avg;
  return (
    <span className={d >= 0 ? "text-emerald-500" : "text-red-500"}>
      {d >= 0 ? "+" : "−"}
      {fmt(Math.abs(d))}
    </span>
  );
}

// A right-aligned numeric stat cell; hovering shows its delta vs the team avg.
function StatCell({
  display,
  value,
  avg,
  label,
  fmt,
}: {
  display: string;
  value: number | null;
  avg: number | null;
  label: string;
  fmt: (n: number) => string;
}) {
  return (
    <td className="px-1.5 py-1 text-right">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default">{display}</span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-medium">{label}</span>
          {value != null && avg != null && (
            <>
              {" · "}
              <Delta value={value} avg={avg} fmt={fmt} /> vs avg
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

export function HeatmapView({
  players,
  killEvents,
  abilityEvents,
  frames,
  objectives,
  objectiveEvents,
  modifierSpans,
}: {
  players: PlayerInfo[];
  killEvents: KillEvent[];
  abilityEvents: AbilityEvent[];
  frames: FrameStore;
  objectives: ObjectiveInfo[];
  objectiveEvents: ObjectiveEvent[];
  modifierSpans: ModifierSpan[];
}) {
  const [selected, setSelected] = React.useState<Set<number>>(
    () => new Set(players[0] ? [players[0].hero_id] : []),
  );
  const [mode, setMode] = React.useState<HeatMode>("presence");
  const [layer, setLayer] = React.useState<MapLayer>("surface");
  const [showMarkers, setShowMarkers] = React.useState(true);
  const [hiddenAbilities, setHiddenAbilities] = React.useState<Set<string>>(
    () => new Set(),
  );

  // Drop hero ids that no longer exist (new demo); default to the first hero.
  React.useEffect(() => {
    setSelected((prev) => {
      const valid = [...prev].filter((id) =>
        players.some((p) => p.hero_id === id),
      );
      if (valid.length === prev.size) return prev; // unchanged — no churn
      return new Set(valid.length ? valid : players[0] ? [players[0].hero_id] : []);
    });
  }, [players]);

  const singleHero = selected.size === 1 ? [...selected][0] : null;
  React.useEffect(() => setHiddenAbilities(new Set()), [singleHero]);

  // Match-time bounds (frames are tick-ordered) and the selected window.
  const minTick = frames.tickAt(0) ?? 0;
  const maxTick = frames.tickAt(frames.length - 1) ?? 0;
  const [range, setRange] = React.useState<[number, number]>([minTick, maxTick]);
  React.useEffect(() => setRange([minTick, maxTick]), [minTick, maxTick]);
  const fullRange = range[0] <= minTick && range[1] >= maxTick;

  const teamByHero = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const p of players) m.set(p.hero_id, p.team);
    return m;
  }, [players]);

  // Patron (base) position per team — drives the half split and the
  // distance stat. The midline is their perpendicular bisector.
  const patrons = React.useMemo(() => {
    const m = new Map<number, { x: number; y: number }>();
    for (const o of objectives) {
      if (o.kind === "patron" && !m.has(o.team)) m.set(o.team, { x: o.x, y: o.y });
    }
    return m;
  }, [objectives]);

  // ----- Pan/zoom (mirrors the map view) -----
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [dragging, setDragging] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const zoomRef = React.useRef(zoom);
  const panRef = React.useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const resetZoom = React.useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Button zoom, centered on the map (pan scales about the center).
  const zoomBy = React.useCallback((factor: number) => {
    const prev = zoomRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * factor));
    if (next === prev) return;
    const el = containerRef.current;
    setZoom(next);
    if (el) {
      const rect = el.getBoundingClientRect();
      const ratio = next / prev;
      setPan(
        clampPan(
          next,
          { x: panRef.current.x * ratio, y: panRef.current.y * ratio },
          rect.width,
          rect.height,
        ),
      );
    }
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const prevZoom = zoomRef.current;
      const prevPan = panRef.current;
      const next = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, prevZoom * Math.exp(-e.deltaY * 0.0015)),
      );
      if (next === prevZoom) return;
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = next / prevZoom;
      setZoom(next);
      setPan(
        clampPan(
          next,
          { x: cx - (cx - prevPan.x) * ratio, y: cy - (cy - prevPan.y) * ratio },
          rect.width,
          rect.height,
        ),
      );
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);

  function handlePointerDown(e: React.PointerEvent) {
    if (zoom <= 1) return;
    if (e.target instanceof Element && e.target.closest("button")) return;
    const el = containerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startPan: pan,
    };
    setDragging(true);
  }
  function handlePointerMove(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPan(
      clampPan(
        zoom,
        {
          x: s.startPan.x + (e.clientX - s.startX),
          y: s.startPan.y + (e.clientY - s.startY),
        },
        rect.width,
        rect.height,
      ),
    );
  }
  function endDrag(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    containerRef.current?.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
  }

  // ----- Density points + event markers for the active mode -----
  // Density points grouped by team, so each team's heat is drawn in its own
  // color (selecting heroes from both teams plots them separately, never mixed).
  const { pointsByTeam, markers } = React.useMemo(() => {
    const pts = new Map<number, { x: number; y: number }[]>();
    const add = (team: number, x: number, y: number) => {
      let arr = pts.get(team);
      if (!arr) pts.set(team, (arr = []));
      arr.push({ x, y });
    };
    const mk: Marker[] = [];
    const [lo, hi] = range;
    if (mode === "presence") {
      for (let i = 0; i < frames.length; i++) {
        const tick = frames.tickAt(i) ?? 0;
        if (tick < lo || tick > hi) continue;
        frames.forEachPlayerAt(i, (p) => {
          if (!selected.has(p.hero_id) || !p.alive) return;
          if (p.z < 0 !== (layer === "tunnels")) return; // match the layer
          add(p.team, p.x, p.y);
        });
      }
    } else if (mode === "deaths") {
      for (const k of killEvents) {
        if (k.tick < lo || k.tick > hi || !selected.has(k.victim_hero_id)) continue;
        const team = teamByHero.get(k.victim_hero_id) ?? 0;
        add(team, k.x, k.y);
        mk.push({ ...project(k.x, k.y), team, kind: "death" });
      }
    } else if (mode === "kills") {
      for (const k of killEvents) {
        if (k.tick < lo || k.tick > hi || !selected.has(k.attacker_hero_id))
          continue;
        const pos = nearestFrame(frames, k.tick)?.players.find(
          (p) => p.hero_id === k.attacker_hero_id,
        );
        if (!pos) continue;
        const team = teamByHero.get(k.attacker_hero_id) ?? 0;
        add(team, pos.x, pos.y);
        mk.push({ ...project(pos.x, pos.y), team, kind: "kill" });
      }
    } else {
      for (const e of abilityEvents) {
        if (e.tick < lo || e.tick > hi || !selected.has(e.hero_id)) continue;
        if (singleHero != null && hiddenAbilities.has(e.ability_name)) continue;
        const pos = nearestFrame(frames, e.tick)?.players.find(
          (p) => p.hero_id === e.hero_id,
        );
        if (!pos) continue;
        const team = teamByHero.get(e.hero_id) ?? 0;
        add(team, pos.x, pos.y);
        mk.push({ ...project(pos.x, pos.y), team, kind: "cast", name: e.ability_name });
      }
    }
    return { pointsByTeam: pts, markers: mk };
  }, [
    mode,
    selected,
    range,
    layer,
    frames,
    killEvents,
    abilityEvents,
    teamByHero,
    singleHero,
    hiddenAbilities,
  ]);

  // One normalized heat layer per team (each in its team color).
  const cellsByTeam = React.useMemo(() => {
    const out: { team: number; color: string; cells: Cell[] }[] = [];
    for (const [team, pts] of pointsByTeam) {
      const cells = binCells(pts);
      if (cells.length) out.push({ team, color: TEAM_COLORS[team] ?? "#888", cells });
    }
    return out;
  }, [pointsByTeam]);

  // Per-ability cast counts (single hero only) for the Casts filter chips.
  const abilityKinds = React.useMemo(() => {
    if (mode !== "casts" || singleHero == null) return [];
    const counts = new Map<string, number>();
    for (const e of abilityEvents) {
      if (e.hero_id !== singleHero || e.tick < range[0] || e.tick > range[1])
        continue;
      counts.set(e.ability_name, (counts.get(e.ability_name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [mode, singleHero, abilityEvents, range]);

  // Per-hero movement stats over the window: distance covered (alive-to-alive,
  // so respawn teleports don't inflate it), the half split, and average
  // distance to own Patron (the latter two only when Patrons are known).
  type HeroStat = {
    half: { own: number; mid: number; enemy: number; avgDistPct: number } | null;
    distance: number;
  };
  const heroStats = React.useMemo(() => {
    const [lo, hi] = range;
    const hasPatrons = patrons.size >= 2;
    let mapLen = 1;
    if (hasPatrons) {
      const [a, b] = [...patrons.values()];
      mapLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    }
    type Acc = {
      own: number;
      mid: number;
      enemy: number;
      distSum: number;
      n: number;
      distance: number;
      prev?: { x: number; y: number; alive: boolean };
    };
    const acc = new Map<number, Acc>();
    for (const p of players)
      acc.set(p.hero_id, { own: 0, mid: 0, enemy: 0, distSum: 0, n: 0, distance: 0 });
    for (let i = 0; i < frames.length; i++) {
      const tick = frames.tickAt(i) ?? 0;
      if (tick < lo || tick > hi) continue;
      frames.forEachPlayerAt(i, (p) => {
        const a = acc.get(p.hero_id);
        if (!a) return;
        if (a.prev && a.prev.alive && p.alive) {
          a.distance += Math.hypot(p.x - a.prev.x, p.y - a.prev.y);
        }
        a.prev = { x: p.x, y: p.y, alive: p.alive };
        if (!p.alive || !hasPatrons) return;
        const ownP = patrons.get(p.team);
        const enemyP = patrons.get(p.team === 2 ? 3 : 2);
        if (!ownP || !enemyP) return;
        const ax = enemyP.x - ownP.x;
        const ay = enemyP.y - ownP.y;
        const len2 = ax * ax + ay * ay || 1;
        const t = Math.max(
          0,
          Math.min(1, ((p.x - ownP.x) * ax + (p.y - ownP.y) * ay) / len2),
        );
        if (t < 0.42) a.own++;
        else if (t > 0.58) a.enemy++;
        else a.mid++;
        a.distSum += Math.hypot(p.x - ownP.x, p.y - ownP.y);
        a.n++;
      });
    }
    const out = new Map<number, HeroStat>();
    for (const [id, a] of acc) {
      const total = a.own + a.mid + a.enemy;
      out.set(id, {
        distance: a.distance,
        half:
          hasPatrons && total > 0
            ? {
                own: (a.own / total) * 100,
                mid: (a.mid / total) * 100,
                enemy: (a.enemy / total) * 100,
                avgDistPct: (a.distSum / a.n / mapLen) * 100,
              }
            : null,
      });
    }
    return out;
  }, [patrons, frames, players, range]);

  // Time in combat per hero: share of the window flagged in-combat (the
  // `modifier_combat_status` span). Null when the window is empty.
  const combatByHero = React.useMemo(() => {
    const [lo, hi] = range;
    const windowTicks = hi - lo;
    const m = new Map<number, number | null>();
    for (const { hero_id: id } of players) {
      if (windowTicks <= 0) {
        m.set(id, null);
        continue;
      }
      let inCombat = 0;
      for (const s of modifierSpans) {
        if (s.hero_id !== id || !s.modifier_name.includes("combat_status")) continue;
        const ov = Math.min(hi, s.end_tick ?? maxTick) - Math.max(lo, s.start_tick);
        if (ov > 0) inCombat += ov;
      }
      m.set(id, (Math.min(windowTicks, inCombat) / windowTicks) * 100);
    }
    return m;
  }, [modifierSpans, players, range, maxTick]);

  // Vertical event bars for the timeline brush: kills (victim-team colored) and
  // objective falls (gold).
  const timelineEvents = React.useMemo(() => {
    const out: { tick: number; color: string }[] = [];
    for (const k of killEvents) {
      out.push({
        tick: k.tick,
        color: rgba(TEAM_COLORS[teamByHero.get(k.victim_hero_id) ?? 0] ?? "#888", 0.85),
      });
    }
    for (const o of objectiveEvents) out.push({ tick: o.tick, color: OBJECTIVE_BAR });
    return out;
  }, [killEvents, objectiveEvents, teamByHero]);

  const toggleHero = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const renderHero = (p: PlayerInfo) => {
    const on = selected.has(p.hero_id);
    const portrait = heroPortraitUrl(p.hero_id);
    return (
      <Tooltip key={p.hero_id}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => toggleHero(p.hero_id)}
            aria-label={p.hero_name}
            aria-pressed={on}
            className={cn(
              "aspect-square min-w-0 flex-1 overflow-hidden rounded transition-opacity",
              on ? "opacity-100" : "opacity-40 hover:opacity-80",
            )}
            style={
              on ? { boxShadow: `0 0 0 2px ${TEAM_COLORS[p.team]}` } : undefined
            }
          >
            {portrait ? (
              <img
                src={portrait}
                alt={p.hero_name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full bg-muted" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{p.hero_name}</TooltipContent>
      </Tooltip>
    );
  };

  const emptyNote =
    selected.size === 0
      ? "Select one or more heroes."
      : cellsByTeam.length === 0 && markers.length === 0
        ? "No data to plot for this selection in this window."
        : null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      {/* Top: left stats · center map · right controls. The rails grow to fill
          the width up to the page edges; the center stays a height-bound square. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-3">
        {/* Left rail — per-hero spatial stats, grouped by team so they compare
            side by side and never mix opposing teams. */}
        <aside className="flex min-w-[14rem] flex-1 flex-col gap-2 overflow-y-auto pr-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Spatial
          </h3>
          {selected.size === 0 ? (
            <p className="text-xs text-muted-foreground">
              Select one or more heroes.
            </p>
          ) : (
            [3, 2].map((team) => {
              const teamHeroes = players.filter(
                (p) => p.team === team && selected.has(p.hero_id),
              );
              if (teamHeroes.length === 0) return null;
              const rows = teamHeroes.map((p) => ({
                p,
                hs: heroStats.get(p.hero_id),
                cb: combatByHero.get(p.hero_id) ?? null,
              }));
              // Reference = the whole team's average for this window, so the
              // per-hero deltas are meaningful even with a single hero selected.
              const teamAll = players.filter((q) => q.team === team);
              const halves = teamAll
                .map((q) => heroStats.get(q.hero_id)?.half)
                .filter(
                  (h): h is { own: number; mid: number; enemy: number; avgDistPct: number } =>
                    h != null,
                );
              const combats = teamAll
                .map((q) => combatByHero.get(q.hero_id) ?? null)
                .filter((v): v is number => v != null);
              const avg = {
                own: avgOf(halves.map((h) => h.own)),
                mid: avgOf(halves.map((h) => h.mid)),
                enemy: avgOf(halves.map((h) => h.enemy)),
                ptrn: avgOf(halves.map((h) => h.avgDistPct)),
                cbt: avgOf(combats),
                dist: avgOf(teamAll.map((q) => heroStats.get(q.hero_id)?.distance ?? 0)),
              };
              return (
                <div key={team} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: TEAM_COLORS[team] }}
                    />
                    {TEAM_NAMES[team]}
                  </div>
                  <div className="overflow-hidden rounded-md border border-border bg-card">
                    <table className="w-full text-[11px] tabular-nums">
                      <thead className="bg-muted text-[10px] text-muted-foreground">
                        <tr>
                          <th className="px-1.5 py-1 text-left font-medium">Hero</th>
                          {[
                            { k: "half", label: "Half split", title: "Half split — own / mid / enemy half" },
                            { k: "ptrn", label: "Ptrn", title: "Avg distance to your Patron (% of map)" },
                            { k: "cbt", label: "Cbt", title: "Time in combat (% of window)" },
                            { k: "dist", label: "Dist", title: "Distance covered (world units)" },
                          ].map((c) => (
                            <th key={c.k} className="px-1.5 py-1 text-right font-medium">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-default">{c.label}</span>
                                </TooltipTrigger>
                                <TooltipContent>{c.title}</TooltipContent>
                              </Tooltip>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({ p, hs, cb }) => {
                          const portrait = heroPortraitUrl(p.hero_id);
                          return (
                            <tr key={p.hero_id} className="border-t border-border">
                              <td className="px-1.5 py-1">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    {portrait ? (
                                      <img
                                        src={portrait}
                                        alt={p.hero_name}
                                        className="size-7 rounded object-cover"
                                      />
                                    ) : (
                                      <div className="size-7 rounded bg-muted" />
                                    )}
                                  </TooltipTrigger>
                                  <TooltipContent>{p.hero_name}</TooltipContent>
                                </Tooltip>
                              </td>
                              <td className="px-1.5 py-1">
                                {hs?.half ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="ml-auto flex h-3 w-24 overflow-hidden rounded">
                                        <div style={{ width: `${hs.half.own}%`, backgroundColor: "#34d399" }} />
                                        <div style={{ width: `${hs.half.mid}%`, backgroundColor: "#64748b" }} />
                                        <div style={{ width: `${hs.half.enemy}%`, backgroundColor: "#fb7185" }} />
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <div className="space-y-0.5">
                                        {[
                                          { label: "Own", v: hs.half.own, a: avg.own },
                                          { label: "Mid", v: hs.half.mid, a: avg.mid },
                                          { label: "Enemy", v: hs.half.enemy, a: avg.enemy },
                                        ].map((z) => (
                                          <div
                                            key={z.label}
                                            className="flex items-center justify-between gap-3"
                                          >
                                            <span>{z.label}</span>
                                            <span className="tabular-nums">
                                              {Math.round(z.v)}%{" "}
                                              <Delta value={z.v} avg={z.a} fmt={pctDelta} />
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className="block text-right text-muted-foreground">—</span>
                                )}
                              </td>
                              <StatCell
                                display={hs?.half ? `${Math.round(hs.half.avgDistPct)}%` : "—"}
                                value={hs?.half?.avgDistPct ?? null}
                                avg={avg.ptrn}
                                label="Avg dist to Patron"
                                fmt={pctDelta}
                              />
                              <StatCell
                                display={cb == null ? "—" : `${Math.round(cb)}%`}
                                value={cb}
                                avg={avg.cbt}
                                label="Time in combat"
                                fmt={pctDelta}
                              />
                              <StatCell
                                display={compactNumber(Math.round(hs?.distance ?? 0))}
                                value={hs?.distance ?? null}
                                avg={avg.dist}
                                label="Distance covered"
                                fmt={(n) => compactNumber(Math.round(n))}
                              />
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                          <tr className="border-t border-border bg-muted/40 font-medium">
                            <td className="px-1.5 py-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                              Team
                            </td>
                            <td className="px-1.5 py-1">
                              {avg.own != null ? (
                                <div className="ml-auto flex h-3 w-24 overflow-hidden rounded opacity-90">
                                  <div style={{ width: `${avg.own}%`, backgroundColor: "#34d399" }} />
                                  <div style={{ width: `${avg.mid}%`, backgroundColor: "#64748b" }} />
                                  <div style={{ width: `${avg.enemy}%`, backgroundColor: "#fb7185" }} />
                                </div>
                              ) : (
                                <span className="block text-right text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-1.5 py-1 text-right">
                              {avg.ptrn != null ? `${Math.round(avg.ptrn)}%` : "—"}
                            </td>
                            <td className="px-1.5 py-1 text-right">
                              {avg.cbt != null ? `${Math.round(avg.cbt)}%` : "—"}
                            </td>
                            <td className="px-1.5 py-1 text-right">
                              {avg.dist != null ? compactNumber(Math.round(avg.dist)) : "—"}
                            </td>
                          </tr>
                        </tfoot>
                    </table>
                  </div>
                </div>
              );
            })
          )}
        </aside>

        {/* Center — heat canvas. Mirrors the map view: a height-bound square
            with the header (modes left, layer right) stretched directly above
            it. The square's `h-full` width drives the column, so the header
            tracks the map and the rails sit snug against it. */}
        <div className="flex h-full min-h-0 flex-col items-stretch gap-2">
          <div className="flex flex-shrink-0 items-center gap-2">
            <Tabs value={mode} onValueChange={(v) => setMode(v as HeatMode)}>
              <TabsList className="h-7">
                {HEAT_MODES.map((m) => (
                  <TabsTrigger key={m.value} value={m.value} className="px-2 text-xs">
                    {m.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs
              value={layer}
              onValueChange={(v) => setLayer(v as MapLayer)}
              className="ml-auto flex-shrink-0"
            >
              <TabsList className="h-7">
                <TabsTrigger value="surface" className="px-2 text-xs">
                  Surface
                </TabsTrigger>
                <TabsTrigger value="tunnels" className="px-2 text-xs">
                  Tunnels
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

            <div
              ref={containerRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className={cn(
                "relative aspect-square h-full max-h-full max-w-full touch-none select-none overflow-hidden rounded-lg border border-border bg-card",
                zoom > 1 && (dragging ? "cursor-grabbing" : "cursor-grab"),
              )}
            >
              <div
                className="absolute inset-0"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center center",
                }}
              >
                {(Object.keys(LAYERS) as MapLayer[]).map((key) => (
                  <img
                    key={key}
                    src={assetUrl(LAYERS[key].src)}
                    alt={`Deadlock minimap (${key})`}
                    width={1024}
                    height={1024}
                    className={cn(
                      "absolute inset-0 h-full w-full object-contain transition-opacity",
                      key === layer ? "opacity-100" : "opacity-0",
                    )}
                    draggable={false}
                  />
                ))}

                {cellsByTeam.map((d) => (
                  <DensityCanvas key={d.team} cells={d.cells} color={d.color} />
                ))}

                {/* Event markers (counter-scaled by 1/zoom to keep a constant
                    on-screen size as the map scales). */}
                {showMarkers &&
                  markers.map((m, i) => {
                    const color = TEAM_COLORS[m.team] ?? "#888";
                    const pos = {
                      left: `${m.left}%`,
                      top: `${m.top}%`,
                      transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                    } as const;
                    if (m.kind === "cast") {
                      return (
                        <div
                          key={i}
                          className="pointer-events-none absolute flex size-5 items-center justify-center rounded-full border shadow"
                          style={{
                            ...pos,
                            borderColor: color,
                            backgroundColor: "rgba(12,15,17,0.78)",
                          }}
                        >
                          <AbilityIcon name={m.name!} size={13} />
                        </div>
                      );
                    }
                    const Icon = m.kind === "kill" ? Crosshair : Skull;
                    return (
                      <Icon
                        key={i}
                        className="pointer-events-none absolute size-[18px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
                        style={{ ...pos, color }}
                        strokeWidth={2.25}
                      />
                    );
                  })}
              </div>

              {emptyNote && (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-muted-foreground">
                  {emptyNote}
                </div>
              )}

              {/* Marker visibility toggle (event modes only), overlaid top-left
                  like the map view's layer toggles. */}
              {mode !== "presence" && (
                <button
                  type="button"
                  onClick={() => setShowMarkers((v) => !v)}
                  aria-pressed={showMarkers}
                  title={showMarkers ? "Hide markers" : "Show markers"}
                  className={cn(
                    "absolute top-2 left-2 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium shadow-sm backdrop-blur transition-colors",
                    showMarkers
                      ? "bg-background/80 text-foreground hover:bg-background"
                      : "bg-background/40 text-muted-foreground/70 hover:bg-background/60",
                  )}
                >
                  <MapPin className="size-3.5" />
                  Markers
                </button>
              )}

              {/* Zoom controls (scroll-to-zoom still works too). */}
              <div className="absolute top-2 right-2 flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => zoomBy(1.4)}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                  title="Zoom in"
                  className="rounded-md border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ZoomIn className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => zoomBy(1 / 1.4)}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                  title="Zoom out"
                  className="rounded-md border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ZoomOut className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={resetZoom}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Reset zoom"
                  title="Reset zoom"
                  className="rounded-md border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Maximize className="size-4" />
                </button>
              </div>
            </div>
        </div>

        {/* Right rail — controls. */}
        <aside className="flex min-w-[14rem] flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Heroes
              </h3>
              <div className="flex flex-wrap items-center justify-end gap-1 text-[10px]">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(players.map((p) => p.hero_id)))}
                  className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                >
                  All
                </button>
                {[3, 2].map((team) =>
                  players.some((p) => p.team === team) ? (
                    <button
                      key={team}
                      type="button"
                      onClick={() =>
                        setSelected(
                          new Set(
                            players.filter((p) => p.team === team).map((p) => p.hero_id),
                          ),
                        )
                      }
                      className="flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: TEAM_COLORS[team] }}
                      />
                      {TEAM_NAMES[team]}
                    </button>
                  ) : null,
                )}
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                >
                  Clear
                </button>
              </div>
            </div>
            {/* One row per team, mirroring the map-view rosters. */}
            <div className="flex flex-col gap-1.5">
              {[3, 2].map((team) =>
                players.some((p) => p.team === team) ? (
                  <div key={team} className="flex items-center gap-1.5">
                    <span
                      className="size-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: TEAM_COLORS[team] }}
                      aria-hidden
                    />
                    <div className="flex flex-1 gap-1">
                      {players
                        .filter((p) => p.team === team)
                        .map((p) => renderHero(p))}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
          </section>

          {(mode === "presence" || mode === "casts") && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Display
            </h3>
            {mode === "presence" && (
              <p className="text-[11px] text-muted-foreground">
                Presence shows time-on-map density (surface/tunnels honored). Pick
                Deaths, Kills or Casts to plot events.
              </p>
            )}

            {mode === "casts" && singleHero != null && abilityKinds.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Abilities
                  </span>
                  <div className="flex gap-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setHiddenAbilities(new Set())}
                      className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setHiddenAbilities(new Set(abilityKinds.map((a) => a.name)))
                      }
                      className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                {abilityKinds.map(({ name, count }) => {
                  const hidden = hiddenAbilities.has(name);
                  return (
                    <Tooltip key={name}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-pressed={!hidden}
                          onClick={() =>
                            setHiddenAbilities((prev) => {
                              const next = new Set(prev);
                              next.has(name) ? next.delete(name) : next.add(name);
                              return next;
                            })
                          }
                          className={cn(
                            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors",
                            hidden
                              ? "border-border bg-transparent text-muted-foreground opacity-50"
                              : "border-border bg-muted/40 text-foreground",
                          )}
                        >
                          <span
                            className="flex size-6 items-center justify-center rounded-full"
                            style={{ backgroundColor: "rgba(12,15,17,0.85)" }}
                          >
                            <AbilityIcon name={name} size={16} />
                          </span>
                          <span className="tabular-nums">{count}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{prettifyAbilityName(name)}</TooltipContent>
                    </Tooltip>
                  );
                })}
                </div>
              </div>
            )}
            {mode === "casts" && singleHero == null && (
              <p className="text-[11px] text-muted-foreground">
                Select a single hero to filter by ability.
              </p>
            )}
          </section>
          )}
        </aside>
      </div>

      {/* Bottom — time-window brush with event bars. */}
      {maxTick > minTick && (
        <div className="flex flex-shrink-0 flex-col gap-1">
          {/* Legend — what the vertical bars drawn on the brush track mean.
              Kill bars take the slain hero's team color; objectives are gold. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-11 text-[10px] text-muted-foreground">
            <span className="uppercase tracking-wide">Legend:</span>
            {[3, 2].map((team) =>
              killEvents.some(
                (k) => teamByHero.get(k.victim_hero_id) === team,
              ) ? (
                <span key={team} className="flex items-center gap-1">
                  <span
                    className="inline-block h-3 w-0.5 rounded-full"
                    style={{ backgroundColor: TEAM_COLORS[team] }}
                    aria-hidden
                  />
                  {TEAM_NAMES[team]} death
                </span>
              ) : null,
            )}
            {objectiveEvents.length > 0 && (
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-3 w-0.5 rounded-full"
                  style={{ backgroundColor: OBJECTIVE_BAR }}
                  aria-hidden
                />
                Objective falls
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <TimelineBrush
              min={minTick}
              max={maxTick}
              value={range}
              onChange={setRange}
              events={timelineEvents}
              label={(t) => clock((t - minTick) / TICKS_PER_SECOND)}
            />
            <button
              type="button"
              onClick={() => setRange([minTick, maxTick])}
              disabled={fullRange}
              className={cn(
                "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                fullRange
                  ? "text-muted-foreground/40"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              )}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Canvas heat layer for one team. Cells are pre-binned (x/y/weight in 0..1);
// each is a soft radial blob that blends into a smooth field. One DOM node per
// team, redrawn on change — sits inside the zoom transform so it scales/pans.
function DensityCanvas({ cells, color }: { cells: Cell[]; color: string }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const { width: W, height: H } = cv;
    ctx.clearRect(0, 0, W, H);
    // Normal alpha compositing (not additive): overlapping blobs converge to
    // the base color rather than summing past it toward white, so dense areas
    // stay at the color's own luminance instead of blowing out.
    ctx.globalCompositeOperation = "source-over";
    const R = W * 0.05;
    for (const c of cells) {
      const cx = c.x * W;
      const cy = c.y * H;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, rgba(color, 0.6 * c.w));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [cells, color]);
  return (
    <canvas
      ref={ref}
      width={512}
      height={512}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

// Dual-handle time-window brush over match ticks, with event bars drawn on the
// track. Drag a handle to bound the window; the region outside dims. Self-
// contained and pointer-capture based, so a drag keeps tracking off the handle.
function TimelineBrush({
  min,
  max,
  value,
  onChange,
  events,
  label,
}: {
  min: number;
  max: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  events: { tick: number; color: string }[];
  label: (tick: number) => string;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [lo, hi] = value;
  const span = Math.max(1, max - min);
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;

  const tickAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return min;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(min + frac * span);
  };
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const drag = (which: "lo" | "hi") => (e: React.PointerEvent) => {
    if (e.buttons === 0) return;
    const t = tickAt(e.clientX);
    if (which === "lo") onChange([Math.min(t, hi), hi]);
    else onChange([lo, Math.max(t, lo)]);
  };

  // Drag the band between the handles to slide the whole window at fixed width.
  const moveRef = React.useRef<{
    startX: number;
    startLo: number;
    startHi: number;
  } | null>(null);
  const [moving, setMoving] = React.useState(false);
  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveRef.current = { startX: e.clientX, startLo: lo, startHi: hi };
    setMoving(true);
  };
  const move = (e: React.PointerEvent) => {
    const s = moveRef.current;
    const el = trackRef.current;
    if (!s || !el) return;
    const dTicks = Math.round(
      ((e.clientX - s.startX) / el.getBoundingClientRect().width) * span,
    );
    const width = s.startHi - s.startLo;
    const newLo = Math.max(min, Math.min(max - width, s.startLo + dTicks));
    onChange([newLo, newLo + width]);
  };
  const endMove = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    moveRef.current = null;
    setMoving(false);
  };

  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="w-9 flex-shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {label(lo)}
      </span>
      <div
        ref={trackRef}
        className="relative h-9 flex-1 overflow-hidden rounded-md border border-border bg-muted"
      >
        {events.map((ev, i) => (
          <span
            key={i}
            className="pointer-events-none absolute inset-y-1 w-px"
            style={{
              left: `${((ev.tick - min) / span) * 100}%`,
              backgroundColor: ev.color,
            }}
          />
        ))}
        {/* Dim the area outside the selected window (over the bars). */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-background/65"
          style={{ width: `${loPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-background/65"
          style={{ width: `${100 - hiPct}%` }}
        />
        {/* The selected band — drag it to slide the window at a fixed width. */}
        <div
          role="slider"
          aria-label="Move window"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={lo}
          onPointerDown={startMove}
          onPointerMove={move}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          className={cn(
            "absolute inset-y-0 touch-none transition-colors hover:bg-foreground/[0.06]",
            moving ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%` }}
        >
          <span className="pointer-events-none absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-[3px]">
            <span className="h-3 w-px bg-foreground/40" />
            <span className="h-3 w-px bg-foreground/40" />
          </span>
        </div>
        {(["lo", "hi"] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="slider"
            aria-label={which === "lo" ? "Window start" : "Window end"}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={which === "lo" ? lo : hi}
            onPointerDown={startDrag}
            onPointerMove={drag(which)}
            className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
            style={{ left: `${which === "lo" ? loPct : hiPct}%` }}
          >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-foreground" />
            <span className="absolute top-1/2 left-1/2 h-4 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-foreground shadow" />
          </button>
        ))}
      </div>
      <span className="w-9 flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {label(hi)}
      </span>
    </div>
  );
}
