import * as React from "react";

import type { PauseInterval } from "@/components/map-view";
import { cn } from "@/lib/utils";
import type { FrameStore } from "@/wasm/frames";

interface TimelineProps {
  index: number;
  frames: FrameStore;
  onSeek: (next: number) => void;
  pauseIntervals?: PauseInterval[];
}

/**
 * Video-style scrubber. Click or drag along the bar to seek; a vertical
 * playhead marks the current frame. Hovering shows a tooltip with the
 * tick number at the cursor position.
 */
export function Timeline({
  index,
  frames,
  onSeek,
  pauseIntervals,
}: TimelineProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const [hoverX, setHoverX] = React.useState<number | null>(null);
  const total = frames.length;

  // Map pause tick-ranges to [left%, width%] along the bar. Frames are sampled
  // at a fixed tick cadence, so tick maps ~linearly onto the scrubber.
  const firstTick = frames.tickAt(0) ?? 0;
  const lastTick = frames.tickAt(total - 1) ?? 0;
  const span = lastTick - firstTick;
  const pauseBands = React.useMemo(() => {
    if (span <= 0 || !pauseIntervals) return [];
    const pct = (t: number) =>
      Math.max(0, Math.min(100, ((t - firstTick) / span) * 100));
    return pauseIntervals.map((p) => {
      const left = pct(p.start);
      // Floor the width so very short pauses stay visible.
      const width = Math.max(0.6, pct(p.end) - left);
      return { left, width };
    });
  }, [pauseIntervals, firstTick, span]);

  const frameIndexAtClientX = React.useCallback(
    (clientX: number): number => {
      const el = ref.current;
      if (!el || total <= 1) return 0;
      const rect = el.getBoundingClientRect();
      const t = (clientX - rect.left) / rect.width;
      const clamped = Math.min(1, Math.max(0, t));
      return Math.round(clamped * (total - 1));
    },
    [total],
  );

  const fraction = total > 1 ? index / (total - 1) : 0;

  const hoverInfo = React.useMemo(() => {
    if (hoverX == null || total === 0) return null;
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, hoverX - rect.left));
    const idx = frameIndexAtClientX(hoverX);
    const tick = frames.tickAt(idx) ?? 0;
    return { x, tick };
  }, [hoverX, frames, frameIndexAtClientX, total]);

  return (
    <div
      ref={ref}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={total - 1}
      aria-valuenow={index}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(frameIndexAtClientX(e.clientX));
      }}
      onPointerMove={(e) => {
        setHoverX(e.clientX);
        if (dragging.current) onSeek(frameIndexAtClientX(e.clientX));
      }}
      onPointerLeave={() => setHoverX(null)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onKeyDown={(e) => {
        // ←/→ are handled globally (back/forward by the configured step);
        // the scrubber keeps Home/End for jump-to-start/end.
        if (e.key === "Home") onSeek(0);
        else if (e.key === "End") onSeek(total - 1);
      }}
      className={cn(
        "relative h-7 w-full cursor-pointer overflow-visible rounded-md border border-border bg-muted",
        "select-none touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-primary/15"
        style={{ width: `${fraction * 100}%` }}
        aria-hidden
      />
      {pauseBands.map((b, i) => (
        <div
          key={`pause-${i}`}
          className="pointer-events-none absolute inset-y-0 border-x border-amber-500/60 bg-amber-500/35"
          style={{ left: `${b.left}%`, width: `${b.width}%` }}
          title="Match paused"
          aria-hidden
        />
      ))}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
        style={{ left: `calc(${fraction * 100}% - 1px)` }}
        aria-hidden
      />
      {hoverInfo && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background shadow"
          style={{ left: hoverInfo.x }}
          aria-hidden
        >
          tick {hoverInfo.tick}
        </div>
      )}
    </div>
  );
}
