import * as React from "react";
import { Flame, Grid3x3, LineChart, Map } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ViewMode = "map" | "timeline" | "matrix" | "heatmap";
export type DemoMode = "Ranked" | "Standard" | "Street Brawl";

// The top-level ways to look at a parsed demo.
const VIEWS: { value: ViewMode; label: string; icon: typeof Map }[] = [
  { value: "map", label: "Map", icon: Map },
  { value: "timeline", label: "Timeline", icon: LineChart },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
  { value: "heatmap", label: "Heatmap", icon: Flame },
];

type ViewModeContextValue = {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  /** True once a demo is parsed — the switcher only shows then. */
  demoLoaded: boolean;
  setDemoLoaded: (loaded: boolean) => void;
  /** Friendly mode for the loaded demo, or null before parsing. */
  demoMode: DemoMode | null;
  setDemoMode: React.Dispatch<React.SetStateAction<DemoMode | null>>;
};

const ViewModeContext = React.createContext<ViewModeContextValue | null>(null);

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = React.useState<ViewMode>("map");
  const [demoLoaded, setDemoLoaded] = React.useState(false);
  const [demoMode, setDemoMode] = React.useState<DemoMode | null>(null);

  const value = React.useMemo(
    () => ({ view, setView, demoLoaded, setDemoLoaded, demoMode, setDemoMode }),
    [view, demoLoaded, demoMode],
  );

  return (
    <ViewModeContext.Provider value={value}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode(): ViewModeContextValue {
  const ctx = React.useContext(ViewModeContext);
  if (!ctx) {
    throw new Error("useViewMode must be used within a ViewModeProvider");
  }
  return ctx;
}

// Fills the map's slot for views that don't have a real implementation yet.
export function ViewPlaceholder({ view }: { view: ViewMode }) {
  const meta = VIEWS.find((v) => v.value === view);
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <div className="flex aspect-square h-full max-h-full min-h-0 max-w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card text-center">
      <Icon className="size-10 text-muted-foreground/50" aria-hidden />
      <div>
        <p className="text-sm font-medium">{meta.label} view</p>
        <p className="mt-0.5 text-xs text-muted-foreground">to be created</p>
      </div>
    </div>
  );
}

// Segmented control for the app header. Styled against the (theme-invariant)
// sidebar palette so the active view reads as a filled cream chip — and the
// selected view also spells out its label, so the current view is unmistakable.
export function ViewSwitcher() {
  const { view, setView } = useViewMode();
  return (
    <div
      role="tablist"
      aria-label="View"
      className="inline-flex items-center gap-0.5 rounded-md bg-sidebar-accent/40 p-0.5"
    >
      {VIEWS.map(({ value, label, icon: Icon }) => {
        const active = view === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`${label} view`}
                onClick={() => setView(value)}
                className={cn(
                  "flex h-7 items-center justify-center rounded px-2 text-xs font-medium transition-colors",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                    : "text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-4" />
                {active && <span className="ml-1.5">{label}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
