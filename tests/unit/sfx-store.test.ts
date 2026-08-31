import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRepurposeStore, reseedIdCounters } from "@/lib/repurpose/store";
import type { Clip, SfxClip } from "@/lib/repurpose/types";

function scene(duration = 10): Clip {
  return {
    id: "scene",
    kind: "take",
    label: "Scene",
    srcStart: 0,
    srcEnd: duration,
    timelineStart: 0,
    timelineEnd: duration,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: duration }],
    keeperIndex: 0,
  };
}

function sfx(overrides: Partial<SfxClip> = {}): SfxClip {
  return {
    id: "sfx-test",
    name: "Imported hit",
    source: { kind: "imported", assetId: "sfx-asset-test", srcDuration: 4 },
    origin: "manual",
    timelineStart: 1,
    sourceStart: 0,
    sourceEnd: 4,
    gain: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    ...overrides,
  };
}

function seed(duration = 10): void {
  useRepurposeStore.getState().setClips([scene(duration)]);
  useRepurposeStore.setState({ past: [], future: [] });
}

beforeEach(() => {
  useRepurposeStore.getState().resetProject();
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  seed();
});

describe("SFX inventory and IDs", () => {
  const safeSuffixCeiling = 1_000_000_000;

  it("mints independent clip and asset IDs and reseeds beyond hydrated IDs", () => {
    reseedIdCounters({
      sfxClips: [sfx({ id: "sfx-clip-900000" })],
      sfxAssets: [{
        id: "sfx-asset-800000",
        name: "old.wav",
        sourcePath: "C:\\audio\\old.wav",
        srcDuration: 2,
      }],
    });

    const assetId = useRepurposeStore.getState().addSfxAsset({
      name: "new.wav",
      sourcePath: "C:\\audio\\new.wav",
      srcDuration: 4,
    });
    const clipId = useRepurposeStore.getState().addSfxClip({
      name: "New",
      source: { kind: "imported", assetId, srcDuration: 4 },
      atTime: 2,
    });

    expect(assetId).toBe("sfx-asset-800001");
    expect(clipId).toBe("sfx-clip-900001");
  });

  it("skips occupied current IDs even when a caller has not reseeded yet", () => {
    const firstAsset = useRepurposeStore.getState().addSfxAsset({
      name: "first.wav",
      sourcePath: "C:\\audio\\first.wav",
      srcDuration: 1,
    });
    const nextAssetNumber = Number(firstAsset.slice("sfx-asset-".length)) + 1;
    const occupiedAssetId = `sfx-asset-${nextAssetNumber}`;
    useRepurposeStore.setState({
      sfxAssets: [{
        id: occupiedAssetId,
        name: "occupied.wav",
        sourcePath: "C:\\audio\\occupied.wav",
        srcDuration: 1,
      }],
    });
    const assetId = useRepurposeStore.getState().addSfxAsset({
      name: "second.wav",
      sourcePath: "C:\\audio\\second.wav",
      srcDuration: 1,
    });
    expect(assetId).not.toBe(occupiedAssetId);

    const firstClip = useRepurposeStore.getState().addSfxClip({
      name: "First",
      source: { kind: "built-in", key: "ding" },
      atTime: 1,
    }) as string;
    const nextClipNumber = Number(firstClip.slice("sfx-clip-".length)) + 1;
    const occupiedClipId = `sfx-clip-${nextClipNumber}`;
    useRepurposeStore.setState({
      sfxClips: [sfx({ id: occupiedClipId })],
      past: [],
      future: [],
    });
    const clipId = useRepurposeStore.getState().addSfxClip({
      name: "Second",
      source: { kind: "built-in", key: "ding" },
      atTime: 2,
    });
    expect(clipId).not.toBe(occupiedClipId);
    expect(new Set(useRepurposeStore.getState().sfxClips.map((clip) => clip.id)).size).toBe(2);
  });

  it("wraps safely past the valid SFX suffix boundary and skips occupied IDs", () => {
    const clipBoundary = `sfx-clip-${safeSuffixCeiling - 1}`;
    const assetBoundary = `sfx-asset-${safeSuffixCeiling - 1}`;
    const occupiedAsset = {
      id: "sfx-asset-1",
      name: "Occupied.wav",
      sourcePath: "C:\\audio\\occupied.wav",
      srcDuration: 1,
    };
    useRepurposeStore.setState({
      sfxClips: [sfx({ id: "sfx-clip-1" }), sfx({ id: clipBoundary })],
      sfxAssets: [occupiedAsset, { ...occupiedAsset, id: assetBoundary }],
    });
    reseedIdCounters(useRepurposeStore.getState());

    const assetId = useRepurposeStore.getState().addSfxAsset({
      name: "New.wav",
      sourcePath: "C:\\audio\\new.wav",
      srcDuration: 1,
    });
    const clipId = useRepurposeStore.getState().addSfxClip({
      name: "New",
      source: { kind: "built-in", key: "ding" },
      atTime: 0,
    });

    expect(assetId).toBe("sfx-asset-2");
    expect(clipId).toBe("sfx-clip-2");
  });

  it("ignores unsafe hydrated SFX suffixes while retaining their document IDs", () => {
    const unsafeSuffixes = [
      String(Number.MAX_SAFE_INTEGER),
      String(Number.MAX_SAFE_INTEGER + 1),
      "9".repeat(200),
    ];
    const clips = unsafeSuffixes.map((suffix, index) => sfx({
      id: `sfx-clip-${suffix}`,
      name: `Unsafe clip ${index}`,
    }));
    const assets = unsafeSuffixes.map((suffix, index) => ({
      id: `sfx-asset-${suffix}`,
      name: `Unsafe ${index}.wav`,
      sourcePath: `C:\\audio\\unsafe-${index}.wav`,
      srcDuration: 1,
    }));
    useRepurposeStore.setState({ sfxClips: clips, sfxAssets: assets });
    reseedIdCounters(useRepurposeStore.getState());

    const assetId = useRepurposeStore.getState().addSfxAsset({
      name: "Safe.wav",
      sourcePath: "C:\\audio\\safe.wav",
      srcDuration: 1,
    });
    const clipId = useRepurposeStore.getState().addSfxClip({
      name: "Safe",
      source: { kind: "built-in", key: "ding" },
      atTime: 0,
    }) as string;

    expect(useRepurposeStore.getState().sfxAssets.slice(0, assets.length)).toEqual(assets);
    expect(useRepurposeStore.getState().sfxClips.slice(0, clips.length)).toEqual(clips);
    expect(Number(assetId.slice("sfx-asset-".length))).toBeLessThan(safeSuffixCeiling);
    expect(Number(clipId.slice("sfx-clip-".length))).toBeLessThan(safeSuffixCeiling);
    expect(assets.some((asset) => asset.id === assetId)).toBe(false);
    expect(clips.some((clip) => clip.id === clipId)).toBe(false);
  });

  it("deduplicates assets outside history and keeps inventory after placement Undo", () => {
    const beforeRevision = useRepurposeStore.getState().sfxDocumentRevision;
    const asset = {
      name: "hit.wav",
      sourcePath: "C:\\audio\\hit.wav",
      srcDuration: 4,
    };
    const id = useRepurposeStore.getState().addSfxAsset(asset);
    expect(useRepurposeStore.getState().addSfxAsset(asset)).toBe(id);
    expect(useRepurposeStore.getState()).toMatchObject({
      sfxAssets: [{ id, ...asset }],
      past: [],
      sfxDocumentRevision: beforeRevision,
    });

    useRepurposeStore.getState().addSfxClip({
      name: asset.name,
      source: { kind: "imported", assetId: id, srcDuration: asset.srcDuration },
      atTime: 1,
    });
    useRepurposeStore.getState().undo();

    expect(useRepurposeStore.getState().sfxClips).toEqual([]);
    expect(useRepurposeStore.getState().sfxAssets).toEqual([{ id, ...asset }]);
  });
});

