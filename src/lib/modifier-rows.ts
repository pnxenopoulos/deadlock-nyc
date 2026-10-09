export type ModifierRow = {
  key: string;
  abilityId: number;
  abilityName: string;
  label: string;
  isItem: boolean;
  casterHeroId: number;
  stacks: number;
  remaining: number | null;
  incoming: boolean;
};

/** Display-only exclusions. Keep raw modifiers and Boon's calculations intact. */
export const IGNORED_MODIFIERS: Readonly<Record<string, string>> = {
  modifier_citadel_pre_match_wait: "Engine pre-match waiting state, not a combat effect.",
};

export function isIgnoredModifier(name: string): boolean {
  return Object.hasOwn(IGNORED_MODIFIERS, name.split("/").at(-1) ?? name);
}

/** Hide only allowlisted missing-definition warnings, never other stat errors. */
export function statDiagnostic(diagnostic?: string): string | undefined {
  if (!diagnostic) return diagnostic;
  let inIgnored = false;
  let needsHeading = false;
  const visible = diagnostic.split("; ").flatMap((part) => {
    if (part.startsWith("ignored modifiers: ")) {
      inIgnored = true;
      needsHeading = true;
      part = part.slice("ignored modifiers: ".length);
    }
    const missing = part.match(/^modifier ID \d+ \(([^)]+)\) has no stat definition$/);
    if (inIgnored && missing && isIgnoredModifier(missing[1])) return [];
    if (inIgnored && /^(?:modifier ID|unresolved modifier ID|ambiguous modifier ID) /.test(part)) {
      const heading = needsHeading ? "ignored modifiers: " : "";
      needsHeading = false;
      return [heading + part];
    }
    inIgnored = false;
    return [part];
  });
  return visible.join("; ") || undefined;
}

/** Permanent pickup bonuses belong in stat breakdowns, not the effect list. */
export function isPermanentStatPickup(modifier: {
  ability_name: string;
  modifier_name: string;
}): boolean {
  return modifier.modifier_name.split("/").pop() === "modifier_permanent_pickup" ||
    /(?:^|_)permanent_pickup(?:_lv\d+)?$/.test(modifier.ability_name);
}

/**
 * Boon preserves the game's low-level modifier serials. Summarize serials from
 * the same ability and caster because they otherwise render as indistinguishable
 * duplicate rows. Item groups containing only indefinite, unstacked self
 * modifiers are passive stat carriers/watchers rather than active effects.
 */
export function collapseModifierRows(
  rows: ModifierRow[],
  selfHeroId: number,
): ModifierRow[] {
  const standalone: ModifierRow[] = [];
  const sourceGroups = new Map<string, ModifierRow[]>();

  for (const row of rows) {
    if (row.abilityId === 0 && !row.abilityName) {
      standalone.push(row);
      continue;
    }

    // Some intrinsic modifiers omit their caster while sibling proc modifiers
    // name the owning hero. Treat both as the same self-applied source.
    const casterKey =
      row.casterHeroId === 0 || row.casterHeroId === selfHeroId
        ? selfHeroId
        : row.casterHeroId;
    const groupKey = `${row.abilityId}:${row.abilityName}:${casterKey}`;
    const group = sourceGroups.get(groupKey);
    if (group) group.push(row);
    else sourceGroups.set(groupKey, [row]);
  }

  const collapsed = [...sourceGroups.entries()].flatMap(([groupKey, group]) => {
    const passiveItem = group.every(
      (row) =>
        row.isItem &&
        !row.incoming &&
        row.stacks <= 0 &&
        row.remaining == null,
    );
    if (passiveItem) return [];

    const maxStacks = Math.max(...group.map((row) => row.stacks));
    const preferred = group.reduce((best, row) =>
      isBetterSummary(row, best, maxStacks) ? row : best,
    );

    return [
      {
        ...preferred,
        key: `source:${groupKey}`,
        stacks: maxStacks,
      },
    ];
  });

  return [...standalone, ...collapsed];
}

function isBetterSummary(
  candidate: ModifierRow,
  current: ModifierRow,
  maxStacks: number,
): boolean {
  const candidateHasMaxStacks = candidate.stacks === maxStacks;
  const currentHasMaxStacks = current.stacks === maxStacks;
  if (candidateHasMaxStacks !== currentHasMaxStacks) {
    return candidateHasMaxStacks;
  }

  const candidateIsTimed = candidate.remaining != null;
  const currentIsTimed = current.remaining != null;
  if (candidateIsTimed !== currentIsTimed) return candidateIsTimed;

  // When equivalent effects overlap, show the one expiring first.
  if (candidate.remaining != null && current.remaining != null) {
    return candidate.remaining < current.remaining;
  }

  return candidate.key < current.key;
}
