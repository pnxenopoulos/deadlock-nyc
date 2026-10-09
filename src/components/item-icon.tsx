import * as React from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { assetUrl, cn } from "@/lib/utils";
import itemIcons from "@/data/item-icons.json";
import itemNames from "@/data/item-names.json";

const ITEM_ICON_MANIFEST = itemIcons as Record<string, string>;
const ITEM_NAME_MANIFEST = itemNames as Record<string, string>;

function itemSlugFromAbilityName(name: string): string {
  return name.replace(/^upgrade_/, "").replace(/^citadel_/, "");
}

// Localized shop name (e.g. "Extra Charge") from the generated manifest, with
// a prettified-slug fallback for anything not yet in localization.
export function itemDisplayName(abilityName: string): string {
  if (!abilityName) return "";
  const name = ITEM_NAME_MANIFEST[abilityName];
  if (name) return name;
  return itemSlugFromAbilityName(abilityName)
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ItemIcon({
  abilityId,
  abilityName,
  size = 14,
  className,
  style,
  tooltip = true,
}: {
  abilityId: number;
  abilityName: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  tooltip?: boolean;
}) {
  // The manifest built from abilities.vdata maps each ability name straight to a
  // precise icon URL (the optimized WebP under public/items). Anything not in
  // the manifest — or that fails to load — shows a muted placeholder rather than
  // a broken-image glyph.
  const rawUrl = ITEM_ICON_MANIFEST[abilityName];
  const manifestUrl = rawUrl ? assetUrl(rawUrl) : undefined;
  const label = itemDisplayName(abilityName);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    setBroken(false);
  }, [abilityId, abilityName]);

  const icon =
    !manifestUrl || broken ? (
      <div
        style={{ width: size, height: size, ...style }}
        className={cn("rounded bg-muted/60", className)}
      />
    ) : (
      <img
        key={abilityId}
        src={manifestUrl}
        alt={abilityName}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        style={{ width: size, height: size, ...style }}
        className={cn("rounded object-contain", className)}
      />
    );
  return tooltip ? (
    <IconTooltip label={label || `id ${abilityId}`}>{icon}</IconTooltip>
  ) : (
    icon
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