describe("discrete SFX edits", () => {
  it("clamps source-out to the remaining reel duration near the tail", () => {
    useRepurposeStore.setState({
      duration: 10,
      sfxClips: [sfx({ timelineStart: 9, sourceStart: 1, sourceEnd: 1.25 })],
      past: [],
      future: [],
    });

    useRepurposeStore.getState().setSfxClipSourceEnd("sfx-test", 4);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      timelineStart: 9,
      sourceStart: 1,
      sourceEnd: 2,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("adds, moves, trims, mixes, replaces, duplicates, and removes clips", () => {
    const id = useRepurposeStore.getState().addSfxClip({
      name: "Hit",
      source: { kind: "imported", assetId: "sfx-asset-hit", srcDuration: 4 },
      atTime: 1,
    }) as string;
    useRepurposeStore.getState().moveSfxClip(id, 2);
    useRepurposeStore.getState().trimSfxClipLeft(id, 2.25);
    useRepurposeStore.getState().trimSfxClipRight(id, 3.5);
    useRepurposeStore.getState().setSfxClipGain(id, 1.5);
    useRepurposeStore.getState().setSfxClipFadeIn(id, 0.25);
    useRepurposeStore.getState().setSfxClipFadeOut(id, 0.5);
    useRepurposeStore.getState().setSfxClipMuted(id, true);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      id,
      timelineStart: 2.25,
      sourceStart: 0.25,
      sourceEnd: 1.5,
      gain: 1.5,
      fadeInSec: 0.25,
      fadeOutSec: 0.5,
      muted: true,
    });

    useRepurposeStore.getState().replaceSfxClipSource(id, {
      name: "Click",
      source: { kind: "built-in", key: "mouse_click" },
    });
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      id,
      name: "Click",
      source: { kind: "built-in", key: "mouse_click" },
      origin: "manual",
      timelineStart: 2.25,
      sourceStart: 0,
      gain: 1.5,
      muted: true,
    });

    const duplicateId = useRepurposeStore.getState().duplicateSfxClip(id);
    expect(duplicateId).toMatch(/^sfx-clip-/);
    expect(duplicateId).not.toBe(id);
    expect(useRepurposeStore.getState().sfxClips[1]).toMatchObject({
      id: duplicateId,
      origin: "manual",
    });

    useRepurposeStore.getState().removeSfxClip(id);
    expect(useRepurposeStore.getState().sfxClips.map((clip) => clip.id)).toEqual([
      duplicateId,
    ]);
    expect(useRepurposeStore.getState().past).toHaveLength(11);
  });

  it("does not create history or revisions for no-op edits", () => {
    useRepurposeStore.setState({ sfxClips: [sfx()], past: [], future: [] });
    const revision = useRepurposeStore.getState().sfxDocumentRevision;

    useRepurposeStore.getState().moveSfxClip("missing", 2);
    useRepurposeStore.getState().moveSfxClip("sfx-test", 1);
    useRepurposeStore.getState().setSfxClipGain("sfx-test", 1);
    useRepurposeStore.getState().setSfxClipMuted("sfx-test", false);
    useRepurposeStore.getState().removeSfxClip("missing");

    expect(useRepurposeStore.getState()).toMatchObject({
      past: [],
      sfxDocumentRevision: revision,
    });
  });

  it("atomically replaces automatic clips while preserving manual clips", () => {
    const manual = sfx({ id: "manual", origin: "manual" });
    const oldAutomatic = sfx({ id: "automatic", origin: "automatic" });
    useRepurposeStore.setState({ sfxClips: [oldAutomatic, manual], past: [], future: [] });

    useRepurposeStore.getState().replaceAutomaticSfxClips([
      sfx({ id: "ignored", name: "Generated", origin: "automatic", timelineStart: 3 }),
    ]);

    const state = useRepurposeStore.getState();
    expect(state.sfxClips).toHaveLength(2);
    expect(state.sfxClips[0]).toBe(manual);
    expect(state.sfxClips[1]).toMatchObject({
      id: expect.stringMatching(/^sfx-clip-/),
      name: "Generated",
      origin: "automatic",
    });
    expect(state.past).toHaveLength(1);

    const revision = state.sfxDocumentRevision;
    state.replaceAutomaticSfxClips([
      sfx({ id: "ignored-again", name: "Generated", origin: "automatic", timelineStart: 3 }),
    ]);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().sfxDocumentRevision).toBe(revision);
  });
});


