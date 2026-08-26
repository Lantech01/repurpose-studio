import { describe, expect, test, vi } from "vitest";

interface ProjectHelperModule {
  assertPlaybackFrozenWithin100ms?: (
    readPlayhead: () => Promise<number>,
    wait: (milliseconds: number) => Promise<void>,
    fps?: number
  ) => Promise<void>;
}

describe("pause timing contract", () => {
  test("rejects playback that continues for 200ms after Pause", async () => {
    const helperModule = (await import(
      "../e2e/helpers/project"
    )) as ProjectHelperModule;
    expect(helperModule.assertPlaybackFrozenWithin100ms).toBeTypeOf("function");
    if (!helperModule.assertPlaybackFrozenWithin100ms) return;
    const values = [1, 1.2];
    const wait = vi.fn(async () => undefined);

    await expect(
      helperModule.assertPlaybackFrozenWithin100ms(
        async () => values.shift() ?? 1.2,
        wait,
        30
      )
    ).rejects.toThrow(/100ms/i);
    expect(wait).toHaveBeenCalledExactlyOnceWith(100);
  });

  test("allows no more than one frame plus timestamp rounding", async () => {
    const helperModule = (await import(
      "../e2e/helpers/project"
    )) as ProjectHelperModule;
    expect(helperModule.assertPlaybackFrozenWithin100ms).toBeTypeOf("function");
    if (!helperModule.assertPlaybackFrozenWithin100ms) return;
    const values = [1, 1.04];

    await expect(
      helperModule.assertPlaybackFrozenWithin100ms(
        async () => values.shift() ?? 1.04,
        async () => undefined,
        30
      )
    ).resolves.toBeUndefined();
  });
});
