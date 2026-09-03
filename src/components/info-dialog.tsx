import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialogEscape } from "@/lib/use-dialog-escape";

export function InfoDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useDialogEscape(open, onClose);
  if (!open) return null;
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
          <h2 className="text-lg font-medium">About deadlock.nyc</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="mt-3 space-y-3 text-sm text-muted-foreground">
          <p>
            A client-side Deadlock demo viewer powered by the{" "}
            <a
              href="https://github.com/pnxenopoulos/boon"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              Boon v{__BOON_VERSION__}
            </a>{" "}
            parser compiled to WebAssembly.
          </p>
          <p>Your demo files never leave your machine.</p>
          <p className="border-t border-border pt-3 text-xs">
            Deadlock and all related game content — imagery, icons, minimaps,
            hero and item names, and other in-game assets — are the property of
            Valve Corporation and are not covered by this license. This is an
            unofficial, fan-made project that is not affiliated with or endorsed
            by Valve.
          </p>
        </div>
      </div>
    </div>
  );
}
