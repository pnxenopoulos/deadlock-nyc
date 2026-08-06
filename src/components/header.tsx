import { Github, Info, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { ViewSwitcher, useViewMode } from "@/components/view-mode";

const GITHUB_URL = "https://github.com/pnxenopoulos/boon";
const X_URL = "https://x.com/peterxeno";

// The X (formerly Twitter) brand mark. Lucide's `X` is the close/cross glyph,
// not the logo, so we inline the brand path. `fill="currentColor"` lets it
// inherit the header text color like the other icons; the Button sizes it.
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Header({ onInfoClick }: { onInfoClick: () => void }) {
  const { theme, toggle } = useTheme();
  const { demoLoaded, demoMode } = useViewMode();

  const iconButton =
    "size-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-sidebar text-sidebar-foreground">
      <div className="mx-auto flex h-10 max-w-6xl items-center gap-4 px-4">
        <div className="flex flex-1 items-center gap-2">
          <a
            href="/"
            className="text-sm font-medium tracking-tight text-sidebar-foreground hover:opacity-90"
          >
            deadlock.nyc
          </a>
          {demoMode && (
            <span
              className="hidden rounded-full border border-sidebar-foreground/20 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-sidebar-foreground/75 sm:inline-flex"
              title="Game mode"
            >
              {demoMode}
            </span>
          )}
        </div>

        {/* View switcher sits dead-center, but only once a demo is loaded. */}
        <div className="flex flex-shrink-0 items-center justify-center">
          {demoLoaded && <ViewSwitcher />}
        </div>

        <div className="flex flex-1 items-center justify-end gap-0.5">
          {/* App controls. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label="Toggle theme"
            className={iconButton}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onInfoClick}
            aria-label="About"
            className={iconButton}
          >
            <Info />
          </Button>

          {/* Social links, separated into their own group. The sidebar bg is
              theme-invariant, so the divider uses a sidebar-relative color to
              read identically in light and dark. */}
          <span
            className="mx-1.5 h-5 w-px bg-sidebar-foreground/20"
            aria-hidden="true"
          />
          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-label="GitHub"
            className={iconButton}
          >
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Github />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-label="X (Twitter)"
            className={iconButton}
          >
            <a href={X_URL} target="_blank" rel="noreferrer">
              <XIcon />
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}
