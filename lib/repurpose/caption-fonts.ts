// ===========================================================================
// REPURPOSE STUDIO -- caption font registry + canvas loader
// ===========================================================================
// Captions are drawn on a Canvas 2D context (ctx.fillText), NOT the DOM, so a
// `next/font` import is not enough: the canvas font engine can only use a face
// once the browser has actually loaded it AND it is registered under a family
// name we then pass to `ctx.font`. This module owns both halves:
//
//   1. FONT_FAMILIES -- the picker registry. Each entry maps a stable id (stored
//      in CaptionStyle.font) to the CSS family name used in `ctx.font` and the
//      weights we ship. `cssFamily` is what actually goes into the font string.
//   2. loadCaptionFonts() -- warms the @fontsource faces imported by globals.css
//      and resolves once they are ready. Canvas text drawn before this resolves
//      silently falls back to a system font, so the preview calls it once on
//      mount and the export awaits it before the frame walk.
//
// All faces are bundled from OFL-licensed @fontsource packages. The persisted
// TikTok Display/Text ids resolve to TikTok Sans because those legacy projects
// and templates predate the switch away from missing /public font assets.
// ===========================================================================

/** Stable id persisted in CaptionStyle.font. */
export type CaptionFontId =
  | "tiktokDisplay"
  | "tiktokSans"
  | "tiktokText"
  | "anton"
  | "dmSans"
  | "fraunces"
  | "outfit"
  | "inter";

/** One selectable caption font. */
export interface CaptionFont {
  id: CaptionFontId;
  /** Human label for the picker. */
  label: string;
  /** The family name to put in `ctx.font` (must match the @font-face family). */
  cssFamily: string;
  /** Weights available; the picker offers these, the draw path clamps to nearest. */
  weights: number[];
  /** A generic fallback appended after cssFamily so text always renders. */
  fallback: string;
}

// ---------------------------------------------------------------------------
// Registry -- what the caption panel offers.
// ---------------------------------------------------------------------------
export const CAPTION_FONTS: CaptionFont[] = [
  {
    id: "tiktokDisplay",
    label: "TikTok Display",
    cssFamily: "TikTok Sans Variable",
    weights: [400, 500, 700],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "tiktokSans",
    label: "TikTok Sans",
    cssFamily: "TikTok Sans Variable",
    weights: [400],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "tiktokText",
    label: "TikTok Text",
    cssFamily: "TikTok Sans Variable",
    weights: [400, 500, 700],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "anton",
    label: "Anton",
    cssFamily: "Anton",
    weights: [400],
    fallback: "Impact, system-ui, sans-serif",
  },
  {
    id: "dmSans",
    label: "DM Sans",
    cssFamily: "DM Sans Variable",
    weights: [400, 500, 700, 800],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "fraunces",
    label: "Fraunces",
    cssFamily: "Fraunces Variable",
    weights: [400, 500, 700],
    fallback: "Georgia, serif",
  },
  {
    id: "outfit",
    label: "Outfit",
    cssFamily: "Outfit Variable",
    weights: [400, 500, 700, 800],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "inter",
    label: "Inter",
    cssFamily: "Inter Variable",
    weights: [400, 500, 700, 800],
    fallback: "system-ui, sans-serif",
  },
];

const FONT_BY_ID = new Map(CAPTION_FONTS.map((f) => [f.id, f]));

/** Resolve a possibly-stale font id to its registry entry (defaults to TikTok Display). */
export function captionFont(id: CaptionFontId | string): CaptionFont {
  return FONT_BY_ID.get(id as CaptionFontId) ?? CAPTION_FONTS[0];
}

/** Clamp a requested weight to the nearest weight the font actually ships. */
export function nearestWeight(font: CaptionFont, weight: number): number {
  let best = font.weights[0];
  let bestDelta = Math.abs(best - weight);
  for (const w of font.weights) {
    const d = Math.abs(w - weight);
    if (d < bestDelta) {
      best = w;
      bestDelta = d;
    }
  }
  return best;
}

/**
 * Build the `ctx.font` string for a font id + weight + pixel size. Weight is
 * clamped to a shipped weight, family is quoted, and the generic fallback is
 * appended so an un-loaded face still renders (as a fallback) rather than
 * throwing off measureText.
 */
export function captionFontString(
  id: CaptionFontId | string,
  weight: number,
  sizePx: number
): string {
  const font = captionFont(id);
  const w = nearestWeight(font, weight);
  return `${w} ${Math.round(sizePx)}px "${font.cssFamily}", ${font.fallback}`;
}

// ---------------------------------------------------------------------------
// Bundled faces -- warmed through the CSS Font Loading API for canvas use.
// ---------------------------------------------------------------------------
const BUNDLED_FONT_SPECS = [
  ...new Set(
    CAPTION_FONTS.flatMap((font) =>
      font.weights.map((weight) => `${weight} 48px "${font.cssFamily}"`)
    )
  ),
];

let loadPromise: Promise<void> | null = null;

/**
 * Warm every bundled caption face through document.fonts. Idempotent: repeated
 * calls share one promise. A missing face rejects instead of silently rendering
 * a fallback; failed attempts are not cached, so a later call can retry.
 *
 * Safe to call in the browser only (guards on document.fonts).
 */
export function loadCaptionFonts(): Promise<void> {
  if (loadPromise) return loadPromise;
  if (typeof document === "undefined" || !document.fonts?.load) {
    return Promise.resolve();
  }

  const pending = (async () => {
    await Promise.all(BUNDLED_FONT_SPECS.map(async (spec) => {
      const faces = await document.fonts.load(spec);
      if (faces.length === 0) {
        throw new Error(`Bundled caption font unavailable: ${spec}`);
      }
    }));
    // A final readiness gate so measureText is accurate for everything above.
    await document.fonts.ready;
  })();
  loadPromise = pending.catch((error) => {
    loadPromise = null;
    throw error;
  });

  return loadPromise;
}
