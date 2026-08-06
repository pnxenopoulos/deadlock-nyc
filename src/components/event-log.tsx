import * as React from "react";

import { AbilityIcon, prettifyAbilityName } from "@/components/ability-icon";
import {
  OBJECTIVE_ICONS,
  URN_COLOR,
  type AbilityEvent,
  type ChatEvent,
  type KillEvent,
  type ObjectiveEvent,
  type ObjectiveKind,
} from "@/components/map-view";
import {
  heroPortraitUrl,
  TEAM_COLORS,
  type PlayerInfo,
} from "@/components/player-roster";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type EventTab = "kills" | "abilities" | "objectives" | "chat";

// Future events (after the current tick) are shown but dimmed to this opacity.
const FUTURE_OPACITY = "opacity-40";

// Neutral (gold) accent for non-team objectives like the Mid-Boss.
const NEUTRAL_COLOR = "#c9a227";

// Per-kind label + verb for the objectives feed (icons are shared via
// OBJECTIVE_ICONS in map-view).
const OBJECTIVE_META: Record<ObjectiveKind, { label: string; verb: string }> = {
  guardian: { label: "Guardian", verb: "destroyed" },
  walker: { label: "Walker", verb: "destroyed" },
  base_guardian: { label: "Base Guardian", verb: "destroyed" },
  shrine: { label: "Shrine", verb: "destroyed" },
  patron: { label: "Patron", verb: "destroyed" },
  mid_boss: { label: "Mid-Boss", verb: "killed" },
  urn: { label: "Urn", verb: "spawns" },
  rift: { label: "Rift", verb: "opened" },
  objective: { label: "Objective", verb: "destroyed" },
};

export function EventLog({
  killEvents,
  abilityEvents,
  objectiveEvents,
  chatEvents,
  players,
  currentTick,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  killEvents: KillEvent[];
  abilityEvents: AbilityEvent[];
  objectiveEvents: ObjectiveEvent[];
  chatEvents: ChatEvent[];
  players: PlayerInfo[];
  currentTick: number;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  const [tab, setTab] = React.useState<EventTab>("kills");
  // Hero focus filters, kept per-tab. Empty set => show everyone; otherwise
  // only events involving a selected hero are shown.
  const [killFilter, setKillFilter] = React.useState<Set<number>>(new Set());
  const [abilityFilter, setAbilityFilter] = React.useState<Set<number>>(new Set());
  const [chatFilter, setChatFilter] = React.useState<Set<number>>(new Set());


  const filters = {
    kills: { filter: killFilter, set: setKillFilter },
    abilities: { filter: abilityFilter, set: setAbilityFilter },
    chat: { filter: chatFilter, set: setChatFilter },
  };

  const scrollRef = React.useRef<HTMLDivElement>(null);

  const heroById = React.useMemo(() => {
    const m = new Map<number, PlayerInfo>();
    for (const p of players) m.set(p.hero_id, p);
    return m;
  }, [players]);

  // All events (not just past ones), hero-filtered, newest first. The current
  // playhead is drawn as a divider inside the list and future events are
  // dimmed, so the time filter that used to live here is gone.
  const visibleKills = React.useMemo(() => {
    let out = killEvents;
    if (killFilter.size > 0) {
      out = out.filter(
        (e) =>
          killFilter.has(e.attacker_hero_id) ||
          killFilter.has(e.victim_hero_id),
      );
    }
    return out.slice().reverse();
  }, [killEvents, killFilter]);

  const visibleAbilities = React.useMemo(() => {
    let out = abilityEvents;
    if (abilityFilter.size > 0) {
      out = out.filter((e) => abilityFilter.has(e.hero_id));
    }
    return out.slice().reverse();
  }, [abilityEvents, abilityFilter]);

  const visibleObjectives = React.useMemo(
    () => objectiveEvents.slice().reverse(),
    [objectiveEvents],
  );

  const visibleChat = React.useMemo(() => {
    let out = chatEvents;
    if (chatFilter.size > 0) {
      out = out.filter((e) => chatFilter.has(e.hero_id));
    }
    return out.slice().reverse();
  }, [chatEvents, chatFilter]);

  const toggle = (
    setFilter: React.Dispatch<React.SetStateAction<Set<number>>>,
    heroId: number,
  ) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(heroId)) next.delete(heroId);
      else next.add(heroId);
      return next;
    });
  };

  const feedProps = {
    currentTick,
    formatTick,
    scrollRef,
    heroById,
    onSeek,
    onSelectPlayer,
  };

  return (
    <div className="flex min-w-[18rem] flex-1 flex-col gap-2">
      <Tabs value={tab} onValueChange={(v) => setTab(v as EventTab)}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="kills" className="px-1 text-xs">
            Kills
          </TabsTrigger>
          <TabsTrigger value="abilities" className="px-1 text-xs">
            Abilities
          </TabsTrigger>
          <TabsTrigger value="objectives" className="px-1 text-xs">
            Objectives
          </TabsTrigger>
          <TabsTrigger value="chat" className="px-1 text-xs">
            Chat
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {(tab === "kills" || tab === "abilities" || tab === "chat") && (
        <HeroFilter
          players={players}
          selected={filters[tab].filter}
          onToggle={(id) => toggle(filters[tab].set, id)}
        />
      )}


      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <TimelineEndpoint edge="end" />
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {tab === "kills" ? (
            <KillList events={visibleKills} {...feedProps} />
          ) : tab === "abilities" ? (
            <AbilityList events={visibleAbilities} {...feedProps} />
          ) : tab === "objectives" ? (
            <ObjectiveList events={visibleObjectives} {...feedProps} />
          ) : (
            <ChatList events={visibleChat} {...feedProps} />
          )}
        </div>
        <TimelineEndpoint edge="start" />
      </div>
    </div>
  );
}

