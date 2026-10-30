import * as React from "react";
import { X } from "lucide-react";
import type { ReplayLoadOptions } from "@/wasm/load-options";
import { useDialogEscape } from "@/lib/use-dialog-escape";

export function ReplayOptionsFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ReplayLoadOptions;
  onChange: (value: ReplayLoadOptions) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="space-y-2 rounded-md border border-border bg-card p-3"
    >
      <legend className="px-1 text-xs font-medium">Loading options</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.modifiers}
          onChange={(e) => onChange({ ...value, modifiers: e.target.checked })}
          className="mt-0.5 accent-primary"
        />
        <span>
          Statuses/modifiers
          <span className="block text-xs text-muted-foreground">
            Active effects, status-based metrics, ability imbues, and calculated
            stats.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.winProbability}
          onChange={(e) =>
            onChange({ ...value, winProbability: e.target.checked })
          }
          className="mt-0.5 accent-primary"
        />
        <span>
          Win probability
          <span className="block text-xs text-muted-foreground">
            Generate the curve on this device during loading.
          </span>
        </span>
      </label>
      <p className="text-[10px] text-muted-foreground">
        Optional features increase loading time. Changes to a loaded replay
        require reparsing.
      </p>
    </fieldset>
  );
}

export function FeatureRequired({
  feature,
  onEnable,
}: {
  feature: "Statuses/modifiers" | "Win probability";
  onEnable?: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-2 text-xs text-muted-foreground">
      <p>
        This replay was loaded without {feature.toLowerCase()}. Enable this
        option and reparse the replay to view this data.
      </p>
      {onEnable && (
        <button
          type="button"
          data-reparse-control
          onClick={onEnable}
          className="mt-1 text-foreground underline"
        >
          Enable {feature.toLowerCase()} and reparse
        </button>
      )}
    </div>
  );
}

export function ReplayOptionsDialog({
  value,
  onClose,
  onApply,
}: {
  value: ReplayLoadOptions;
  onClose: () => void;
  onApply: (value: ReplayLoadOptions) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  useDialogEscape(true, onClose);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 p-4"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Replay loading options"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Replay loading options</h2>
          <button
            type="button"
            aria-label="Close loading options"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <ReplayOptionsFields value={draft} onChange={setDraft} />
        <p className="text-xs text-muted-foreground">
          Reparse the same local file with these options. Your playback position
          is preserved.
        </p>
        <div className="flex justify-end gap-3 text-sm">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
          >
            Reparse replay
          </button>
        </div>
      </div>
    </div>
  );
}