describe("runtime SFX document API", () => {
  it("does not expose the temporary track bridge or its actions", () => {
    const state = useRepurposeStore.getState();
    expect(state).not.toHaveProperty("sfxTrack");
    expect(state).not.toHaveProperty("setSfxTrack");
    expect(state).not.toHaveProperty("clearSfxTrack");
    expect(state).not.toHaveProperty("setSfxGain");
  });
});

describe("SFX selection ownership", () => {
  it("is mutually exclusive with every real competing selection", () => {
    useRepurposeStore.setState({
      sfxClips: [sfx()],
      selectedClipId: "scene",
      selectedOverlayId: "overlay",
      selectedOverlayIds: ["overlay"],
      selectedWordRange: { lo: 0, hi: 1 },
      selectedCaptionBlockId: "caption",
    });

    useRepurposeStore.getState().selectSfxClip("sfx-test");
    expect(useRepurposeStore.getState()).toMatchObject({
      selectedSfxClipId: "sfx-test",
      selectedClipId: null,
      selectedOverlayId: null,
      selectedOverlayIds: [],
      selectedWordRange: null,
      selectedCaptionBlockId: null,
    });

    useRepurposeStore.getState().selectClip("scene");
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
    useRepurposeStore.getState().selectSfxClip("sfx-test");
    useRepurposeStore.getState().selectWords(0);
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
    useRepurposeStore.getState().selectSfxClip("sfx-test");
    useRepurposeStore.getState().selectCaptionBlock("caption");
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
  });

  it("clears only itself on null and clears dangling selection after remove and Undo", () => {
    useRepurposeStore.setState({ sfxClips: [sfx()] });
    useRepurposeStore.getState().selectSfxClip("sfx-test");
    useRepurposeStore.getState().selectSfxClip(null);
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();

    useRepurposeStore.getState().selectClip("scene");
    useRepurposeStore.getState().selectOverlay(null);
    expect(useRepurposeStore.getState().selectedClipId).toBe("scene");

    useRepurposeStore.getState().selectSfxClip("sfx-test");
    useRepurposeStore.getState().removeSfxClip("sfx-test");
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
    useRepurposeStore.getState().undo();
    useRepurposeStore.setState({ sfxClips: [], past: [], future: [] });
    const added = useRepurposeStore.getState().addSfxClip({
      name: "Added",
      source: { kind: "built-in", key: "ding" },
      atTime: 1,
    }) as string;
    useRepurposeStore.getState().selectSfxClip(added);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
  });

  it("clears SFX selection when duplicate and split actions select scenes", () => {
    useRepurposeStore.setState({ sfxClips: [sfx()] });
    useRepurposeStore.getState().selectSfxClip("sfx-test");

    useRepurposeStore.getState().duplicateClip("scene");
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
    expect(useRepurposeStore.getState().selectedClipId).toMatch(/^split-/);

    useRepurposeStore.getState().selectSfxClip("sfx-test");
    useRepurposeStore.getState().splitClipAtPlayhead(1);
    expect(useRepurposeStore.getState().selectedSfxClipId).toBeNull();
    expect(useRepurposeStore.getState().selectedClipId).toMatch(/^split-/);
  });

  it("clears SFX selection when add and duplicate actions select overlays", () => {
    useRepurposeStore.setState({ sfxClips: [sfx()] });
    useRepurposeStore.getState().selectSfxClip("sfx-test");

    const overlayId = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/overlay.png",
      naturalWidth: 100,
      naturalHeight: 100,
      atTime: 1,
    });
    expect(useRepurposeStore.getState()).toMatchObject({
      selectedSfxClipId: null,
      selectedOverlayId: overlayId,
    });

    useRepurposeStore.getState().selectSfxClip("sfx-test");
    const duplicateId = useRepurposeStore.getState().duplicateOverlay(
      overlayId,
      { left: 0, top: 0, width: 1080, height: 1920 },
      0.5
    );
    expect(useRepurposeStore.getState()).toMatchObject({
      selectedSfxClipId: null,
      selectedOverlayId: duplicateId,
    });
  });
});

