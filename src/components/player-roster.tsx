import * as React from "react";
import { Trophy } from "lucide-react";

import type { PlayerPosition } from "@/components/map-view";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { assetUrl, cn } from "@/lib/utils";
import heroPortraits from "@/data/hero-portraits.json";

function SoulIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 35 67"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <path d="M26.9138 31.4439C26.9138 27.5 23.9943 24.5165 20.122 23.3934C18.0285 22.7851 15.8466 22.4807 13.7253 21.9625C11.5009 21.4173 9.9646 20.0603 9.08312 17.9792C8.36709 16.2887 7.93788 14.5768 8.27609 12.7297C8.72069 10.3217 10.1124 8.69012 12.4814 7.9193C13.5989 7.55396 14.7626 7.30356 15.9215 7.08659C17.9922 6.70188 19.0417 5.50573 19.0215 3.43199C19.0152 2.91871 18.9563 2.4035 18.9842 1.89236C19.0724 0.276758 19.9277 -0.21371 21.4556 0.452917C24.567 1.81372 26.5375 5.50377 25.8686 8.73587C25.4236 10.8923 23.8814 12.074 21.9371 12.8858C21.5755 13.0365 21.2059 13.1822 20.8279 13.287C19.8855 13.5423 19.2598 14.0736 19.2194 15.0701C19.1767 16.105 19.8757 16.6201 20.7693 16.8889C23.3864 17.6782 25.8642 18.7028 28.0109 20.4271C35.7594 26.6466 36.2837 38.0573 28.5699 45.2105C28.0126 45.7281 27.5171 45.9216 26.9138 45.259C24.2227 42.3094 20.7425 40.9377 16.789 40.714C13.3916 40.522 10.8454 37.1419 10.6319 34.76C10.5343 33.6754 10.902 32.5158 11.2392 31.4439C11.5054 30.5987 11.9925 29.7278 11.0818 29.128C10.1153 28.4905 9.00383 28.925 8.62254 29.8358C8.02624 31.2548 7.51593 32.814 7.47654 34.3289C7.37019 38.3344 11.3007 42.9194 16.5345 43.805C17.9148 44.0396 19.3028 44.2511 20.6707 44.5449C23.9427 45.2467 25.4099 47.6312 26.1193 50.4999C26.7704 53.1255 26.5237 55.7723 24.087 57.4655C22.7185 58.4166 20.9611 59.0028 19.2899 59.3261C16.4179 59.8798 15.5025 60.8382 15.5248 63.7332C15.5323 64.5597 15.3751 65.7038 14.8248 66.1495C13.9459 66.8559 12.9383 66.0956 12.1043 65.5206C10.1094 64.1461 8.79732 62.3885 8.64843 59.9082C8.45637 56.6995 9.62662 54.8319 12.6962 53.6341C13.0632 53.491 13.4465 53.3939 13.8162 53.2585C15.552 52.6238 15.8969 50.8844 14.4344 49.7549C13.8016 49.2647 12.9967 48.928 12.2168 48.686C0.0862024 44.8843 -3.58571 30.2317 5.36349 21.3667C6.22745 20.5117 6.80273 20.3865 7.6864 21.3562C10.3001 24.2273 13.704 25.5999 17.573 25.8066C21.2523 26.0029 24.1059 29.754 24.019 32.7659C23.9947 33.5799 23.5912 34.3985 23.2768 35.1827C22.9446 36.0158 22.5604 36.9009 23.5052 37.4823C24.5056 38.0963 25.5192 37.627 25.9611 36.7232C26.2105 36.2133 26.9138 35.3878 26.9138 31.4439Z" />
    </svg>
  );
}

function ApIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 129 129"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <path d="M122.87 50.1926L79.1249 6.47787C71.2082 -1.43338 58.3182 -1.43338 50.4014 6.47787L6.75787 50.1926C-1.15887 58.1038 -1.15887 70.985 6.75787 78.8962L50.5029 122.611C58.4197 130.522 71.3098 130.522 79.2264 122.611L122.972 78.8962C130.787 70.985 130.787 58.0025 122.87 50.1926ZM94.3494 59.7267L59.1301 108.918C57.8106 110.744 56.7957 110.338 56.7957 108.209V72.405H36.9024C34.6694 72.405 33.959 70.985 35.2784 69.1594L70.4978 19.9676C71.8172 18.1418 72.8321 18.5476 72.8321 20.6775V56.481H92.7255C94.857 56.5825 95.5674 58.0025 94.3494 59.7267Z" />
    </svg>
  );
}

export interface PlayerInfo {
  name: string;
  hero_id: number;
  hero_name: string;
  team: number;
  /** Packed as tier * 10 + subdivision; 0 means unavailable or unranked. */
  rank: number;
}

