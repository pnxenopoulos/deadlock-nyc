import * as React from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  FileUp,
  Info,
  Loader2,
  Pause,
  Play,
} from "lucide-react";

import { DemoInfoDialog } from "@/components/demo-info-dialog";
import { EventLog } from "@/components/event-log";
import { HeatmapView } from "@/components/heatmap-view";
import { TimelineView } from "@/components/timeline-view";
import { MatrixView } from "@/components/matrix-view";
import {
  MapView,
  RIFT_COLOR,
  type AbilityEvent,
  type AbilitySlot,
  type AbilityTick,
  type AbilityUpgradeEvent,
  type BreakableEvent,
  type ChatEvent,
  type FireEvent,
  type HeroAbilities,
  type ItemEvent,
  type KillEvent,
  type KillMarker,
  type ModifierSpan,
  type CampStateEvent,
  type NeutralCamp,
  type NeutralCampState,
  type ObjectiveEvent,
  type ObjectiveHealthEvent,
  type ObjectiveInfo,
  type ObjectiveMarker,
  type ObjectiveState,
  type PauseInterval,
  type PlayerPosition,
  type RiftState,
  type SinnerEvent,
  type SinnerMachineState,
} from "@/components/map-view";
import { PlaybackConfig, SPEED_OPTIONS } from "@/components/playback-config";
import {
  PlayerDetail,
  type AbilityCooldown,
  type ChargeState,
  type CooldownSpan,
} from "@/components/player-detail";
import {
  PlayerRoster,
  TEAM_COLORS,
  type DerivedStats,
  type HeroItems,
  type PlayerInfo,
  type StatGroup,
} from "@/components/player-roster";
import { Timeline } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { parseDemo, type MatchSummary } from "@/wasm/boon";
import type { FrameStore } from "@/wasm/frames";
import {
  ViewPlaceholder,
  useViewMode,
  type DemoMode,
} from "@/components/view-mode";

const SAMPLE_EVERY_TICKS = 8;
const TICKS_PER_SECOND = 64;
const KILL_MARKER_TICKS = 10 * TICKS_PER_SECOND; // 10 seconds at 64 t/s = 640
// Skip-back / skip-forward step for the ± buttons flanking play (10s at 64 t/s).
const STEP_TICKS = 640;
// Objectives are rare and significant, so their map markers linger longer.
const OBJECTIVE_MARKER_TICKS = 20 * TICKS_PER_SECOND;
const BREAKABLE_MARKER_TICKS = 8 * TICKS_PER_SECOND;
const SINNER_HIT_TICKS = TICKS_PER_SECOND / 2;
const RIFT_CAPTURE_FADE_TICKS = 10 * TICKS_PER_SECOND;
// Gold accent for neutral objectives (Mid-Boss) with no owning team.
const NEUTRAL_OBJECTIVE_COLOR = "#c9a227";

function demoModeLabel(gameMode: number, matchMode: number): DemoMode {
  if (gameMode === 4) return "Street Brawl";
  return matchMode === 4 ? "Ranked" : "Standard";
}

type State =
  | { kind: "idle" }
  | {
      kind: "parsing";
      name: string;
      progress?: { tick: number; total: number };
    }
  | {
      kind: "done";
      name: string;
      header: unknown;
      mode: DemoMode;
      frames: FrameStore;
      itemEvents: ItemEvent[];
      killEvents: KillEvent[];
      fireEvents: FireEvent[];
      abilityEvents: AbilityEvent[];
      abilitySlots: HeroAbilities[];
      abilityUpgradeEvents: AbilityUpgradeEvent[];
      abilityTicks: AbilityTick[];
      objectiveEvents: ObjectiveEvent[];
      objectives: ObjectiveInfo[];
      objectiveHealth: ObjectiveHealthEvent[];
      neutralCamps: NeutralCamp[];
      campStateEvents: CampStateEvent[];
      breakableEvents: BreakableEvent[];
      sinnerEvents: SinnerEvent[];
      chatEvents: ChatEvent[];
      modifierSpans: ModifierSpan[];
      pauseIntervals: PauseInterval[];
      regulationTicks: number | null;
      players: PlayerInfo[];
      winner: number | null;
      summary: MatchSummary;
    }
  | { kind: "error"; message: string };

