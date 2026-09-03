import * as React from "react";
import {
  Amphora,
  Castle,
  CircleDollarSign,
  Crosshair,
  Crown,
  Flag,
  Gem,
  type LucideIcon,
  Maximize,
  Orbit,
  PackageOpen,
  Shield,
  ShieldHalf,
  Skull,
  Swords,
  Trees,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { heroPortraitUrl, TEAM_COLORS } from "@/components/player-roster";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { assetUrl, cn } from "@/lib/utils";
import type { FrameStore, PositionFrame } from "@/wasm/frames";

export type { PlayerPosition, PositionFrame } from "@/wasm/frames";

/** A hero's signature ability (constant for the match). */
export interface AbilitySlot {
  ability_id: number;
  ability_name: string;
}

export interface HeroAbilities {
  hero_id: number;
  abilities: AbilitySlot[];
}

/** A point at which an ability's upgrade tier increased (0 up to 3). */
export interface AbilityUpgradeEvent {
  tick: number;
  hero_id: number;
  ability_id: number;
  level: number;
}

/**
 * A change in one ability's cooldown/charge state (change-only — emitted only
 * on the tick a field changes). `cooldown_start`/`cooldown_end` are game-time
 * seconds; the ability is on cooldown until game time reaches `cooldown_end`.
 * The frontend reconstructs the active cooldown at the playback tick.
 */
export interface AbilityTick {
  tick: number;
  hero_id: number;
  ability_id: number;
  slot: number;
  cooldown_start: number;
  cooldown_end: number;
  remaining_charges: number;
  charge_recharge_start: number;
  charge_recharge_end: number;
}

export interface PauseInterval {
  start: number;
  end: number;
}

export interface PositionsResult {
  game_mode: number;
  match_mode: number;
  frames: FrameStore;
  item_events: ItemEvent[];
  kill_events: KillEvent[];
  fire_events: FireEvent[];
  ability_events: AbilityEvent[];
  ability_slots: HeroAbilities[];
  ability_upgrade_events: AbilityUpgradeEvent[];
  ability_ticks: AbilityTick[];
  objective_events: ObjectiveEvent[];
  objectives: ObjectiveInfo[];
  objective_health: ObjectiveHealthEvent[];
  neutral_camps: NeutralCamp[];
  camp_state_events: CampStateEvent[];
  breakable_events: BreakableEvent[];
  sinner_events: SinnerEvent[];
  chat_events: ChatEvent[];
  modifier_spans: ModifierSpan[];
  pause_intervals: PauseInterval[];
  game_over_tick: number | null;
  regulation_ticks: number | null;
}

/**
 * One buff/debuff active on a player over [start_tick, end_tick) (end_tick null
 * = still active at the recording's end). Labeled by its source ability/item
 * (`ability_id` for the icon, `ability_name` has the best name coverage); the
 * modifier's own `modifier_name` is a secondary label. Either name may be empty
 * but never both. `caster_hero_id` is the applying hero (0 = none / non-player),
 * `duration` is in seconds (-1 = indefinite), and `applied_reg_tick` anchors
 * the timer in non-paused match ticks.
 */
export interface ModifierSpan {
  serial: number;
  modifier_id: number;
  hero_id: number;
  start_tick: number;
  end_tick: number | null;
  applied_reg_tick: number;
  ability_id: number;
  ability_name: string;
  modifier_name: string;
  caster_hero_id: number;
  stacks: number;
  duration: number;
}

/** A neutral jungle camp. `size` is 1/2/3 (small/medium/large) → chevron count. */
export interface NeutralCamp {
  id: number;
  x: number;
  y: number;
  size: number;
}

/** A camp up (spawned) / down (cleared) transition. */
export interface CampStateEvent {
  tick: number;
  camp_id: number;
  up: boolean;
}

/** A neutral camp resolved at the current tick, ready to draw. */
export interface NeutralCampState {
  x: number;
  y: number;
  size: number;
  up: boolean;
}

export interface BreakableEvent {
  tick: number;
  id: number;
  serial: number;
  subclass_name: string;
  team: number;
  x: number;
  y: number;
  z: number;
}

export interface SinnerEvent {
  tick: number;
  event: "spawned" | "hit" | "reset";
  id: number;
  serial: number;
  health: number;
  max_health: number;
  damage: number;
  x: number;
  y: number;
  z: number;
}

export interface SinnerMachineState extends SinnerEvent {
  hit: boolean;
}

/**
 * A player chat message. `hero_id` is the sender (0 if unresolved); `all_chat`
 * is true for global chat, false for team-only.
 */
export interface ChatEvent {
  tick: number;
  hero_id: number;
  all_chat: boolean;
  text: string;
}

/**
 * One objective in the constant roster (position is static; Mid-Boss is treated
 * as static at its arena center). `death_tick` is null if it survived.
 */
export interface ObjectiveInfo {
  id: number;
  kind: ObjectiveKind;
  team: number;
  x: number;
  y: number;
  max_health: number;
  spawn_tick: number;
  death_tick: number | null;
}

/** A sparse objective health sample, reconstructed per tick like items. */
export interface ObjectiveHealthEvent {
  tick: number;
  id: number;
  health: number;
  max_health: number;
}

/** A live objective resolved at the current tick, ready to draw. */
export interface ObjectiveState {
  kind: ObjectiveKind;
  x: number;
  y: number;
  health: number;
  max_health: number;
  color: string;
}

/** The Rift's live world position, reconstructed from sparse lifecycle events. */
export interface RiftState {
  x: number;
  y: number;
  color: string;
  opacity: number;
}

/** Shared per-kind icon, used by both the map overlay and the feed. */
export const OBJECTIVE_ICONS: Record<ObjectiveKind, LucideIcon> = {
  guardian: Shield,
  walker: Castle,
  base_guardian: ShieldHalf,
  shrine: Gem,
  patron: Crown,
  mid_boss: Skull,
  urn: Amphora,
  rift: Orbit,
  objective: Flag,
};

/** Stable objective kind slugs emitted by the parser. */
export type ObjectiveKind =
  | "guardian"
  | "walker"
  | "shrine"
  | "base_guardian"
  | "patron"
  | "mid_boss"
  | "urn"
  | "rift"
  | "objective";

export type ObjectiveAction =
  | "destroyed"
  | "killed"
  | "spawns"
  | "opened"
  | "captured"
  | "expired";

/**
 * An objective destruction. `team` is the losing/owning team (−1/4 for the
 * neutral Mid-Boss); `x`/`y` are world-space (null only if the message ever
 * omits a position).
 */
export interface ObjectiveEvent {
  tick: number;
  kind: ObjectiveKind;
  action: ObjectiveAction;
  team: number;
  killer_hero_id: number;
  x: number | null;
  y: number | null;
}

export interface ItemEvent {
  tick: number;
  hero_id: number;
  ability_id: number;
  ability_name: string;
  change: "purchased" | "upgraded" | "sold";
}

export interface KillEvent {
  tick: number;
  attacker_hero_id: number;
  victim_hero_id: number;
  x: number;
  y: number;
}

export interface AbilityEvent {
  tick: number;
  hero_id: number;
  ability_name: string;
}

/**
 * Gun shots fired by a hero, aggregated over one sampled frame's tick window
 * (count > 0 only). `tick` matches a PositionFrame tick; drives the live-map
 * muzzle pulses.
 */
export interface FireEvent {
  tick: number;
  hero_id: number;
  count: number;
}

export interface KillMarker {
  x: number;
  y: number;
  color: string;
}

export interface ObjectiveMarker {
  x: number;
  y: number;
  color: string;
  kind: ObjectiveKind;
}

// Map world bounds extracted from the .vmap data: a 21504 × 21504 square
// centered on the origin. World +Y is "up" on the minimap, so we flip Y
// when projecting into image space.
export const WORLD_MIN = -10752;
export const WORLD_SIZE = 21504;

// Deadlock map coordinates use Source/Hammer units (approximately one inch).
// Keep the gameplay-facing radius in metres and convert only for map drawing.
export const RIFT_RADIUS_METERS = 20;
const SOURCE_UNITS_PER_METER = 39.37007874;
const RIFT_RADIUS_WORLD_UNITS =
  RIFT_RADIUS_METERS * SOURCE_UNITS_PER_METER;
export const RIFT_COLOR = "#22d3ee";
const RIFT_MARKER_R = 260;

// Sizes are in viewBox (world) units. WORLD_SIZE = 21504, so a dot inner
// radius of 450 ≈ 2.1% of the map width — roughly 17px on a 800px map.
const DOT_INNER_R = 450;
const DOT_BORDER = 130;

// Facing caret: a filled triangle attached to the dot's rim, pointing where
// the hero is looking (yaw only). World units. The base edge sits at
// perpendicular distance CARET_BASE_R from center, so anchoring it at
// DOT_INNER_R makes the base tangent to the inner circle; its corners then
// tuck under the ring stroke and the tip pokes outward.
const CARET_BASE_R = DOT_INNER_R;
// Tip extent: nudged up a bit from 705 → height ~320 (still well short of the
// original 510).
const CARET_TIP_R = 770;
const CARET_HALF_W = 260;

// Neutral (gold) accent for jungle camp chevrons.
const NEUTRAL_CAMP_COLOR = "#e0b84a";
const BREAKABLE_COLOR = "#fb923c";
const SINNER_COLOR = "#facc15";

// Warm muzzle-flash palette for the gunfire overlay — deliberately off the team
// colors so a firing hero reads as "shooting" regardless of side.
const MUZZLE_COLOR = "#ffcf6b";
const MUZZLE_CORE = "#fff4d0";
// Shots-per-frame (≈0.125s window) that saturates the pulse intensity.
const MUZZLE_FULL_SHOTS = 3;

// Cyan accent for the urn (Idol), shared with the objectives feed.
export const URN_COLOR = "#22d3ee";

// Lane trooper dot radius (world units) — small; counter-scaled to stay ~4px.
const TROOPER_R = 95;

// Height that splits the tunnels from the surface: heroes with z < 0 are
// underground. A hero shown on the "other" layer (a tunnel hero on the surface
// view, or vice versa) is dimmed to this opacity rather than hidden.
const Z_TUNNEL_CUTOFF = 0;
const OFF_LAYER_OPACITY = 0.45;

// Toggleable map layers (the buttons in the map's upper-left).
type LayerKey =
  | "heroes"
  | "gunfire"
  | "troopers"
  | "neutrals"
  | "breakables"
  | "sinners"
  | "objectives"
  | "urn";
type Layers = Record<LayerKey, boolean>;
const LAYER_TOGGLES: {
  key: LayerKey;
  label: string;
  Icon: LucideIcon;
  desc: string;
}[] = [
  { key: "heroes", label: "Heroes", Icon: Users, desc: "Player hero positions" },
  {
    key: "gunfire",
    label: "Gunfire",
    Icon: Crosshair,
    desc: "Muzzle pulses when a hero fires their gun",
  },
  {
    key: "troopers",
    label: "Troopers",
    Icon: Swords,
    desc: "Lane creeps marching down each lane",
  },
  {
    key: "neutrals",
    label: "Neutrals",
    Icon: Trees,
    desc: "Neutral jungle camps — chevrons mark camp size",
  },
  {
    key: "breakables",
    label: "Breakables",
    Icon: PackageOpen,
    desc: "Recently broken crates, statues, and street props",
  },
  {
    key: "sinners",
    label: "Sinners",
    Icon: CircleDollarSign,
    desc: "Sinner's Sacrifice machines and their current health",
  },
  {
    key: "objectives",
    label: "Objectives",
    Icon: Castle,
    desc: "Guardians, Walkers, Shrines, Patron & Mid-Boss",
  },
  {
    key: "urn",
    label: "Urn",
    Icon: Amphora,
    desc: "The urn's (Idol's) live location",
  },
];

export type MapLayer = "surface" | "tunnels";

export const LAYERS: Record<MapLayer, { label: string; src: string }> = {
  surface: {
    label: "Surface",
    src: "/minimap/minimap_midtown_mid_psd_dd4bcbf9.webp",
  },
  tunnels: {
    label: "Tunnels",
    src: "/minimap/minimap_midtown_mid_tunnels_psd.webp",
  },
};

function prettifyBreakable(name: string): string {
  if (!name || name === "BREAKABLE_NOT_FOUND") return "Breakable prop";
  return name
    .replace(/^citadel_(?:breakable_)?(?:prop_)?/, "")
    .replace(/_\d+$/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function teamColor(team: number) {
  return TEAM_COLORS[team] ?? "#888";
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

// Pan is in container pixels. At zoom=z the content is z× its base size, so
// the maximum pan that keeps the edges in view is ((z - 1) * dim) / 2.
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

export function MapView({
  frame,
  className,
  meta,
  killMarkers,
  objectiveMarkers,
  objectiveStates,
  rift,
  campStates,
  breakableMarkers,
  sinnerStates,
  firing,
  onSelectPlayer,
}: {
  frame: PositionFrame | undefined;
  className?: string;
  meta?: React.ReactNode;
  killMarkers?: KillMarker[];
  objectiveMarkers?: ObjectiveMarker[];
  objectiveStates?: ObjectiveState[];
  rift?: RiftState | null;
  campStates?: NeutralCampState[];
  breakableMarkers?: BreakableEvent[];
  sinnerStates?: SinnerMachineState[];
  /** hero_id → gun shots fired in the current frame's window (count > 0). */
  firing?: Map<number, number>;
  onSelectPlayer?: (heroId: number) => void;
}) {
  const [layer, setLayer] = React.useState<MapLayer>("surface");
  const [layers, setLayers] = React.useState<Layers>({
    heroes: true,
    gunfire: true,
    troopers: true,
    neutrals: true,
    breakables: true,
    sinners: true,
    objectives: true,
    urn: true,
  });
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [dragging, setDragging] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const zoomRef = React.useRef(zoom);
  const panRef = React.useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const reset = React.useCallback(() => {
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

  // Wheel zoom — bound via addEventListener so we can preventDefault to stop
  // the page from scrolling. React's onWheel is passive on the root.
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
      // Zoom toward the cursor: keep the world point under the pointer fixed.
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = next / prevZoom;
      const nextPan = clampPan(
        next,
        { x: cx - (cx - prevPan.x) * ratio, y: cy - (cy - prevPan.y) * ratio },
        rect.width,
        rect.height,
      );
      setZoom(next);
      setPan(nextPan);
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
    // Don't hijack clicks on overlay controls (e.g. the reset button) or on a
    // player marker — let the underlying element receive the click instead of
    // starting a pan.
    if (
      e.target instanceof Element &&
      e.target.closest("button, [data-hero]")
    ) {
      return;
    }
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

  return (
    <div className={cn("flex h-full min-h-0 flex-col items-stretch gap-3", className)}>
      <div className="flex flex-shrink-0 items-center justify-between gap-3">
        <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {meta}
        </div>
        <Tabs
          value={layer}
          onValueChange={(v) => setLayer(v as MapLayer)}
          className="flex-shrink-0"
        >
          <TabsList>
            <TabsTrigger value="surface">Surface</TabsTrigger>
            <TabsTrigger value="tunnels">Tunnels</TabsTrigger>
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
          "relative aspect-square h-full max-h-full max-w-full touch-none overflow-hidden rounded-lg border border-border bg-card select-none",
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
          {/* Render both layers stacked so swapping is just an opacity flip —
              no image reflow or fetch flash on tab switch. */}
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
          <svg
            viewBox={`0 0 ${WORLD_SIZE} ${WORLD_SIZE}`}
            className="absolute inset-0 h-full w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <clipPath id="hero-dot-clip" clipPathUnits="userSpaceOnUse">
                <circle cx={0} cy={0} r={DOT_INNER_R} />
              </clipPath>
            </defs>
            {/* Lane troopers: small team-colored dots. Bottom layer. Each is a
                single packed int (qx/qy/team) — see pack_trooper in the parser.
                Surface-only — they don't traverse the tunnels. */}
            {layer === "surface" &&
              layers.troopers &&
              frame?.troopers?.map((packed, i) => {
              const team = packed & 1 ? 3 : 2;
              const wx = ((packed >>> 11) & 0x3ff) * 32 - 16384;
              const wy = ((packed >>> 1) & 0x3ff) * 32 - 16384;
              return (
                <circle
                  key={`tr-${i}`}
                  cx={wx - WORLD_MIN}
                  cy={WORLD_SIZE - (wy - WORLD_MIN)}
                  r={TROOPER_R / zoom}
                  fill={teamColor(team)}
                  fillOpacity={0.7}
                />
              );
            })}
            {/* Neutral camps: 1–3 stacked chevrons by size, bright when up and
                dimmed when cleared. Bottom layer, beneath objectives + heroes.
                Surface-only — the jungle camps live above the tunnels. */}
            {layer === "surface" &&
              layers.neutrals &&
              campStates?.map((c, i) => {
              const ccx = c.x - WORLD_MIN;
              const ccy = WORLD_SIZE - (c.y - WORLD_MIN);
              const n = Math.max(1, Math.min(3, c.size));
              const chevW = 280;
              const chevH = 130;
              const sp = 170; // vertical spacing between stacked chevrons
              // Apex-up carets stacked vertically, centered on the camp.
              const d = Array.from({ length: n }, (_, k) => {
                const y = (k - (n - 1) / 2) * sp;
                return `M ${-chevW / 2} ${y + chevH / 2} L 0 ${y - chevH / 2} L ${chevW / 2} ${y + chevH / 2}`;
              }).join(" ");
              const campScale = 1 / zoom;
              return (
                <g
                  key={`camp-${i}`}
                  transform={`translate(${ccx} ${ccy}) scale(${campScale})`}
                  opacity={c.up ? 1 : 0.25}
                >
                  <path
                    d={d}
                    fill="none"
                    stroke={NEUTRAL_CAMP_COLOR}
                    strokeWidth={70}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })}
            {layers.breakables &&
              breakableMarkers?.map((event) => {
                const onLayer = (event.z < Z_TUNNEL_CUTOFF) === (layer === "tunnels");
                if (!onLayer) return null;
                const radius = 230;
                const label = prettifyBreakable(event.subclass_name);
                return (
                  <g
                    key={`breakable-${event.id}-${event.serial}`}
                    transform={`translate(${event.x - WORLD_MIN} ${WORLD_SIZE - (event.y - WORLD_MIN)}) scale(${1 / zoom})`}
                  >
                    <title>{`${label} broken`}</title>
                    <circle
                      r={radius}
                      fill="rgba(12,14,22,0.82)"
                      stroke={BREAKABLE_COLOR}
                      strokeWidth={70}
                    />
                    <PackageOpen
                      x={-radius * 0.55}
                      y={-radius * 0.55}
                      width={radius * 1.1}
                      height={radius * 1.1}
                      color="#fff"
                      strokeWidth={2.4}
                    />
                  </g>
                );
              })}
            {layers.sinners &&
              sinnerStates?.map((machine) => {
                const onLayer =
                  (machine.z < Z_TUNNEL_CUTOFF) === (layer === "tunnels");
                if (!onLayer) return null;
                const radius = 290;
                const ratio =
                  machine.max_health > 0
                    ? Math.max(0, Math.min(1, machine.health / machine.max_health))
                    : 1;
                const circumference = 2 * Math.PI * radius;
                return (
                  <g
                    key={`sinner-${machine.id}-${machine.serial}`}
                    transform={`translate(${machine.x - WORLD_MIN} ${WORLD_SIZE - (machine.y - WORLD_MIN)}) scale(${1 / zoom})`}
                  >
                    <title>{`Sinner's Sacrifice · ${machine.health}/${machine.max_health}${machine.damage ? ` · ${machine.damage} damage` : ""}`}</title>
                    {machine.hit && (
                      <circle
                        r={radius + 150}
                        fill={SINNER_COLOR}
                        fillOpacity={0.2}
                      />
                    )}
                    <circle r={radius} fill="rgba(12,14,22,0.84)" />
                    <circle
                      r={radius}
                      fill="none"
                      stroke="rgba(255,255,255,0.16)"
                      strokeWidth={80}
                    />
                    <circle
                      r={radius}
                      fill="none"
                      stroke={SINNER_COLOR}
                      strokeWidth={80}
                      strokeDasharray={`${ratio * circumference} ${circumference}`}
                      transform="rotate(-90)"
                    />
                    <CircleDollarSign
                      x={-radius * 0.55}
                      y={-radius * 0.55}
                      width={radius * 1.1}
                      height={radius * 1.1}
                      color="#fff"
                      strokeWidth={2.4}
                    />
                  </g>
                );
              })}
            {/* Live objectives: icon + a partial ring showing health / max.
                Drawn beneath the hero dots so heroes stay on top. */}
            {layers.objectives &&
              objectiveStates?.map((o, i) => {
              // The tunnels are only relevant for the Mid-Boss pit; lane
              // buildings live on the surface, so hide them down here.
              if (layer === "tunnels" && o.kind !== "mid_boss") return null;
              const ocx = o.x - WORLD_MIN;
              const ocy = WORLD_SIZE - (o.y - WORLD_MIN);
              const major = o.kind === "patron" || o.kind === "mid_boss";
              const R = major ? 360 : 250; // node radius in world units
              const ringW = major ? 95 : 75;
              const ratio =
                o.max_health > 0
                  ? Math.max(0, Math.min(1, o.health / o.max_health))
                  : 1;
              const circ = 2 * Math.PI * R;
              const Icon = OBJECTIVE_ICONS[o.kind] ?? OBJECTIVE_ICONS.objective;
              const iconSize = R * 1.15;
              const nodeScale = 1 / zoom;
              return (
                <g
                  key={`obj-state-${i}`}
                  transform={`translate(${ocx} ${ocy}) scale(${nodeScale})`}
                >
                  <circle r={R} fill="rgba(12,14,22,0.82)" />
                  <circle
                    r={R}
                    fill="none"
                    stroke="rgba(255,255,255,0.16)"
                    strokeWidth={ringW}
                  />
                  {ratio > 0 && (
                    <circle
                      r={R}
                      fill="none"
                      stroke={o.color}
                      strokeWidth={ringW}
                      strokeDasharray={`${ratio * circ} ${circ}`}
                      transform="rotate(-90)"
                    />
                  )}
                  <Icon
                    x={-iconSize / 2}
                    y={-iconSize / 2}
                    width={iconSize}
                    height={iconSize}
                    color="#fff"
                    strokeWidth={2.4}
                  />
                </g>
              );
            })}
            {/* The live Rift capture area. Its 20 m radius stays in world
                space while the badge and border remain legible when zoomed. */}
            {layer === "surface" && layers.objectives && rift && (
              <g
                transform={`translate(${rift.x - WORLD_MIN} ${WORLD_SIZE - (rift.y - WORLD_MIN)})`}
                opacity={rift.opacity}
                style={{ pointerEvents: "none" }}
              >
                <title>{`Rift (${RIFT_RADIUS_METERS} m radius)`}</title>
                <circle
                  r={RIFT_RADIUS_WORLD_UNITS}
                  fill="#000"
                  fillOpacity={0.16}
                  stroke={rift.color}
                  strokeWidth={70 / zoom}
                />
                <g transform={`scale(${1 / zoom})`}>
                  <circle
                    r={RIFT_MARKER_R}
                    fill="rgba(12,14,22,0.88)"
                    stroke={rift.color}
                    strokeWidth={75}
                  />
                  <image
                    href={assetUrl("/objectives/minimap_icon_koth.svg")}
                    x={-RIFT_MARKER_R * 0.58}
                    y={-RIFT_MARKER_R * 0.58}
                    width={RIFT_MARKER_R * 1.16}
                    height={RIFT_MARKER_R * 1.16}
                    preserveAspectRatio="xMidYMid meet"
                  />
                </g>
              </g>
            )}
            {layers.heroes &&
              frame?.players.map((p) => {
              const cx = p.x - WORLD_MIN;
              const cy = WORLD_SIZE - (p.y - WORLD_MIN);
              const portrait = heroPortraitUrl(p.hero_id);
              const stroke = teamColor(p.team);
              // Wrapper already scales by `zoom`; counter-scale the dot by the
              // same factor so its on-screen size stays constant at the
              // zoomed-out (base) size — never larger than the starting size,
              // but bigger than if we let it keep shrinking as you zoom in.
              const dotScale = 1 / zoom;
              // A hero belongs to whichever layer their height puts them on;
              // when viewing the other layer they're dimmed (not hidden), and
              // dying dims them further still.
              const inTunnel = p.z < Z_TUNNEL_CUTOFF;
              const onLayer = inTunnel === (layer === "tunnels");
              const opacity =
                (p.alive ? 1 : 0.35) * (onLayer ? 1 : OFF_LAYER_OPACITY);
              // Gunfire: shots fired by this hero in the current frame's
              // window. >0 lights the dot and triggers an expanding pulse.
              const shots = (layers.gunfire && p.alive && firing?.get(p.hero_id)) || 0;
              const muzzle = Math.min(1, shots / MUZZLE_FULL_SHOTS);
              return (
                <g
                  key={p.slot}
                  data-hero={p.hero_id}
                  transform={`translate(${cx} ${cy}) scale(${dotScale})`}
                  opacity={opacity}
                  onClick={
                    onSelectPlayer
                      ? () => onSelectPlayer(p.hero_id)
                      : undefined
                  }
                  style={onSelectPlayer ? { cursor: "pointer" } : undefined}
                >
                  {/* Facing caret: filled triangle on the rim pointing where
                      the hero looks (yaw). Drawn first so its base tucks under
                      the ring. Screen Y is flipped vs world, so world yaw
                      becomes a clockwise rotate(-yaw). */}
                  {p.alive && (
                    <path
                      d={`M${CARET_BASE_R} ${CARET_HALF_W} L${CARET_TIP_R} 0 L${CARET_BASE_R} ${-CARET_HALF_W} Z`}
                      transform={`rotate(${-p.yaw})`}
                      fill={stroke}
                    />
                  )}
                  {portrait ? (
                    <image
                      href={portrait}
                      x={-DOT_INNER_R}
                      y={-DOT_INNER_R}
                      width={DOT_INNER_R * 2}
                      height={DOT_INNER_R * 2}
                      clipPath="url(#hero-dot-clip)"
                      preserveAspectRatio="xMidYMid slice"
                    />
                  ) : (
                    <circle r={DOT_INNER_R} fill={stroke} />
                  )}
                  <circle
                    r={DOT_INNER_R + DOT_BORDER / 2}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={DOT_BORDER}
                  />
                  {/* Muzzle pulse: a warm accent over the team ring plus an
                      expanding radar pulse, looping (via SMIL) while the hero
                      keeps firing, and a flash spark at the gun (yaw). */}
                  {shots > 0 && (
                    <g style={{ pointerEvents: "none" }}>
                      <circle
                        r={DOT_INNER_R + DOT_BORDER / 2}
                        fill="none"
                        stroke={MUZZLE_COLOR}
                        strokeWidth={DOT_BORDER}
                        strokeOpacity={0.45 + 0.45 * muzzle}
                      />
                      <circle
                        r={DOT_INNER_R + DOT_BORDER}
                        fill="none"
                        stroke={MUZZLE_COLOR}
                        strokeWidth={90}
                      >
                        <animate
                          attributeName="r"
                          values={`${DOT_INNER_R};${(DOT_INNER_R + DOT_BORDER) * 2}`}
                          dur="0.55s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.8;0"
                          dur="0.55s"
                          repeatCount="indefinite"
                        />
                      </circle>
                      <circle
                        cx={CARET_TIP_R + 120}
                        cy={0}
                        r={70 + 70 * muzzle}
                        transform={`rotate(${-p.yaw})`}
                        fill={MUZZLE_CORE}
                        fillOpacity={0.9}
                      />
                    </g>
                  )}
                </g>
              );
            })}
            {layers.heroes &&
              killMarkers?.map((k, i) => {
              const cx = k.x - WORLD_MIN;
              const cy = WORLD_SIZE - (k.y - WORLD_MIN);
              const r = 320; // X glyph extent in world units
              const w = 130; // stroke width
              const markerScale = 1 / Math.pow(zoom, 1.2);
              return (
                <g
                  key={`kill-${i}`}
                  transform={`translate(${cx} ${cy}) scale(${markerScale})`}
                >
                  <line
                    x1={-r}
                    y1={-r}
                    x2={r}
                    y2={r}
                    stroke={k.color}
                    strokeWidth={w}
                    strokeLinecap="round"
                  />
                  <line
                    x1={-r}
                    y1={r}
                    x2={r}
                    y2={-r}
                    stroke={k.color}
                    strokeWidth={w}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
            {layers.objectives &&
              objectiveMarkers?.map((o, i) => {
              if (layer === "tunnels" && o.kind !== "mid_boss") return null;
              const cx = o.x - WORLD_MIN;
              const cy = WORLD_SIZE - (o.y - WORLD_MIN);
              // Marquee objectives read a little larger than lane buildings.
              const major = o.kind === "patron" || o.kind === "mid_boss";
              const r = major ? 520 : 360; // diamond half-extent, world units
              const markerScale = 1 / Math.pow(zoom, 1.2);
              return (
                <g
                  key={`obj-${i}`}
                  transform={`translate(${cx} ${cy}) scale(${markerScale})`}
                >
                  <path
                    d={`M0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`}
                    fill={o.color}
                    fillOpacity={0.85}
                    stroke="#fff"
                    strokeWidth={90}
                    strokeOpacity={0.9}
                    strokeLinejoin="round"
                  />
                </g>
              );
            })}
            {/* Live urn (Idol): a cyan badge wherever the urn entity currently
                is (on the ground or mid auto-return). Flat [x0,y0,x1,y1,…];
                usually one, briefly two during a handoff. Rendered last so it
                sits on top of everything, including a co-located hero. */}
            {layers.urn &&
              Array.from(
                { length: Math.floor((frame?.urns.length ?? 0) / 2) },
                (_, i) => {
                  const wx = frame!.urns[i * 2];
                  const wy = frame!.urns[i * 2 + 1];
                  const ucx = wx - WORLD_MIN;
                  const ucy = WORLD_SIZE - (wy - WORLD_MIN);
                  const R = 260;
                  const iconSize = R * 1.15;
                  const UrnIcon = OBJECTIVE_ICONS.urn;
                  return (
                    <g
                      key={`urn-${i}`}
                      transform={`translate(${ucx} ${ucy}) scale(${1 / zoom})`}
                    >
                      <circle r={R} fill="rgba(12,14,22,0.82)" />
                      <circle
                        r={R}
                        fill="none"
                        stroke={URN_COLOR}
                        strokeWidth={75}
                      />
                      <UrnIcon
                        x={-iconSize / 2}
                        y={-iconSize / 2}
                        width={iconSize}
                        height={iconSize}
                        color={URN_COLOR}
                        strokeWidth={2.4}
                      />
                    </g>
                  );
                },
              )}
          </svg>
        </div>

        {/* Layer toggles, mirroring the reset button (upper-right). */}
        <div className="absolute top-2 left-2 flex gap-1">
          {LAYER_TOGGLES.map(({ key, label, Icon, desc }) => {
            // Troopers and neutrals are surface-only, so their toggles are
            // disabled (and visibly off) while viewing the tunnels.
            const surfaceOnly = key === "troopers" || key === "neutrals";
            const disabled = surfaceOnly && layer === "tunnels";
            const on = layers[key] && !disabled;
            return (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      setLayers((l) => ({ ...l, [key]: !l[key] }))
                    }
                    aria-pressed={on}
                    aria-label={`${layers[key] ? "Hide" : "Show"} ${label.toLowerCase()}`}
                    className={cn(
                      "rounded-md border border-border p-1.5 shadow-sm backdrop-blur transition-colors",
                      "disabled:cursor-not-allowed disabled:opacity-40",
                      on
                        ? "bg-background/80 text-foreground hover:bg-background"
                        : "bg-background/40 text-muted-foreground/50 hover:bg-background/60",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground"> — {desc}</span>
                  {surfaceOnly && (
                    <span className="text-muted-foreground"> (surface only)</span>
                  )}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

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
            onClick={reset}
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
  );
}