export interface HeroItems {
  items: { ability_id: number; ability_name: string }[];
}

export const TEAM_NAMES: Record<number, string> = {
  2: "Hidden King",
  3: "Archmother",
};

export const TEAM_COLORS: Record<number, string> = {
  2: "#5b8df7", // blue
  3: "#e08438", // orange
};

export const TEAM_LOGOS: Record<number, string> = {
  2: "/teams/starburst_team2.svg", // Hidden King
  3: "/teams/starburst_team1.svg", // Archmother
};

// hero_id -> small-portrait URL, generated from heroes.vdata by
// scripts/build-hero-portraits.ts (run via `bun run sync`). Regenerate after a
// game update rather than editing by hand.
const HERO_PORTRAITS = heroPortraits as Record<string, string>;

export function heroPortraitUrl(heroId: number): string | null {
  const url = HERO_PORTRAITS[String(heroId)];
  return url ? assetUrl(url) : null;
}

export function compactNumber(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Derived, cumulative-to-the-current-tick stats computed across frames (see
// DemoView):
//  • uptime   — share of elapsed regulation time the hero has been alive.
//  • distance — world-space path length travelled.
//  • kp       — kill participation: (kills + assists) / team kills, this tick.
//  • teh      — time in enemy half: share of *alive* time spent past the
//               midline (closer to the enemy Patron than their own).
//  • dpm      — hero damage per elapsed regulation minute.
//  • spm      — souls (net worth) per elapsed regulation minute.
//  • spct     — soul percentage of the team: net worth / team net worth.
//  • spd      — average speed: distance ÷ time alive (world units/sec).
//  • depth    — map forwardness: avg position from own (0%) to enemy (100%) base.
//  • dmgShare — share of the team's hero damage at this tick.
//  • objpm    — objective damage per elapsed regulation minute.
export interface DerivedStats {
  uptime: number; // 0..100 (%)
  distance: number; // world (Hammer) units
  kp: number; // 0..100 (%)
  teh: number; // 0..100 (%)
  dpm: number; // hero damage / regulation minute
  spm: number; // net worth / regulation minute
  spct: number; // 0..100 (%) share of team net worth
  spd: number; // world units / second (while alive)
  depth: number; // 0..100 (%) own base → enemy base
  dmgShare: number; // 0..100 (%) share of team hero damage
  objpm: number; // objective damage / regulation minute
}

// A roster row's full data: the live per-tick stats plus the derived ones.
export interface RosterRow {
  live: PlayerPosition | undefined;
  derived: DerivedStats | undefined;
}

// Per-player stat columns for the roster table. Columns are grouped into four
// sets chosen by the Stats toggle (applied to both teams at once):
//  • Basic    — combat & economy (KDA, souls, damage, healing).
//  • Advanced — kill participation, uptime, damage rates & shares.
//  • Econ     — net worth, souls/min, soul share, damage per net worth.
//  • Move     — distance, speed, time in enemy half, map depth.
// Every group renders the same number of columns so the table width is stable;
// groups with fewer real stats are padded with blank columns on the right.
type StatColumn = {
  key: string;
  label: string;
  title: string;
  render: (row: RosterRow) => React.ReactNode;
};

const roundPct = (v: number) => `${Math.round(v)}%`;

export type StatGroup = "basic" | "advanced" | "econ" | "position";

// Total columns per group — matches Basic, the widest set.
const GROUP_WIDTH = 6;

const K_COLUMN: StatColumn = {
  key: "k",
  label: "K",
  title: "Kills",
  render: ({ live }) => live?.kills ?? 0,
};
const D_COLUMN: StatColumn = {
  key: "d",
  label: "D",
  title: "Deaths",
  render: ({ live }) => live?.deaths ?? 0,
};
const A_COLUMN: StatColumn = {
  key: "a",
  label: "A",
  title: "Assists",
  render: ({ live }) => live?.assists ?? 0,
};
const SOUL_COLUMN: StatColumn = {
  key: "soul",
  label: "SOUL",
  title: "Net worth",
  render: ({ live }) => compactNumber(live?.net_worth ?? 0),
};
const DMG_COLUMN: StatColumn = {
  key: "dmg",
  label: "DMG",
  title: "Hero damage",
  render: ({ live }) => compactNumber(live?.hero_damage ?? 0),
};
const HEAL_COLUMN: StatColumn = {
  key: "heal",
  label: "HEAL",
  title: "Hero healing",
  render: ({ live }) => compactNumber(live?.hero_healing ?? 0),
};
const UPT_COLUMN: StatColumn = {
  key: "upt",
  label: "UPT",
  title: "Uptime — % of elapsed regulation time spent alive",
  render: ({ derived }) => roundPct(derived?.uptime ?? 0),
};
const DIST_COLUMN: StatColumn = {
  key: "dist",
  label: "DIST",
  title: "Distance travelled (world units)",
  render: ({ derived }) => compactNumber(Math.round(derived?.distance ?? 0)),
};
const SPD_COLUMN: StatColumn = {
  key: "spd",
  label: "SPD",
  title: "Average speed — distance ÷ time alive (world units/sec)",
  render: ({ derived }) => compactNumber(Math.round(derived?.spd ?? 0)),
};
const KP_COLUMN: StatColumn = {
  key: "kp",
  label: "KP",
  title: "Kill participation — (kills + assists) ÷ team kills",
  render: ({ derived }) => roundPct(derived?.kp ?? 0),
};
const TEH_COLUMN: StatColumn = {
  key: "teh",
  label: "TEH",
  title: "Time in enemy half — % of alive time past the midline",
  render: ({ derived }) => roundPct(derived?.teh ?? 0),
};
const DEPTH_COLUMN: StatColumn = {
  key: "depth",
  label: "DEPTH",
  title: "Map depth — avg forwardness from own (0%) to enemy (100%) base",
  render: ({ derived }) => roundPct(derived?.depth ?? 0),
};
const DPM_COLUMN: StatColumn = {
  key: "dpm",
  label: "DPM",
  title: "Damage per minute — hero damage ÷ elapsed regulation minutes",
  render: ({ derived }) => compactNumber(Math.round(derived?.dpm ?? 0)),
};
const DMG_SHARE_COLUMN: StatColumn = {
  key: "dmgshare",
  label: "DMG%",
  title: "Damage share — hero damage ÷ team's hero damage",
  render: ({ derived }) => roundPct(derived?.dmgShare ?? 0),
};
// Damage per death: hero damage ÷ deaths (a 0-death hero divides by 1, so the
// value is their raw damage). Output weighted by survivability. Live-only.
const DMG_PER_DEATH_COLUMN: StatColumn = {
  key: "dpd",
  label: "DMG/D",
  title: "Damage per death — hero damage ÷ deaths",
  render: ({ live }) =>
    compactNumber(
      Math.round((live?.hero_damage ?? 0) / Math.max(1, live?.deaths ?? 0)),
    ),
};
const OBJ_PM_COLUMN: StatColumn = {
  key: "objpm",
  label: "OBJ/m",
  title:
    "Objective damage per minute — objective damage ÷ elapsed regulation minutes",
  render: ({ derived }) => compactNumber(Math.round(derived?.objpm ?? 0)),
};
const SPM_COLUMN: StatColumn = {
  key: "spm",
  label: "SPM",
  title: "Souls per minute — net worth ÷ elapsed regulation minutes",
  render: ({ derived }) => compactNumber(Math.round(derived?.spm ?? 0)),
};
const SPCT_COLUMN: StatColumn = {
  key: "spct",
  label: "SPCT",
  title: "Soul percentage — share of the team's net worth",
  render: ({ derived }) => roundPct(derived?.spct ?? 0),
};
// Damage value: (hero + objective damage) per soul of net worth — how much
// damage a hero converts each soul into. Uses live fields only.
const DMG_PER_NW_COLUMN: StatColumn = {
  key: "dmgnw",
  label: "D/NW",
  title: "Damage per net worth — (hero + objective damage) ÷ net worth",
  render: ({ live }) => {
    const nw = live?.net_worth ?? 0;
    if (nw <= 0) return "—";
    const dmg = (live?.hero_damage ?? 0) + (live?.objective_damage ?? 0);
    return (dmg / nw).toFixed(1);
  },
};

// A spacer column: empty header (no tooltip) and empty cells.
function blankColumn(i: number): StatColumn {
  return { key: `blank-${i}`, label: "", title: "", render: () => "" };
}

// Pad a group out to GROUP_WIDTH so every group is the same width.
function pad(columns: StatColumn[]): StatColumn[] {
  const out = [...columns];
  while (out.length < GROUP_WIDTH) out.push(blankColumn(out.length));
  return out;
}

const STAT_GROUPS: Record<StatGroup, StatColumn[]> = {
  basic: [
    K_COLUMN,
    D_COLUMN,
    A_COLUMN,
    SOUL_COLUMN,
    DMG_COLUMN,
    HEAL_COLUMN,
  ],
  advanced: pad([
    KP_COLUMN,
    UPT_COLUMN,
    DPM_COLUMN,
    DMG_SHARE_COLUMN,
    DMG_PER_DEATH_COLUMN,
    OBJ_PM_COLUMN,
  ]),
  econ: pad([SOUL_COLUMN, SPM_COLUMN, SPCT_COLUMN, DMG_PER_NW_COLUMN]),
  position: pad([DIST_COLUMN, SPD_COLUMN, TEH_COLUMN, DEPTH_COLUMN]),
};

function DiffBadge({ value }: { value: number }) {
  if (value === 0) return null;
  const positive = value > 0;
  const sign = positive ? "+" : "−";
  return (
    <span
      className={cn(
        "ml-0.5 tabular-nums",
        positive ? "text-emerald-500" : "text-red-500",
      )}
    >
      {sign}
      {compactNumber(Math.abs(value))}
    </span>
  );
}

function HeroCell({ player }: { player: PlayerInfo }) {
  const url = heroPortraitUrl(player.hero_id);
  const [errored, setErrored] = React.useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {url && !errored ? (
        <img
          src={url}
          alt={player.hero_name}
          width={28}
          height={28}
          loading="lazy"
          onError={() => setErrored(true)}
          className="size-7 flex-shrink-0 rounded object-contain"
        />
      ) : (
        <div className="size-7 flex-shrink-0 rounded bg-muted" />
      )}
      <span className="min-w-0 truncate">{player.hero_name || "—"}</span>
    </div>
  );
}

export function PlayerRoster({
  roster,
  stats,
  derived,
  team,
  align,
  winner,
  statGroup = "basic",
  onSelect,
}: {
  roster: PlayerInfo[];
  stats: Map<number, PlayerPosition>;
  derived?: Map<number, DerivedStats>;
  team: number;
  align: "left" | "right";
  winner?: number | null;
  statGroup?: StatGroup;
  onSelect: (heroId: number) => void;
}) {
  const columns = STAT_GROUPS[statGroup];
  const teamRoster = roster.filter((p) => p.team === team);
  const accent = TEAM_COLORS[team] ?? "#888";
  const logo = assetUrl(TEAM_LOGOS[team]);
  const label = TEAM_NAMES[team] ?? `Team ${team}`;
  const won = winner != null && winner === team;
  const teamSouls = teamRoster.reduce(
    (sum, p) => sum + (stats.get(p.hero_id)?.net_worth ?? 0),
    0,
  );
  const teamAp = teamRoster.reduce(
    (sum, p) => sum + (stats.get(p.hero_id)?.ap_net_worth ?? 0),
    0,
  );
  const otherTeam = team === 2 ? 3 : 2;
  const otherRoster = roster.filter((p) => p.team === otherTeam);
  const otherSouls = otherRoster.reduce(
    (sum, p) => sum + (stats.get(p.hero_id)?.net_worth ?? 0),
    0,
  );
  const otherAp = otherRoster.reduce(
    (sum, p) => sum + (stats.get(p.hero_id)?.ap_net_worth ?? 0),
    0,
  );
  const soulsDiff = teamSouls - otherSouls;
  const apDiff = teamAp - otherAp;

  return (
    <div className="flex w-full flex-shrink-0 flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-2",
          align === "right" && "flex-row-reverse",
        )}
      >
        {logo ? (
          <img
            src={logo}
            alt=""
            width={20}
            height={20}
            className="size-5 flex-shrink-0 object-contain"
            aria-hidden
          />
        ) : (
          <span
            className="inline-block size-3 rounded-full"
            style={{ backgroundColor: accent }}
            aria-hidden
          />
        )}
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          {label}
        </h2>
        {won && (
          <Trophy
            className="size-4"
            style={{ color: accent }}
            aria-label="Winner"
          />
        )}
        <span className="ml-auto flex items-center gap-2 text-xs font-medium tabular-nums text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <SoulIcon className="size-3" />
                {compactNumber(teamSouls)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Souls <DiffBadge value={soulsDiff} />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <ApIcon className="size-3" />
                {compactNumber(teamAp)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Ability Points (AP) <DiffBadge value={apDiff} />
            </TooltipContent>
          </Tooltip>
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Hero</th>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className={cn(
                    "py-1.5 text-right font-medium",
                    i === columns.length - 1 ? "px-2" : "px-1",
                  )}
                >
                  {c.label ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-default">{c.label}</span>
                      </TooltipTrigger>
                      <TooltipContent>{c.title}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teamRoster.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-2 py-2 text-center text-muted-foreground"
                >
                  —
                </td>
              </tr>
            ) : (
              teamRoster.map((p, i) => {
                const row: RosterRow = {
                  live: stats.get(p.hero_id),
                  derived: derived?.get(p.hero_id),
                };
                return (
                  <tr
                    key={`${p.hero_id}-${i}`}
                    onClick={() => onSelect(p.hero_id)}
                    className="cursor-pointer border-t border-border transition-colors hover:bg-accent/40"
                    title={p.name || undefined}
                  >
                    <td className="px-2 py-1.5">
                      <HeroCell player={p} />
                    </td>
                    {columns.map((c, ci) => (
                      <td
                        key={c.key}
                        className={cn(
                          "py-1.5 text-right",
                          ci === columns.length - 1 ? "px-2" : "px-1",
                        )}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