describe("SFX gesture ownership", () => {
  beforeEach(() => {
    useRepurposeStore.setState({ sfxClips: [sfx()], past: [], future: [] });
  });

  it("commits one history entry for a long effective gesture and round-trips Undo/Redo", () => {
    const revision = useRepurposeStore.getState().sfxDocumentRevision;
    const token = useRepurposeStore.getState().beginSfxGesture("sfx-test", "move") as string;
    useRepurposeStore.getState().updateSfxGesture(token, 1);
    expect(useRepurposeStore.getState().past).toHaveLength(0);
    useRepurposeStore.getState().updateSfxGesture(token, 2);
    useRepurposeStore.getState().updateSfxGesture(token, 3);
    useRepurposeStore.getState().endSfxGesture(token);

    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(3);
    const afterEditRevision = useRepurposeStore.getState().sfxDocumentRevision;
    expect(afterEditRevision).toBeGreaterThan(revision);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(1);
    expect(useRepurposeStore.getState().sfxDocumentRevision).toBeGreaterThan(afterEditRevision);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(3);
  });

  it.each([
    ["move", 4, 1],
    ["gain", 1.8, 1],
    ["fade-in", 0.75, 0],
  ] as const)(
    "collapses an explicit %s gesture back to a true no-op",
    (kind, away, original) => {
      useRepurposeStore.getState().addMarker(1);
      useRepurposeStore.getState().undo();
      const baseline = useRepurposeStore.getState();
      const baselineClips = baseline.sfxClips;
      const baselinePast = baseline.past;
      const baselineFuture = baseline.future;
      const baselineRevision = baseline.sfxDocumentRevision;
      const token = baseline.beginSfxGesture("sfx-test", kind) as string;

      useRepurposeStore.getState().updateSfxGesture(token, away);
      useRepurposeStore.getState().updateSfxGesture(token, original);
      useRepurposeStore.getState().endSfxGesture(token);

      const state = useRepurposeStore.getState();
      expect(state.sfxClips).toBe(baselineClips);
      expect(state.past).toBe(baselinePast);
      expect(state.future).toBe(baselineFuture);
      expect(state.sfxDocumentRevision).toBe(baselineRevision + 2);
    }
  );

  it.each([
    ["left-trim", 1.5, { timelineStart: 1.5, sourceStart: 0.5 }],
    ["right-trim", 3, { sourceEnd: 2 }],
    ["gain", 1.4, { gain: 1.4 }],
    ["fade-in", 0.4, { fadeInSec: 0.4 }],
    ["fade-out", 0.6, { fadeOutSec: 0.6 }],
  ] as const)("updates %s through the owned transaction", (kind, value, expected) => {
    const token = useRepurposeStore.getState().beginSfxGesture("sfx-test", kind) as string;
    useRepurposeStore.getState().updateSfxGesture(token, value);
    useRepurposeStore.getState().endSfxGesture(token);
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(expected);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("clamps a source-out gesture to the remaining reel duration near the tail", () => {
    useRepurposeStore.setState({
      duration: 10,
      sfxClips: [sfx({ timelineStart: 9, sourceStart: 1, sourceEnd: 1.25 })],
      past: [],
      future: [],
    });
    const token = useRepurposeStore.getState().beginSfxGesture("sfx-test", "source-out") as string;

    useRepurposeStore.getState().updateSfxGesture(token, 4);
    useRepurposeStore.getState().endSfxGesture(token);

    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(2);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("cancel restores clips and history while stale tokens are ignored", () => {
    useRepurposeStore.getState().addMarker(1);
    useRepurposeStore.getState().undo();
    const originalFuture = useRepurposeStore.getState().future;
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.getState().subscribeSfxGestureCancellation(listener);
    const token = useRepurposeStore.getState().beginSfxGesture("sfx-test", "gain") as string;
    useRepurposeStore.getState().updateSfxGesture(token, 1.8);
    const revisionBeforeRollback = useRepurposeStore.getState().sfxDocumentRevision;
    useRepurposeStore.getState().cancelSfxGesture(token);
    useRepurposeStore.getState().updateSfxGesture(token, 0.2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().sfxClips[0].gain).toBe(1);
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(useRepurposeStore.getState().future).toBe(originalFuture);
    expect(useRepurposeStore.getState().sfxDocumentRevision).toBeGreaterThan(
      revisionBeforeRollback
    );
    unsubscribe();
  });

  it("rolls back a competing owner and rejects its stale writes", () => {
    const first = useRepurposeStore.getState().beginSfxGesture("sfx-test", "move") as string;
    useRepurposeStore.getState().updateSfxGesture(first, 4);
    const second = useRepurposeStore.getState().beginSfxGesture("sfx-test", "move") as string;
    useRepurposeStore.getState().updateSfxGesture(first, 5);
    useRepurposeStore.getState().cancelSfxGesture(first);
    useRepurposeStore.getState().endSfxGesture(first);
    useRepurposeStore.getState().updateSfxGesture(second, 2);
    useRepurposeStore.getState().endSfxGesture(second);

    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("Redo cancels a live owner before restoring the redo document", () => {
    useRepurposeStore.getState().moveSfxClip("sfx-test", 2);
    useRepurposeStore.getState().undo();
    const token = useRepurposeStore.getState().beginSfxGesture("sfx-test", "gain") as string;
    useRepurposeStore.getState().updateSfxGesture(token, 1.5);

    useRepurposeStore.getState().redo();
    useRepurposeStore.getState().updateSfxGesture(token, 0.25);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      timelineStart: 2,
      gain: 1,
    });
  });

  it("Undo, project replacement, hydration, and competing edits cancel ownership", () => {
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.getState().subscribeSfxGestureCancellation(listener);

    const undoToken = useRepurposeStore.getState().beginSfxGesture("sfx-test", "move") as string;
    useRepurposeStore.getState().updateSfxGesture(undoToken, 2);
    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().updateSfxGesture(undoToken, 4);
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(1);

    const editToken = useRepurposeStore.getState().beginSfxGesture("sfx-test", "gain") as string;
    useRepurposeStore.getState().updateSfxGesture(editToken, 1.5);
    useRepurposeStore.getState().addMarker(1);
    expect(useRepurposeStore.getState().sfxClips[0].gain).toBe(1);

    const hydrateToken = useRepurposeStore.getState().beginSfxGesture("sfx-test", "gain") as string;
    useRepurposeStore.getState().updateSfxGesture(hydrateToken, 1.5);
    useRepurposeStore.getState().setHydrating(true);
    expect(useRepurposeStore.getState().sfxClips[0].gain).toBe(1);

    const resetToken = useRepurposeStore.getState().beginSfxGesture("sfx-test", "move") as string;
    useRepurposeStore.getState().updateSfxGesture(resetToken, 2);
    useRepurposeStore.getState().resetProject();
    useRepurposeStore.getState().updateSfxGesture(resetToken, 3);
    expect(useRepurposeStore.getState().sfxClips).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});

describe("duration ownership", () => {
  it("constrains a coalesced scene trim from its original SFX snapshot", () => {
    useRepurposeStore.setState({
      sfxClips: [
        sfx({ timelineStart: 3, sourceEnd: 4 }),
        sfx({ id: "sfx-late", timelineStart: 6, sourceEnd: 2 }),
      ],
      past: [],
      future: [],
    });

    useRepurposeStore.getState().trimClip("scene", "end", 4);
    useRepurposeStore.getState().trimClip("scene", "end", 8);

    expect(useRepurposeStore.getState()).toMatchObject({
      duration: 8,
      sfxClips: [
        expect.objectContaining({ id: "sfx-test", timelineStart: 3, sourceEnd: 4 }),
        expect.objectContaining({ id: "sfx-late", timelineStart: 6, sourceEnd: 2 }),
      ],
      past: [expect.any(Object)],
    });
  });

  it("keeps a finalized scene-trim constraint destructive when duration grows later", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    useRepurposeStore.setState({
      sfxClips: [
        sfx({ timelineStart: 3, sourceEnd: 4 }),
        sfx({ id: "sfx-late", timelineStart: 6, sourceEnd: 2 }),
      ],
      past: [],
      future: [],
    });

    useRepurposeStore.getState().trimClip("scene", "end", 4);
    now.mockReturnValue(2_000);
    useRepurposeStore.getState().trimClip("scene", "end", 8);
    now.mockRestore();

    expect(useRepurposeStore.getState()).toMatchObject({
      duration: 8,
      sfxClips: [
        expect.objectContaining({ id: "sfx-test", timelineStart: 3, sourceEnd: 1 }),
      ],
      past: [expect.any(Object), expect.any(Object)],
    });
  });

  it("constrains SFX in the same scene-trim snapshot and restores both on Undo", () => {
    useRepurposeStore.setState({
      sfxClips: [sfx({ timelineStart: 3, sourceEnd: 4 })],
      past: [],
      future: [],
    });
    useRepurposeStore.getState().trimClip("scene", "end", 4);

    expect(useRepurposeStore.getState().duration).toBe(4);
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(1);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().duration).toBe(10);
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(4);
  });

  it("constrains SFX with a word deletion and restores both in one Undo", () => {
    useRepurposeStore.setState({
      clips: [scene(4)],
      duration: 4,
      words: [
        { text: "keep", start: 0, end: 1 },
        { text: "remove", start: 3, end: 4 },
      ],
      sfxClips: [sfx({ timelineStart: 2.5, sourceEnd: 1.5 })],
      past: [],
      future: [],
    });
    useRepurposeStore.getState().deleteWords(1, 1);

    expect(useRepurposeStore.getState().duration).toBe(3);
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(0.5);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().duration).toBe(4);
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(1.5);
  });
});
