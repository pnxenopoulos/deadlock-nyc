import type { AbilitySlot, PlayerPosition } from "./map-view";
import { AbilityIcon, prettifyAbilityName } from "./ability-icon";
import {
  activeCooldown,
  chargeAt,
  type AbilityCooldown,
} from "@/lib/ability-state";
import { cn } from "@/lib/utils";

/** Compact recorded state; no stat queries or interpolation of health/cooldowns. */
export function PlayerLiveState({
  stats,
  abilities,
  cooldowns,
  tick,
  color,
}: {
  stats?: PlayerPosition;
  abilities?: AbilitySlot[];
  cooldowns?: Map<number, AbilityCooldown>;
  /** Active, non-paused tick. */
  tick: number;
  color: string;
}) {
  const health = Math.max(0, stats?.health ?? 0),
    max = Math.max(0, stats?.max_health ?? 0);
  const barrier = Math.max(0, stats?.barrier ?? 0),
    capacity = Math.max(barrier, stats?.max_barrier ?? 0);
  const hp = stats ? Math.round(health) + " / " + Math.round(max) : "—";
  return (
    <div className="flex min-w-0 items-center gap-2 text-left">
      <div
        className="min-w-0 flex-1"
        title={
          hp +
          " health" +
          (barrier ? " · " + Math.round(barrier) + " barrier" : "")
        }
      >
        <div className="mb-0.5 flex items-center justify-between gap-1 whitespace-nowrap text-[9px] leading-none tabular-nums">
          <span
            className={cn(stats && !stats.alive && "text-muted-foreground")}
          >
            {stats && !stats.alive ? "Dead · " + hp : hp}
          </span>
          {barrier > 0 && (
            <span className="text-sky-400">+{Math.round(barrier)}</span>
          )}
        </div>
        <div
          className="mb-px h-0.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Barrier"
          aria-valuemin={0}
          aria-valuemax={capacity || 1}
          aria-valuenow={barrier}
        >
          <div
            className="h-full bg-sky-400"
            style={{
              width: capacity > 0 ? (100 * barrier) / capacity + "%" : "0%",
            }}
          />
        </div>
        <div
          className="h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Health"
          aria-valuemin={0}
          aria-valuemax={max || 1}
          aria-valuenow={stats ? Math.min(health, max) : undefined}
          aria-valuetext={hp}
        >
          <div
            className="h-full"
            style={{
              width: max > 0 ? Math.min(100, (100 * health) / max) + "%" : "0%",
              background: color,
              opacity: stats?.alive ? 1 : 0.35,
            }}
          />
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5" aria-label="Abilities">
        {abilities?.slice(0, 4).map((ability) => {
          const state = cooldowns?.get(ability.ability_id);
          const recorded =
            state?.cooldowns.some((span) => span.start <= tick) ?? false;
          const cd = activeCooldown(state?.cooldowns, tick);
          const charge =
            state && state.maxCharges >= 2
              ? chargeAt(state.charges, tick, state.maxCharges)
              : null;
          const name = prettifyAbilityName(ability.ability_name);
          const status = !recorded
            ? "No recorded state"
            : cd
              ? cd.remaining.toFixed(1) + "s cooldown"
              : charge?.count === 0
                ? "No charges"
                : "Ready";
          const label =
            name +
            " · " +
            status +
            (charge
              ? " · " + charge.count + "/" + state!.maxCharges + " charges"
              : "");
          return (
            <span
              key={ability.ability_id}
              title={label}
              aria-label={label}
              className={cn(
                "relative flex size-5 items-center justify-center overflow-hidden rounded border border-border bg-muted/50",
                (!recorded || !stats?.alive || charge?.count === 0) &&
                  "opacity-40",
              )}
            >
              <AbilityIcon name={ability.ability_name} size={16} />
              {cd && (
                <>
                  <span
                    className="absolute inset-0 bg-black/65"
                    style={{
                      clipPath:
                        "inset(" +
                        (100 - Math.min(100, (100 * cd.remaining) / cd.total)) +
                        "% 0 0 0)",
                    }}
                  />
                  <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white [text-shadow:0_1px_2px_black]">
                    {Math.ceil(cd.remaining)}
                  </span>
                </>
              )}
              {charge && (
                <span className="absolute bottom-0 right-0 rounded-tl bg-black/80 px-0.5 text-[7px] leading-tight text-white">
                  {charge.count}
                </span>
              )}
            </span>
          );
        })}
        {!abilities?.length && (
          <span className="w-[5.5rem] text-center text-[10px] text-muted-foreground">
            —
          </span>
        )}
      </div>
    </div>
  );
}