// Shared per-feed props bundle (everything the list components need beyond
// their own `events`).
interface FeedProps {
  currentTick: number;
  formatTick: (tick: number) => string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  heroById: Map<number, PlayerInfo>;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}

// Renders a newest-first event list with a "now" divider at the playhead and
// future events dimmed. `events` must be sorted newest-first; the boundary is
// the first event at or before the current tick. Whenever the playhead crosses
// an event (the boundary moves) the divider is scrolled back into view.
function Feed<T extends { tick: number }>({
  events,
  currentTick,
  formatTick,
  scrollRef,
  empty,
  renderRow,
}: {
  events: T[];
  currentTick: number;
  formatTick: (tick: number) => string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  empty: string;
  renderRow: (event: T, future: boolean) => React.ReactNode;
}) {
  const dividerRef = React.useRef<HTMLLIElement>(null);
  // Events [0, boundary) are future (tick > current); [boundary, end] are past.
  const b = events.findIndex((e) => e.tick <= currentTick);
  const boundary = b === -1 ? events.length : b;

  // Keep the playhead in view as it advances. Scoped to the feed's scroll
  // container (never the page) and only fires when the boundary changes, so
  // it's quiet while paused — leaving the user free to scroll the history.
  React.useLayoutEffect(() => {
    const c = scrollRef.current;
    const d = dividerRef.current;
    if (!c || !d) return;
    const cRect = c.getBoundingClientRect();
    const dRect = d.getBoundingClientRect();
    c.scrollTop += dRect.top - cRect.top - c.clientHeight * 0.4;
  }, [boundary, scrollRef]);

  if (events.length === 0) return <EmptyFeed message={empty} />;

  const divider = <NowDivider ref={dividerRef} label={formatTick(currentTick)} />;
  return (
    <ul className="divide-y divide-border text-xs">
      {events.map((e, i) => (
        <React.Fragment key={`${e.tick}-${i}`}>
          {i === boundary && divider}
          {renderRow(e, i < boundary)}
        </React.Fragment>
      ))}
      {boundary === events.length && divider}
    </ul>
  );
}

// The playhead marker between past and future events: an accent rule labelled
// with the current match clock.
const NowDivider = React.forwardRef<HTMLLIElement, { label: string }>(
  function NowDivider({ label }, ref) {
    return (
      <li ref={ref} className="bg-primary/5">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="h-px flex-1 bg-primary/40" />
          <span className="flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-primary tabular-nums">
            <span className="size-1.5 rounded-full bg-primary" />
            now · {label}
          </span>
          <span className="h-px flex-1 bg-primary/40" />
        </div>
      </li>
    );
  },
);


