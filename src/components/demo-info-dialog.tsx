import { X } from "lucide-react";

import { TEAM_COLORS, TEAM_NAMES } from "@/components/player-roster";
import { Button } from "@/components/ui/button";
import { useDialogEscape } from "@/lib/use-dialog-escape";

export function DemoInfoDialog({
  open,
  onClose,
  name,
  mode,
  totalTicks,
  regulationClock,
  winner,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  mode: "Ranked" | "Standard" | "Street Brawl";
  totalTicks: number;
  /** Total regulation time, formatted (e.g. "38:36"), or null if unknown. */
  regulationClock: string | null;
  /** Winning team number, or null if the recording has no game-over. */
  winner: number | null;
}) {
  useDialogEscape(open, onClose);
  if (!open) return null;

  const winnerLabel =
    winner != null ? (TEAM_NAMES[winner] ?? `Team ${winner}`) : null;
  const winnerColor = winner != null ? TEAM_COLORS[winner] : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-medium">Demo info</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <dl className="mt-4 space-y-2.5 text-sm">
          <Row label="File">
            <span className="break-all font-medium">{name}</span>
          </Row>
          <Row label="Game mode">
            <span className="font-medium">{mode}</span>
          </Row>
          <Row label="Total ticks">
            <span className="font-medium tabular-nums">
              {totalTicks.toLocaleString()}
            </span>
          </Row>
          <Row label="Regulation time">
            <span className="font-medium tabular-nums">
              {regulationClock ?? "Unknown"}
            </span>
          </Row>
          <Row label="Winner">
            {winnerLabel ? (
              <span className="font-semibold" style={{ color: winnerColor }}>
                {winnerLabel}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Unknown (no game-over in recording)
              </span>
            )}
          </Row>
        </dl>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex-shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
