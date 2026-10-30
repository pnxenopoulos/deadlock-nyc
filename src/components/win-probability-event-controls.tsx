import { Castle, Crosshair, Skull } from "lucide-react";
import type { EventVisibility } from "@/lib/win-probability-events";
import { cn } from "@/lib/utils";
import { MID_BOSS_COLOR } from "./win-probability-event-tooltip";

const controls = [
  { kind: "death", label: "Player kills", Icon: Crosshair },
  { kind: "objective", label: "Objective kills", Icon: Castle },
  { kind: "mid_boss", label: "Mid Boss", Icon: Skull },
] as const;

export function WinProbabilityEventControls({
  value,
  onChange,
  compact = false,
}: {
  value: EventVisibility;
  onChange: (value: EventVisibility) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Timeline event markers"
      className="flex shrink-0 flex-wrap items-center gap-1.5"
    >
      {controls.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          data-timeline-filter={kind}
          aria-pressed={value[kind]}
          aria-label={(value[kind] ? "Hide " : "Show ") + label.toLowerCase()}
          onClick={() => onChange({ ...value, [kind]: !value[kind] })}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact && "px-1.5",
            value[kind]
              ? "bg-primary/10 text-foreground"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon
            className="size-3.5"
            style={
              kind === "mid_boss" && value[kind]
                ? { color: MID_BOSS_COLOR }
                : undefined
            }
            aria-hidden
          />
          <span className={compact ? "sr-only" : undefined}>{label}</span>
        </button>
      ))}
    </div>
  );
}
