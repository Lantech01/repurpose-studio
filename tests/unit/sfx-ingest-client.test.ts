import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifySfxFile,
  createSfxImportOwner,
  importSfxFile,
  registerSfxImportOwner,
  releaseSfxImportOwner,
} from "@/lib/repurpose/sfx-ingest-client";
import { useRepurposeStore } from "@/lib/repurpose/store";

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ duration: 10, playhead: 3 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project-owned SFX import", () => {
  it.each([
    ["hit.wav", "audio/wav"],
    ["hit.mp3", "audio/mpeg"],
    ["hit.m4a", "audio/mp4"],
  ])("accepts %s", (name, type) => {
    expect(classifySfxFile(new File(["x"], name, { type }))).toBe(true);
  });

  it("rejects unsupported files before upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const owner = registerSfxImportOwner(createSfxImportOwner("project-a"));
    await expect(importSfxFile(new File(["x"], "bad.ogg", { type: "audio/ogg" }), 2, owner))
      .rejects.toThrow(/wav|mp3|m4a/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commits one distinct asset and one clip only after upload and duration probe succeed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      path: "C:\\audio\\hit.wav",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const owner = registerSfxImportOwner(createSfxImportOwner("project-a"));
    const result = await importSfxFile(
      new File(["x"], "Hit.wav", { type: "audio/wav" }),
      8,
      owner,
      { probeDuration: vi.fn().mockResolvedValue(4) }
    );
    expect(result).toMatchObject({ assetId: expect.stringMatching(/^sfx-asset-/), clipId: expect.stringMatching(/^sfx-clip-/) });
    expect(useRepurposeStore.getState().sfxAssets).toHaveLength(1);
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      origin: "manual",
      timelineStart: 8,
      source: { kind: "imported", srcDuration: 4 },
    });
  });

  it("does not commit after owner release or project switch", async () => {
    let resolveProbe!: (duration: number) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      path: "C:\\audio\\late.wav",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const owner = registerSfxImportOwner(createSfxImportOwner("project-a"));
    const pending = importSfxFile(new File(["x"], "late.wav", { type: "audio/wav" }), 2, owner, {
      probeDuration: () => new Promise((resolve) => { resolveProbe = resolve; }),
    });
    await vi.waitFor(() => expect(resolveProbe).toBeTypeOf("function"));
    releaseSfxImportOwner(owner);
    useRepurposeStore.getState().resetProject();
    resolveProbe(1);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(useRepurposeStore.getState()).toMatchObject({ sfxAssets: [], sfxClips: [] });
  });
});
