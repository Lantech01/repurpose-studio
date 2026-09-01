import { afterEach, describe, expect, it, vi } from "vitest";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (originalFonts) {
    Object.defineProperty(document, "fonts", originalFonts);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
});

describe("loadCaptionFonts", () => {
  it("offers Outfit and Inter with practical variable-font weights", async () => {
    const { CAPTION_FONTS } = await import("@/lib/repurpose/caption-fonts");

    expect(CAPTION_FONTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "outfit",
          label: "Outfit",
          cssFamily: "Outfit Variable",
          weights: [400, 500, 700, 800],
        }),
        expect.objectContaining({
          id: "inter",
          label: "Inter",
          cssFamily: "Inter Variable",
          weights: [400, 500, 700, 800],
        }),
      ])
    );
  });

  it("warms bundled font families without requesting missing public assets", async () => {
    const load = vi.fn().mockResolvedValue([{}]);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load, ready: Promise.resolve() },
    });
    const FontFaceMock = vi.fn();
    vi.stubGlobal("FontFace", FontFaceMock);

    const { loadCaptionFonts } = await import("@/lib/repurpose/caption-fonts");
    await loadCaptionFonts();

    expect(FontFaceMock).not.toHaveBeenCalled();
    expect(load.mock.calls.map(([spec]) => spec)).toEqual([
      '400 48px "TikTok Sans Variable"',
      '500 48px "TikTok Sans Variable"',
      '700 48px "TikTok Sans Variable"',
      '400 48px "Anton"',
      '400 48px "DM Sans Variable"',
      '500 48px "DM Sans Variable"',
      '700 48px "DM Sans Variable"',
      '800 48px "DM Sans Variable"',
      '400 48px "Fraunces Variable"',
      '500 48px "Fraunces Variable"',
      '700 48px "Fraunces Variable"',
      '400 48px "Outfit Variable"',
      '500 48px "Outfit Variable"',
      '700 48px "Outfit Variable"',
      '800 48px "Outfit Variable"',
      '400 48px "Inter Variable"',
      '500 48px "Inter Variable"',
      '700 48px "Inter Variable"',
      '800 48px "Inter Variable"',
    ]);
  });

  it("rejects an unavailable bundled face and retries on the next call", async () => {
    let firstCall = true;
    const load = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve([]);
      }
      return Promise.resolve([{}]);
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load, ready: Promise.resolve() },
    });

    const { loadCaptionFonts } = await import("@/lib/repurpose/caption-fonts");

    await expect(loadCaptionFonts()).rejects.toThrow("Bundled caption font unavailable");
    const callsAfterFailure = load.mock.calls.length;
    await expect(loadCaptionFonts()).resolves.toBeUndefined();
    expect(load.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });
});