function TimelineEndpoint({ edge }: { edge: "start" | "end" }) {
  const isEnd = edge === "end";
  return (
    <div
      aria-label={`${edge} of timeline`}
      className={cn(
        "flex shrink-0 select-none items-center gap-2 bg-muted/25 px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground",
        isEnd ? "border-b border-border" : "border-t border-border",
      )}
    >
      <span className="h-px flex-1 bg-border" />
      <span>
        {edge} / {isEnd ? "latest" : "earliest"}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// Two rows of hero portraits (one per team). Click to focus the feed on that
// hero; with nothing selected the feed shows everyone.
function HeroFilter({
  players,
  selected,
  onToggle,
}: {
  players: PlayerInfo[];
  selected: Set<number>;
  onToggle: (heroId: number) => void;
}) {
  const active = selected.size > 0;
  return (
    <div className="flex flex-col gap-1">
      {[3, 2].map((team) => (
        <div key={team} className="flex gap-1">
          {players
            .filter((p) => p.team === team)
            .map((p) => {
              const isSel = selected.has(p.hero_id);
              const url = heroPortraitUrl(p.hero_id);
              return (
                <button
                  key={p.hero_id}
                  type="button"
                  onClick={() => onToggle(p.hero_id)}
                  title={p.hero_name}
                  aria-pressed={isSel}
                  className={cn(
                    "relative aspect-square min-w-0 flex-1 cursor-pointer overflow-hidden rounded bg-muted transition-opacity",
                    active && !isSel
                      ? "opacity-30 hover:opacity-70"
                      : "opacity-100",
                  )}
                  style={
                    isSel
                      ? { boxShadow: `inset 0 0 0 2px ${TEAM_COLORS[team]}` }
                      : undefined
                  }
                >
                  {url ? (
                    <img
                      src={url}
                      alt={p.hero_name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

function EmptyFeed({ message }: { message: string }) {
  return (
    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}

// Shared clickable row scaffold: click seeks; name buttons also open the
// player. `future` dims rows that haven't happened yet at the current tick.
function EventRow({
  tick,
  formatTick,
  onSeek,
  future,
  children,
}: {
  tick: number;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  future?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSeek(tick)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSeek(tick);
          }
        }}
        title="Jump to this moment"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
          future && FUTURE_OPACITY,
        )}
      >
        <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          [{formatTick(tick)}]
        </span>
        {children}
      </div>
    </li>
  );
}

function KillList({
  events,
  currentTick,
  formatTick,
  scrollRef,
  heroById,
  onSeek,
  onSelectPlayer,
}: FeedProps & { events: KillEvent[] }) {
  return (
    <Feed
      events={events}
      currentTick={currentTick}
      formatTick={formatTick}
      scrollRef={scrollRef}
      empty="No kills."
      renderRow={(e, future) => {
        const attacker = heroById.get(e.attacker_hero_id);
        const victim = heroById.get(e.victim_hero_id);
        return (
          <EventRow
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
            future={future}
          >
            <HeroChip
              hero={attacker}
              fallback="?"
              onSelect={
                attacker
                  ? () => onSelectPlayer(attacker.hero_id, e.tick)
                  : undefined
              }
            />
            <span className="text-muted-foreground">killed</span>
            <HeroChip
              hero={victim}
              fallback="?"
              onSelect={
                victim ? () => onSelectPlayer(victim.hero_id, e.tick) : undefined
              }
            />
          </EventRow>
        );
      }}
    />
  );
}

function AbilityList({
  events,
  currentTick,
  formatTick,
  scrollRef,
  heroById,
  onSeek,
  onSelectPlayer,
}: FeedProps & { events: AbilityEvent[] }) {
  return (
    <Feed
      events={events}
      currentTick={currentTick}
      formatTick={formatTick}
      scrollRef={scrollRef}
      empty="No abilities."
      renderRow={(e, future) => {
        const hero = heroById.get(e.hero_id);
        return (
          <EventRow
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
            future={future}
          >
            <HeroChip
              hero={hero}
              fallback="?"
              onSelect={
                hero ? () => onSelectPlayer(hero.hero_id, e.tick) : undefined
              }
            />
            <AbilityIcon name={e.ability_name} size={18} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {prettifyAbilityName(e.ability_name)}
            </span>
          </EventRow>
        );
      }}
    />
  );
}

function ObjectiveList({
  events,
  currentTick,
  formatTick,
  scrollRef,
  heroById,
  onSeek,
  onSelectPlayer,
}: FeedProps & { events: ObjectiveEvent[] }) {
  return (
    <Feed
      events={events}
      currentTick={currentTick}
      formatTick={formatTick}
      scrollRef={scrollRef}
      empty="No objectives."
      renderRow={(e, future) => {
        const meta = OBJECTIVE_META[e.kind] ?? OBJECTIVE_META.objective;
        const Icon = OBJECTIVE_ICONS[e.kind] ?? OBJECTIVE_ICONS.objective;
        const color =
          e.kind === "urn" ? URN_COLOR : (TEAM_COLORS[e.team] ?? NEUTRAL_COLOR);
        const killer =
          e.killer_hero_id > 0 ? heroById.get(e.killer_hero_id) : undefined;
        return (
          <EventRow
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
            future={future}
          >
            <Icon
              className="size-[18px] flex-shrink-0"
              style={{ color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium" style={{ color }}>
                {meta.label}
              </span>{" "}
              <span className="text-muted-foreground">{e.action ?? meta.verb}</span>
            </span>
            {killer ? (
              <HeroChip
                hero={killer}
                fallback="?"
                onSelect={() => onSelectPlayer(killer.hero_id, e.tick)}
              />
            ) : null}
          </EventRow>
        );
      }}
    />
  );
}

function ChatList({
  events,
  currentTick,
  formatTick,
  scrollRef,
  heroById,
  onSeek,
  onSelectPlayer,
}: FeedProps & { events: ChatEvent[] }) {
  return (
    <Feed
      events={events}
      currentTick={currentTick}
      formatTick={formatTick}
      scrollRef={scrollRef}
      empty="No chat."
      renderRow={(e, future) => {
        const hero = e.hero_id > 0 ? heroById.get(e.hero_id) : undefined;
        const color = hero ? TEAM_COLORS[hero.team] : undefined;
        // Team chat gets a faint background in the sender's team color; all-chat
        // keeps the regular background.
        const bg = !e.all_chat && color ? color : undefined;
        return (
          <li>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSeek(e.tick)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSeek(e.tick);
                }
              }}
              title="Jump to this moment"
              style={
                bg
                  ? ({ "--chat-bg-color": bg } as React.CSSProperties)
                  : undefined
              }
              className={cn(
                "chat-row-fancy flex w-full cursor-pointer gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
                future && FUTURE_OPACITY,
              )}
            >
              <span className="mt-px flex-shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                [{formatTick(e.tick)}]
              </span>
              <span
                className={`chat-row team-${hero?.team} min-w-0 flex-1 break-words`}
              >
                {hero ? (
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onSelectPlayer(hero.hero_id, e.tick);
                    }}
                    title={`Open ${hero.hero_name}`}
                    className="cursor-pointer font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                    style={color ? { color } : undefined}
                  >
                    <HeroPortrait hero={hero} size={42} />
                  </button>
                ) : (
                  <span className="font-medium text-muted-foreground">
                    Unknown
                  </span>
                )}
                <span className="chat-bubble-text">{e.text}</span>
              </span>
            </div>
          </li>
        );
      }}
    />
  );
}

function HeroPortrait({
  hero,
  size,
}: {
  hero: PlayerInfo | undefined;
  size: number;
}) {
  const url = hero ? heroPortraitUrl(hero.hero_id) : null;
  const style = { width: size, height: size };
  return url ? (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="flex-shrink-0 rounded object-contain"
      style={style}
    />
  ) : (
    <span className="flex-shrink-0 rounded bg-muted" style={style} />
  );
}

function HeroChip({
  hero,
  fallback,
  onSelect,
}: {
  hero: PlayerInfo | undefined;
  fallback: string;
  onSelect?: () => void;
}) {
  const color = hero ? TEAM_COLORS[hero.team] : undefined;
  const inner = (
    <>
      <HeroPortrait hero={hero} size={18} />
      <span
        className="truncate font-medium"
        style={color ? { color } : undefined}
      >
        {hero?.hero_name || fallback}
      </span>
    </>
  );

  if (!hero || !onSelect) {
    return <span className="flex min-w-0 items-center gap-1">{inner}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`Open ${hero.hero_name}`}
      className="flex min-w-0 cursor-pointer items-center gap-1 rounded hover:underline focus-visible:underline focus-visible:outline-none"
    >
      {inner}
    </button>
  );
}
