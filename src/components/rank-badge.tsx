import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import rankIcons from "@/data/rank-icons.json";
import { assetUrl, cn } from "@/lib/utils";

const RANK_NAMES = [
  "Obscurus",
  "Initiate",
  "Seeker",
  "Alchemist",
  "Arcanist",
  "Ritualist",
  "Emissary",
  "Archon",
  "Oracle",
  "Phantom",
  "Ascendant",
  "Eternus",
] as const;

const SUBRANK_NAMES = ["", "I", "II", "III", "IV", "V", "VI"] as const;
const RANK_ICONS = rankIcons as Record<string, string>;

export function rankDisplayName(packedRank: number): string | null {
  if (!Number.isInteger(packedRank) || packedRank <= 0) return null;
  const tier = Math.floor(packedRank / 10);
  const subrank = packedRank % 10;
  const tierName = RANK_NAMES[tier];
  const subrankName = SUBRANK_NAMES[subrank];
  return tierName && subrankName ? `${tierName} ${subrankName}` : null;
}

export function RankBadge({
  rank,
  className,
}: {
  rank: number;
  className?: string;
}) {
  const label = rankDisplayName(rank);
  const icon = RANK_ICONS[String(rank)];
  if (!label || !icon) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className={cn(
            "inline-flex flex-shrink-0 cursor-help items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <img
            src={assetUrl(icon)}
            alt=""
            aria-hidden
            className="size-full object-contain"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}