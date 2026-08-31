import catalog from "@/scripts/sfx-engine/sfx-catalog.json";

export const SFX_CATALOG = catalog;

export type ApprovedSfxKey = keyof typeof SFX_CATALOG;

export const APPROVED_SFX_KEYS = Object.keys(SFX_CATALOG) as ApprovedSfxKey[];

export function isApprovedSfxKey(value: unknown): value is ApprovedSfxKey {
  return typeof value === "string" && Object.hasOwn(SFX_CATALOG, value);
}

export function getSfxCatalogEntry(value: unknown) {
  return isApprovedSfxKey(value) ? SFX_CATALOG[value] : null;
}

export function defaultBuiltInDuration(key: ApprovedSfxKey): number {
  return Math.min(SFX_CATALOG[key].sourceDuration, 1);
}
