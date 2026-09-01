export function clampSplitRatio(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

export function parsePersistedSplitRatio(
  value: unknown,
  fallback: number
): number {
  if (typeof value === "number") {
    const parsed = clampSplitRatio(value);
    if (parsed !== null) return parsed;
  }
  return clampSplitRatio(fallback) ?? 0.5;
}

export function snapPointerSplitRatio(value: number): number {
  const clamped = clampSplitRatio(value) ?? 0.5;
  if (clamped <= 0.02) return 0;
  if (clamped >= 0.98) return 1;
  return clamped;
}

export function effectiveSplitRatio(value: number, height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0.5;
  const ratio = parsePersistedSplitRatio(value, 0.5);
  return Math.round(height * ratio) / height;
}
