import { field, imageUrlFromPanorama, topLevelEntries } from "./kv3";

const PORTRAIT_FIELDS = [
  "m_strIconImageSmall",
  "m_strMinimapImage",
  "m_strTopBarVertical",
  "m_strIconHeroCard",
];

export function heroPortraitsFromVdata(text: string): Record<string, string> {
  const portraits: Record<string, string> = {};
  for (const { name, body } of topLevelEntries(text)) {
    if (!name.startsWith("hero_")) continue;
    const id = Number(field(body, "m_HeroID"));
    if (!Number.isInteger(id) || id <= 0) continue;
    const url = PORTRAIT_FIELDS
      .map((key) => imageUrlFromPanorama(field(body, key) ?? ""))
      .find((url) => url !== null);
    // Disabled development slots can have no portrait at all. Use Valve's
    // generic portrait instead of assigning another hero's face.
    portraits[String(id)] = url ?? "/heroes/generic_vertical_psd.webp";
  }
  return portraits;
}