export function UploadZone() {
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const { setDemoLoaded, setDemoMode } = useViewMode();
  const loadedMode = state.kind === "done" ? state.mode : null;

  // The header's view switcher and mode badge only appear after parsing.
  React.useEffect(() => {
    setDemoLoaded(state.kind === "done");
    setDemoMode(loadedMode);
  }, [state.kind, loadedMode, setDemoLoaded, setDemoMode]);

  async function handleFile(file: File) {
    setState({ kind: "parsing", name: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseDemo(bytes, SAMPLE_EVERY_TICKS, (tick, total) => {
        setState((s) =>
          s.kind === "parsing"
            ? { kind: "parsing", name: s.name, progress: { tick, total } }
            : s,
        );
      });
      setState({
        kind: "done",
        name: file.name,
        header: parsed.header,
        mode: demoModeLabel(
          parsed.positions.game_mode,
          parsed.positions.match_mode,
        ),
        frames: parsed.positions.frames,
        itemEvents: parsed.positions.item_events,
        killEvents: parsed.positions.kill_events,
        fireEvents: parsed.positions.fire_events,
        abilityEvents: parsed.positions.ability_events,
        abilitySlots: parsed.positions.ability_slots,
        abilityUpgradeEvents: parsed.positions.ability_upgrade_events,
        abilityTicks: parsed.positions.ability_ticks,
        objectiveEvents: parsed.positions.objective_events,
        objectives: parsed.positions.objectives,
        objectiveHealth: parsed.positions.objective_health,
        neutralCamps: parsed.positions.neutral_camps,
        campStateEvents: parsed.positions.camp_state_events,
        breakableEvents: parsed.positions.breakable_events,
        sinnerEvents: parsed.positions.sinner_events,
        chatEvents: parsed.positions.chat_events,
        modifierSpans: parsed.positions.modifier_spans,
        pauseIntervals: parsed.positions.pause_intervals,
        regulationTicks: parsed.positions.regulation_ticks,
        players: parsed.players,
        winner: parsed.winner,
        summary: parsed.summary,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (state.kind === "done") {
    return (
      <DemoView
        name={state.name}
        mode={state.mode}
        frames={state.frames}
        itemEvents={state.itemEvents}
        killEvents={state.killEvents}
        fireEvents={state.fireEvents}
        abilityEvents={state.abilityEvents}
        abilitySlots={state.abilitySlots}
        abilityUpgradeEvents={state.abilityUpgradeEvents}
        abilityTicks={state.abilityTicks}
        objectiveEvents={state.objectiveEvents}
        objectives={state.objectives}
        objectiveHealth={state.objectiveHealth}
        neutralCamps={state.neutralCamps}
        campStateEvents={state.campStateEvents}
        breakableEvents={state.breakableEvents}
        sinnerEvents={state.sinnerEvents}
        chatEvents={state.chatEvents}
        modifierSpans={state.modifierSpans}
        pauseIntervals={state.pauseIntervals}
        regulationTicks={state.regulationTicks}
        players={state.players}
        winner={state.winner}
        summary={state.summary}
      />
    );
  }

  return <IdleView state={state} onFile={handleFile} />;
}

function IdleView({
  state,
  onFile,
}: {
  state: Extract<State, { kind: "idle" | "parsing" | "error" }>;
  onFile: (f: File) => void;
}) {
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const parsing = state.kind === "parsing";
  const prog = state.kind === "parsing" ? state.progress : undefined;
  const pct =
    prog && prog.total > 0
      ? Math.min(100, (prog.tick / prog.total) * 100)
      : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-4">
      <div className="text-center">
        <h1 className="text-3xl font-medium tracking-tight">
          Deadlock demo viewer
        </h1>
        <p className="mt-2 text-muted-foreground">
          Select a <code className="font-mono text-sm">.dem</code> replay — it
          parses right in your browser in a few seconds. No Steam login needed.
        </p>
      </div>

      <div className="w-full max-w-2xl">
        <div
          role="button"
          tabIndex={parsing ? -1 : 0}
          aria-disabled={parsing}
          onClick={() => !parsing && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (parsing) return;
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            if (parsing) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (parsing) return;
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) onFile(file);
          }}
          className={cn(
            "flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-card p-10 text-card-foreground transition-colors",
            parsing
              ? "cursor-progress opacity-90"
              : "cursor-pointer hover:border-primary hover:bg-accent/20",
            dragging && "border-primary bg-accent/30",
          )}
        >
          {parsing ? (
            <Loader2 className="size-10 animate-spin text-primary" />
          ) : (
            <FileUp className="size-10 text-primary" />
          )}
          <div className="w-full max-w-sm text-center">
            <p className="text-base font-medium">
              {parsing
                ? `Parsing ${state.name}…`
                : "Drop a .dem file or click to select"}
            </p>
            {parsing ? (
              <>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary",
                      pct != null
                        ? "transition-[width] duration-200 ease-out"
                        : "w-1/3 animate-pulse",
                    )}
                    style={pct != null ? { width: `${pct}%` } : undefined}
                  />
                </div>
                <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {prog
                    ? `tick ${prog.tick.toLocaleString()}` +
                      (prog.total > 0
                        ? ` / ${prog.total.toLocaleString()}`
                        : "")
                    : "starting…"}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Parsed entirely in your browser — nothing leaves your machine.
              </p>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".dem"
            className="hidden"
            disabled={parsing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {state.kind === "error" && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {state.message}
          </p>
        )}

        <div className="mt-6 rounded-md border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Where do I find a replay?</p>
          <p className="mt-1">
            In Deadlock, open your match history and download the replay you
            want.
            <br />
            It's then saved on your PC under:
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
            C:\Program Files (x86)\Steam\steamapps\common\Deadlock\game\citadel\replays
          </code>
        </div>
      </div>
    </div>
  );
}

function formatClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0
    ? `${sign}${h}:${pad(m)}:${pad(sec)}`
    : `${sign}${m}:${pad(sec)}`;
}

function DemoView({
  name,
  mode,
  frames,
  itemEvents,
  killEvents,
  fireEvents,
  abilityEvents,
  abilitySlots,
  abilityUpgradeEvents,
  abilityTicks,
  objectiveEvents,
  objectives,
  objectiveHealth,
  neutralCamps,
  campStateEvents,
  breakableEvents,
  sinnerEvents,
  chatEvents,
  modifierSpans,
  pauseIntervals,
  regulationTicks,
  players,
  winner,
  summary,
}: {
  name: string;
  mode: DemoMode;
  frames: FrameStore;
  itemEvents: ItemEvent[];
  killEvents: KillEvent[];
  fireEvents: FireEvent[];
  abilityEvents: AbilityEvent[];
  abilitySlots: HeroAbilities[];
  abilityUpgradeEvents: AbilityUpgradeEvent[];
  abilityTicks: AbilityTick[];
  objectiveEvents: ObjectiveEvent[];
  objectives: ObjectiveInfo[];
  objectiveHealth: ObjectiveHealthEvent[];
  neutralCamps: NeutralCamp[];
  campStateEvents: CampStateEvent[];
  breakableEvents: BreakableEvent[];
  sinnerEvents: SinnerEvent[];
  chatEvents: ChatEvent[];
  modifierSpans: ModifierSpan[];
  pauseIntervals: PauseInterval[];
  regulationTicks: number | null;
  players: PlayerInfo[];
  winner: number | null;
  summary: MatchSummary;
}) {
  const [index, setIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  // Configurable via the playback-settings popover.
  const [playbackSpeed, setPlaybackSpeed] = React.useState(1);
  const [stepTicks, setStepTicks] = React.useState(STEP_TICKS);
  // Roster stat columns, chosen by the Stats control above the rosters:
  // Basic (combat/economy), Advanced (KP/uptime), Econ (souls), Position
  // (distance/time in enemy half).
  const [statGroup, setStatGroup] = React.useState<StatGroup>("basic");
  const [selectedHeroId, setSelectedHeroId] = React.useState<number | null>(
    null,
  );
  const safeIndex = Math.min(index, Math.max(0, frames.length - 1));
  const frame = frames.at(safeIndex);

  const { view } = useViewMode();

  const selectedPlayer =
    selectedHeroId != null
      ? players.find((p) => p.hero_id === selectedHeroId)
      : undefined;

  const statsByHero = React.useMemo(() => {
    const m = new Map<number, PlayerPosition>();
    if (frame) for (const p of frame.players) m.set(p.hero_id, p);
    return m;
  }, [frame]);

  // Cumulative-to-each-frame derived stats, as per-hero prefix arrays so any
  // tick is an O(1) lookup. Built once per demo (keyed on frames + objectives):
  //  • aliveReg[i]  — regulation ticks the hero has been alive through frame i.
  //  • dist[i]      — world-space path length through frame i. Only accrues
  //                   across frames where the hero is alive on both ends, so
  //                   respawn teleports back to base don't inflate it.
  //  • enemyReg[i]  — alive regulation ticks spent in the enemy half (closer to
  //                   the enemy Patron than the hero's own). TEH = enemyReg /
  //                   aliveReg.
  //  • depth[i]     — Σ(t · dReg) over alive frames, where t is the hero's
  //                   clamped 0..1 position along the own→enemy Patron axis.
  //                   DEPTH = depth / aliveReg (0 = own base, 1 = enemy base).
  const movementPrefix = React.useMemo(() => {
    const n = frames.length;
    const aliveReg = new Map<number, Uint32Array>();
    const dist = new Map<number, Float32Array>();
    const enemyReg = new Map<number, Uint32Array>();
    const depth = new Map<number, Float32Array>();
    for (const p of players) {
      aliveReg.set(p.hero_id, new Uint32Array(n));
      dist.set(p.hero_id, new Float32Array(n));
      enemyReg.set(p.hero_id, new Uint32Array(n));
      depth.set(p.hero_id, new Float32Array(n));
    }
    // Patron (base) position per team. The midline is their perpendicular
    // bisector, so "enemy half" = closer to the other team's Patron.
    const patron = new Map<number, { x: number; y: number }>();
    for (const o of objectives) {
      if (o.kind === "patron" && !patron.has(o.team)) {
        patron.set(o.team, { x: o.x, y: o.y });
      }
    }
    const prev = new Map<number, { x: number; y: number; alive: boolean }>();
    const aliveAcc = new Map<number, number>();
    const distAcc = new Map<number, number>();
    const enemyAcc = new Map<number, number>();
    const depthAcc = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const regTicks = frames.regTicksAt(i) ?? 0;
      const dReg =
        i === 0
          ? 0
          : Math.max(0, regTicks - (frames.regTicksAt(i - 1) ?? 0));
      frames.forEachPlayerAt(i, (pl) => {
        if (!aliveReg.has(pl.hero_id)) return; // unresolved hero (id 0)
        const pv = prev.get(pl.hero_id);
        if (pv) {
          if (pl.alive && dReg > 0) {
            aliveAcc.set(pl.hero_id, (aliveAcc.get(pl.hero_id) ?? 0) + dReg);
            const own = patron.get(pl.team);
            const enemy = patron.get(pl.team === 2 ? 3 : 2);
            if (own && enemy) {
              const dOwn = (pl.x - own.x) ** 2 + (pl.y - own.y) ** 2;
              const dEnemy = (pl.x - enemy.x) ** 2 + (pl.y - enemy.y) ** 2;
              if (dEnemy < dOwn) {
                enemyAcc.set(pl.hero_id, (enemyAcc.get(pl.hero_id) ?? 0) + dReg);
              }
              // Forwardness: clamped fraction along the own→enemy Patron axis
              // (0 = at own base, 1 = at enemy base), time-weighted by dReg.
              const ax = enemy.x - own.x;
              const ay = enemy.y - own.y;
              const len2 = ax * ax + ay * ay || 1;
              let t = ((pl.x - own.x) * ax + (pl.y - own.y) * ay) / len2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              depthAcc.set(pl.hero_id, (depthAcc.get(pl.hero_id) ?? 0) + t * dReg);
            }
          }
          if (pv.alive && pl.alive) {
            distAcc.set(
              pl.hero_id,
              (distAcc.get(pl.hero_id) ?? 0) + Math.hypot(pl.x - pv.x, pl.y - pv.y),
            );
          }
        }
        prev.set(pl.hero_id, { x: pl.x, y: pl.y, alive: pl.alive });
      });
      // Snapshot the running totals for every roster hero (carry forward when
      // a hero is missing from this frame).
      for (const p of players) {
        aliveReg.get(p.hero_id)![i] = aliveAcc.get(p.hero_id) ?? 0;
        dist.get(p.hero_id)![i] = distAcc.get(p.hero_id) ?? 0;
        enemyReg.get(p.hero_id)![i] = enemyAcc.get(p.hero_id) ?? 0;
        depth.get(p.hero_id)![i] = depthAcc.get(p.hero_id) ?? 0;
      }
    }
    return { aliveReg, dist, enemyReg, depth };
  }, [frames, players, objectives]);

  // Resolve the prefix arrays at the current frame into the derived stats.
  const derivedByHero = React.useMemo(() => {
    const m = new Map<number, DerivedStats>();
    const i = safeIndex;
    const f = frames.at(i);
    const regElapsed =
      (f?.reg_ticks ?? 0) - (frames.regTicksAt(0) ?? 0);
    // Elapsed regulation minutes — denominator for the per-minute rates.
    const regMinutes = regElapsed / TICKS_PER_SECOND / 60;
    // Team kill totals at this tick → kill participation (an individual can't
    // assist their own kill, so this is naturally ≤ 100%).
    const teamKills = new Map<number, number>();
    // Team net-worth totals at this tick → each hero's soul share (SPCT).
    const teamNetWorth = new Map<number, number>();
    // Team hero-damage totals at this tick → each hero's damage share (DMG%).
    const teamDamage = new Map<number, number>();
    const liveById = new Map<number, PlayerPosition>();
    if (f) {
      for (const pl of f.players) {
        liveById.set(pl.hero_id, pl);
        teamKills.set(pl.team, (teamKills.get(pl.team) ?? 0) + pl.kills);
        teamNetWorth.set(
          pl.team,
          (teamNetWorth.get(pl.team) ?? 0) + pl.net_worth,
        );
        teamDamage.set(
          pl.team,
          (teamDamage.get(pl.team) ?? 0) + pl.hero_damage,
        );
      }
    }
    for (const p of players) {
      const aliveT = movementPrefix.aliveReg.get(p.hero_id)?.[i] ?? 0;
      const enemyT = movementPrefix.enemyReg.get(p.hero_id)?.[i] ?? 0;
      const distance = movementPrefix.dist.get(p.hero_id)?.[i] ?? 0;
      const depthT = movementPrefix.depth.get(p.hero_id)?.[i] ?? 0;
      const aliveSec = aliveT / TICKS_PER_SECOND;
      const live = liveById.get(p.hero_id);
      const tk = live ? teamKills.get(live.team) ?? 0 : 0;
      const tnw = live ? teamNetWorth.get(live.team) ?? 0 : 0;
      const tdmg = live ? teamDamage.get(live.team) ?? 0 : 0;
      m.set(p.hero_id, {
        uptime: regElapsed > 0 ? (aliveT / regElapsed) * 100 : 0,
        distance,
        kp: live && tk > 0 ? ((live.kills + live.assists) / tk) * 100 : 0,
        teh: aliveT > 0 ? (enemyT / aliveT) * 100 : 0,
        dpm: live && regMinutes > 0 ? live.hero_damage / regMinutes : 0,
        spm: live && regMinutes > 0 ? live.net_worth / regMinutes : 0,
        spct: live && tnw > 0 ? (live.net_worth / tnw) * 100 : 0,
        spd: aliveSec > 0 ? distance / aliveSec : 0,
        depth: aliveT > 0 ? (depthT / aliveT) * 100 : 0,
        dmgShare: live && tdmg > 0 ? (live.hero_damage / tdmg) * 100 : 0,
        objpm: live && regMinutes > 0 ? live.objective_damage / regMinutes : 0,
      });
    }
    return m;
  }, [movementPrefix, safeIndex, frames, players]);

  // Replay item events up to the current tick to reconstruct each hero's
  // current inventory. Cheap — typically a few hundred events total.
  const itemsByHero = React.useMemo(() => {
    const m = new Map<number, HeroItems>();
    const tick = frame?.tick ?? 0;
    for (const e of itemEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      let cur = m.get(e.hero_id);
      if (!cur) {
        cur = { items: [] };
        m.set(e.hero_id, cur);
      }
      if (e.change === "purchased" || e.change === "upgraded") {
        if (!cur.items.some((it) => it.ability_id === e.ability_id)) {
          cur.items.push({
            ability_id: e.ability_id,
            ability_name: e.ability_name,
          });
        }
      } else if (e.change === "sold") {
        cur.items = cur.items.filter(
          (it) => it.ability_id !== e.ability_id,
        );
      }
    }
    return m;
  }, [itemEvents, frame]);

  // Each hero's signature abilities are constant for the match.
  const abilitiesByHero = React.useMemo(() => {
    const m = new Map<number, AbilitySlot[]>();
    for (const h of abilitySlots) m.set(h.hero_id, h.abilities);
    return m;
  }, [abilitySlots]);

  // Reconstruct each ability's cooldown + charge state from the change-only
  // ability_ticks. All the *_start/_end fields are game-time seconds; a row is
  // emitted on the tick a state change happens, so we anchor at that tick and
  // add the duration (`end - start`) — epoch- and pause-independent. A later
  // same-window change (cooldown reduction, a charge tick) keeps the anchor
  // tick and just moves the end. `maxCharges` (max remaining_charges seen) ≥ 2
  // marks a charge-based ability. Built once.
  const abilityCooldownsByHero = React.useMemo(() => {
    const groups = new Map<string, AbilityTick[]>();
    for (const r of abilityTicks) {
      const k = `${r.hero_id}:${r.ability_id}`;
      let arr = groups.get(k);
      if (!arr) {
        arr = [];
        groups.set(k, arr);
      }
      arr.push(r);
    }
    const byHero = new Map<number, Map<number, AbilityCooldown>>();
    for (const [k, rows] of groups) {
      const cooldowns: CooldownSpan[] = [];
      let castStart: number | null = null;
      const charges: ChargeState[] = [];
      // Game-time start of the charge currently regenerating, anchored to the
      // tick it began so a later non-charge change doesn't reset its progress.
      let rcStartGt: number | null = null;
      let rcAnchorTick = 0;
      let maxCharges = 0;
      for (const r of rows) {
        const cs = r.cooldown_start;
        const ce = r.cooldown_end;
        // Cooldown spans (cast-anchored).
        if (ce <= cs) {
          castStart = null; // not on cooldown
        } else if (castStart === cs && cooldowns.length > 0) {
          const span = cooldowns[cooldowns.length - 1];
          span.total = ce - cs;
          span.end = span.start + (ce - cs) * TICKS_PER_SECOND;
        } else {
          castStart = cs;
          cooldowns.push({
            start: r.tick,
            end: r.tick + (ce - cs) * TICKS_PER_SECOND,
            total: ce - cs,
          });
        }
        // Charge timeline (recharge-window-anchored).
        if (r.remaining_charges > maxCharges) maxCharges = r.remaining_charges;
        const rs = r.charge_recharge_start;
        const re = r.charge_recharge_end;
        const recharging = re > rs;
        if (recharging) {
          if (rcStartGt !== rs) {
            rcStartGt = rs;
            rcAnchorTick = r.tick;
          }
        } else {
          rcStartGt = null;
        }
        charges.push({
          startTick: r.tick,
          count: r.remaining_charges,
          rechargeStart: rcAnchorTick,
          rechargeEnd: recharging
            ? rcAnchorTick + (re - rs) * TICKS_PER_SECOND
            : r.tick,
          recharging,
        });
      }
      const sep = k.indexOf(":");
      const hero = Number(k.slice(0, sep));
      const ability = Number(k.slice(sep + 1));
      let m = byHero.get(hero);
      if (!m) {
        m = new Map();
        byHero.set(hero, m);
      }
      m.set(ability, { maxCharges, cooldowns, charges });
    }
    return byHero;
  }, [abilityTicks]);

  // Replay sparse upgrade events up to the current tick to get each ability's
  // level now (same approach as items — abilities only change a few times).
  const abilityLevelsByHero = React.useMemo(() => {
    const m = new Map<number, Map<number, number>>();
    const tick = frame?.tick ?? 0;
    for (const e of abilityUpgradeEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      let cur = m.get(e.hero_id);
      if (!cur) {
        cur = new Map();
        m.set(e.hero_id, cur);
      }
      cur.set(e.ability_id, e.level); // increasing — latest ≤ tick wins
    }
    return m;
  }, [abilityUpgradeEvents, frame]);

  // Index modifier spans by the affected hero (built once per demo).
  const spansByHero = React.useMemo(() => {
    const m = new Map<number, ModifierSpan[]>();
    for (const s of modifierSpans) {
      let cur = m.get(s.hero_id);
      if (!cur) {
        cur = [];
        m.set(s.hero_id, cur);
      }
      cur.push(s);
    }
    return m;
  }, [modifierSpans]);

  // Buffs/debuffs active on the selected player at the current tick: spans
  // covering [start, end). Only computed for the open detail panel.
  //
  // The demo's ActiveModifiers table carries some self-applied item modifiers
  // *before* the player buys the item — a pre-game loadout snapshot plus a
  // trickle through early game — which then vanish and are bought for real
  // later. So drop a self-applied item-sourced modifier unless the player
  // actually owns that item at this tick; modifiers cast by another hero (real
  // incoming effects, shown "from X") are kept regardless of ownership.
  const activeModifiers = React.useMemo(() => {
    if (selectedHeroId == null) return [];
    const tick = frame?.tick ?? 0;
    const spans = spansByHero.get(selectedHeroId);
    if (!spans) return [];
    const owned = new Set(
      (itemsByHero.get(selectedHeroId)?.items ?? []).map((it) => it.ability_id),
    );
    return spans.filter((s) => {
      if (s.start_tick > tick || (s.end_tick != null && tick >= s.end_tick)) {
        return false;
      }
      const selfApplied =
        s.caster_hero_id === 0 || s.caster_hero_id === selectedHeroId;
      const isItem = s.ability_name.startsWith("upgrade_");
      if (isItem && selfApplied && !owned.has(s.ability_id)) return false;
      return true;
    });
  }, [spansByHero, selectedHeroId, frame, itemsByHero]);

  const firstTick = frames.tickAt(0) ?? 0;
  const lastTick = frames.tickAt(frames.length - 1) ?? 0;
  const totalTicks = Math.max(0, lastTick - firstTick);
  const currentTick = frame ? frame.tick - firstTick : 0;
  const regulationClock =
    regulationTicks != null
      ? formatClock(regulationTicks / TICKS_PER_SECOND)
      : null;

  const teamByHero = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const p of players) m.set(p.hero_id, p.team);
    return m;
  }, [players]);

  // Show a kill marker at the victim's location for KILL_MARKER_TICKS
  // (10s) after each kill, colored by the victim's team.
  const killMarkers: KillMarker[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const out: KillMarker[] = [];
    for (const e of killEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      if (tick - e.tick > KILL_MARKER_TICKS) continue;
      const team = teamByHero.get(e.victim_hero_id) ?? 0;
      out.push({ x: e.x, y: e.y, color: TEAM_COLORS[team] ?? "#888" });
    }
    return out;
  }, [killEvents, frame, teamByHero]);

  // Diamond markers for recently-destroyed objectives, colored by the owning
  // (losing) team. The Mid-Boss spawn has no position, so it's feed-only.
  const objectiveMarkers: ObjectiveMarker[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const out: ObjectiveMarker[] = [];
    for (const e of objectiveEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      if (tick - e.tick > OBJECTIVE_MARKER_TICKS) continue;
      if (e.x == null || e.y == null) continue;
      // The urn and Rift have live markers, so skip their transient diamonds.
      if (e.kind === "urn" || e.kind === "rift") continue;
      out.push({
        x: e.x,
        y: e.y,
        color: TEAM_COLORS[e.team] ?? NEUTRAL_OBJECTIVE_COLOR,
        kind: e.kind,
      });
    }
    return out;
  }, [objectiveEvents, frame]);

  // Reconstruct each live objective at the current tick: alive between its
  // spawn and death, with health replayed from the sparse samples (≤ tick).
  const objectiveStates: ObjectiveState[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const hpById = new Map<number, { health: number; max: number }>();
    for (const e of objectiveHealth) {
      if (e.tick > tick) break; // tick-ordered
      hpById.set(e.id, { health: e.health, max: e.max_health });
    }
    const out: ObjectiveState[] = [];
    for (const o of objectives) {
      if (tick < o.spawn_tick) continue;
      if (o.death_tick != null && tick >= o.death_tick) continue;
      const hp = hpById.get(o.id);
      out.push({
        kind: o.kind,
        x: o.x,
        y: o.y,
        health: hp?.health ?? o.max_health,
        max_health: hp?.max ?? o.max_health,
        color: TEAM_COLORS[o.team] ?? NEUTRAL_OBJECTIVE_COLOR,
      });
    }
    return out;
  }, [objectives, objectiveHealth, frame]);

  // The Rift is not a networked objective entity, so reconstruct its live
  // window from the sparse lifecycle events instead of storing it per frame.
  const rift: RiftState | null = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    let live: RiftState | null = null;
    let capturedTick: number | null = null;
    let lastX: number | null = null;
    let lastY: number | null = null;
    for (const e of objectiveEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      if (e.kind !== "rift") continue;
      if (e.action === "opened") {
        lastX = e.x;
        lastY = e.y;
        live =
          lastX != null && lastY != null
            ? { x: lastX, y: lastY, color: RIFT_COLOR, opacity: 1 }
            : null;
        capturedTick = null;
      } else if (e.action === "captured") {
        const capturedX: number | null = e.x ?? lastX;
        const capturedY: number | null = e.y ?? lastY;
        live =
          capturedX != null && capturedY != null
            ? {
                x: capturedX,
                y: capturedY,
                color: TEAM_COLORS[e.team] ?? RIFT_COLOR,
                opacity: 1,
              }
            : null;
        lastX = capturedX;
        lastY = capturedY;
        capturedTick = e.tick;
      } else if (e.action === "expired") {
        live = null;
        capturedTick = null;
        lastX = null;
        lastY = null;
      }
    }
    if (live && capturedTick != null) {
      const elapsed = tick - capturedTick;
      if (elapsed >= RIFT_CAPTURE_FADE_TICKS) return null;
      live.opacity = 1 - elapsed / RIFT_CAPTURE_FADE_TICKS;
    }
    return live;
  }, [objectiveEvents, frame]);

  // Reconstruct each neutral camp's up/down state at the current tick from the
  // sparse transitions (latest event ≤ tick; default down until first spawn).
  const campStates: NeutralCampState[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const upById = new Map<number, boolean>();
    for (const e of campStateEvents) {
      if (e.tick > tick) break; // tick-ordered
      upById.set(e.camp_id, e.up);
    }
    return neutralCamps.map((c) => ({
      x: c.x,
      y: c.y,
      size: c.size,
      up: upById.get(c.id) ?? false,
    }));
  }, [neutralCamps, campStateEvents, frame]);

  const breakableMarkers = React.useMemo<BreakableEvent[]>(() => {
    const tick = frame?.tick ?? 0;
    return breakableEvents.filter(
      (event) =>
        event.tick <= tick && tick - event.tick <= BREAKABLE_MARKER_TICKS,
    );
  }, [breakableEvents, frame]);

  const sinnerStates = React.useMemo<SinnerMachineState[]>(() => {
    const tick = frame?.tick ?? 0;
    const latest = new Map<string, SinnerEvent>();
    for (const event of sinnerEvents) {
      if (event.tick > tick) break;
      latest.set(`${event.id}:${event.serial}`, event);
    }
    return [...latest.values()].map((event) => ({
      ...event,
      hit: event.event === "hit" && tick - event.tick <= SINNER_HIT_TICKS,
    }));
  }, [sinnerEvents, frame]);

  // Gun-shot tallies bucketed by frame tick (each fire event's tick matches a
  // frame). Built once; the map reads the current frame's bucket for pulses.
  const fireByTick = React.useMemo(() => {
    const m = new Map<number, Map<number, number>>();
    for (const e of fireEvents) {
      let inner = m.get(e.tick);
      if (!inner) {
        inner = new Map();
        m.set(e.tick, inner);
      }
      inner.set(e.hero_id, (inner.get(e.hero_id) ?? 0) + e.count);
    }
    return m;
  }, [fireEvents]);
  const firing = React.useMemo(
    () => (frame ? fireByTick.get(frame.tick) : undefined),
    [fireByTick, frame],
  );

  React.useEffect(() => {
    if (!playing) return;
    if (safeIndex >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const cur = frames.at(safeIndex)!;
    const next = frames.at(safeIndex + 1)!;
    const ms =
      (((next.tick - cur.tick) / TICKS_PER_SECOND) * 1000) / playbackSpeed;
    const t = window.setTimeout(() => setIndex(safeIndex + 1), Math.max(0, ms));
    return () => window.clearTimeout(t);
  }, [playing, safeIndex, frames, playbackSpeed]);

  function togglePlay() {
    if (safeIndex >= frames.length - 1) {
      setIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }

  function seekManually(next: number) {
    setPlaying(false);
    setIndex(next);
  }

  function seekToTick(tick: number) {
    if (frames.length === 0) return;
    const idx = frames.indexAtOrAfter(tick);
    if (idx < 0) return;
    seekManually(idx);
  }

  // Jump forward/back by a fixed number of ticks relative to the current frame.
  function seekByTicks(delta: number) {
    const base = frames.tickAt(safeIndex) ?? firstTick;
    seekToTick(base + delta);
  }

  // Keyboard shortcuts from anywhere on the page (except while typing in a
  // field): Space toggles playback; ←/→ skip back/forward by the configured
  // step; ↑/↓ step playback speed through SPEED_OPTIONS. Refs keep the listener
  // stable while always using the latest values.
  const togglePlayRef = React.useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  const skipRef = React.useRef<(dir: number) => void>(() => {});
  skipRef.current = (dir) => seekByTicks(dir * stepTicks);
  React.useEffect(() => {
    // dir +1 = faster, -1 = slower; clamps at the ends of SPEED_OPTIONS.
    const cycleSpeed = (dir: number) =>
      setPlaybackSpeed((cur) => {
        const idx = SPEED_OPTIONS.indexOf(cur);
        const base = idx < 0 ? SPEED_OPTIONS.indexOf(1) : idx;
        const next = Math.max(
          0,
          Math.min(SPEED_OPTIONS.length - 1, base + dir),
        );
        return SPEED_OPTIONS[next];
      });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault(); // stop page scroll and button re-activation
        togglePlayRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skipRef.current(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skipRef.current(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); // stop page scroll
        cycleSpeed(1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        cycleSpeed(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click the current tick in the map header to type an exact tick to jump to.
  const [editingTick, setEditingTick] = React.useState(false);
  const [tickDraft, setTickDraft] = React.useState("");

  function commitTick() {
    setEditingTick(false);
    const v = parseInt(tickDraft, 10);
    if (Number.isNaN(v)) return;
    const clamped = Math.max(0, Math.min(totalTicks, v));
    seekToTick(firstTick + clamped);
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 p-4">
      <div className="flex min-h-0 flex-1 items-stretch gap-4">
        {/* Map-only chrome: the rosters/detail are part of the playback view.
            Other views (heatmap, placeholders) bring their own full layout. */}
        {view === "map" &&
          (selectedPlayer ? (
          <PlayerDetail
            player={selectedPlayer}
            stats={statsByHero.get(selectedPlayer.hero_id)}
            items={itemsByHero.get(selectedPlayer.hero_id)}
            abilities={abilitiesByHero.get(selectedPlayer.hero_id)}
            abilityLevels={abilityLevelsByHero.get(selectedPlayer.hero_id)}
            abilityCooldowns={abilityCooldownsByHero.get(selectedPlayer.hero_id)}
            modifiers={activeModifiers}
            players={players}
            tick={frame?.tick ?? 0}
            regTick={frame?.reg_ticks ?? 0}
            onBack={() => setSelectedHeroId(null)}
          />
        ) : (
          <div className="flex min-h-0 min-w-[20rem] flex-1 flex-col gap-2">
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Stats
              </span>
              <Tabs
                value={statGroup}
                onValueChange={(v) => setStatGroup(v as StatGroup)}
              >
                <TabsList className="h-7">
                  <TabsTrigger value="basic" className="px-2 text-xs">
                    Basic
                  </TabsTrigger>
                  <TabsTrigger value="advanced" className="px-2 text-xs">
                    Adv
                  </TabsTrigger>
                  <TabsTrigger value="econ" className="px-2 text-xs">
                    Econ
                  </TabsTrigger>
                  <TabsTrigger value="position" className="px-2 text-xs">
                    Move
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <PlayerRoster
              roster={players}
              stats={statsByHero}
              derived={derivedByHero}
              team={3}
              align="left"
              winner={winner}
              statGroup={statGroup}
              onSelect={setSelectedHeroId}
            />
            <PlayerRoster
              roster={players}
              stats={statsByHero}
              derived={derivedByHero}
              team={2}
              align="left"
              winner={winner}
              statGroup={statGroup}
              onSelect={setSelectedHeroId}
            />
          </div>
          ))}
        {view === "heatmap" ? (
          <HeatmapView
            players={players}
            killEvents={killEvents}
            abilityEvents={abilityEvents}
            frames={frames}
            objectives={objectives}
            objectiveEvents={objectiveEvents}
            modifierSpans={modifierSpans}
          />
        ) : view === "timeline" ? (
          <TimelineView players={players} summary={summary} />
        ) : view === "matrix" ? (
          <MatrixView players={players} summary={summary} />
        ) : view !== "map" ? (
          <ViewPlaceholder view={view} />
        ) : (
          <MapView
            frame={frame}
            className="h-full"
            meta={
              <>
                tick{" "}
                {editingTick ? (
                  <input
                    type="number"
                    autoFocus
                    min={0}
                    max={totalTicks}
                    value={tickDraft}
                    onChange={(e) => setTickDraft(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={commitTick}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitTick();
                      else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditingTick(false);
                      }
                    }}
                    className="w-20 rounded border border-border bg-background px-1 py-0 text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    aria-label="Jump to tick"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setTickDraft(String(currentTick));
                      setEditingTick(true);
                    }}
                    title="Jump to tick"
                    className="tabular-nums underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {currentTick.toLocaleString()}
                  </button>
                )}{" "}
                / <span className="tabular-nums">{totalTicks.toLocaleString()}</span>
                {" · "}
                <span className="tabular-nums">
                  {formatClock((frame?.reg_ticks ?? 0) / TICKS_PER_SECOND)}
                </span>{" "}
                regulation
              </>
            }
            killMarkers={killMarkers}
            objectiveMarkers={objectiveMarkers}
            objectiveStates={objectiveStates}
            rift={rift}
            campStates={campStates}
            breakableMarkers={breakableMarkers}
            sinnerStates={sinnerStates}
            firing={firing}
            onSelectPlayer={setSelectedHeroId}
          />
        )}
        {view === "map" && (
        <EventLog
          killEvents={killEvents}
          abilityEvents={abilityEvents}
          objectiveEvents={objectiveEvents}
          chatEvents={chatEvents}
          players={players}
          currentTick={frame?.tick ?? 0}
          formatTick={(tick) =>
            formatClock((tick - firstTick) / TICKS_PER_SECOND)
          }
          onSeek={seekToTick}
          onSelectPlayer={(heroId, tick) => {
            seekToTick(tick);
            setSelectedHeroId(heroId);
          }}
        />
        )}
      </div>

      {view === "map" && (
      <div className="flex flex-shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => seekByTicks(-stepTicks)}
              aria-label={`Back ${stepTicks} ticks`}
              disabled={frames.length < 2}
              className="size-7"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Back {stepTicks / TICKS_PER_SECOND}s ({stepTicks} ticks)
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="icon"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              disabled={frames.length < 2}
              className="size-7"
            >
              {playing ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-medium">{playing ? "Pause" : "Play"}</span>
            <span className="text-muted-foreground"> — Space</span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => seekByTicks(stepTicks)}
              aria-label={`Forward ${stepTicks} ticks`}
              disabled={frames.length < 2}
              className="size-7"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Forward {stepTicks / TICKS_PER_SECOND}s ({stepTicks} ticks)
          </TooltipContent>
        </Tooltip>
        <div className="flex-1">
          <Timeline
            index={safeIndex}
            frames={frames}
            onSeek={seekManually}
            pauseIntervals={pauseIntervals}
          />
        </div>
        <PlaybackConfig
          speed={playbackSpeed}
          onSpeedChange={setPlaybackSpeed}
          stepTicks={stepTicks}
          onStepChange={setStepTicks}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setInfoOpen(true)}
              aria-label="Demo info"
              className="size-7"
            >
              <Info className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Demo info</TooltipContent>
        </Tooltip>
      </div>
      )}

      <DemoInfoDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        name={name}
        mode={mode}
        totalTicks={totalTicks}
        regulationClock={regulationClock}
        winner={winner}
      />
    </div>
  );
}
