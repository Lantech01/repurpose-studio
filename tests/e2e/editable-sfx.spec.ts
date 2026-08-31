import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { ProjectSnapshot, SfxClip } from "@/lib/repurpose/types";
import {
  GENERATED_FIXTURES,
  cleanupProject,
  collectBrowserErrors,
  createProjectWithFootage,
  currentDurableProjectId,
  seedProjectSnapshot,
} from "./helpers/project";
import { validateReusedE2eStorage } from "./helpers/storage-root";

async function readSnapshot(page: Page, projectId: string): Promise<ProjectSnapshot> {
  const response = await page.request.get(`/api/repurpose/projects/${projectId}`, {
    maxRetries: 3,
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { project: { snapshot: ProjectSnapshot } };
  return body.project.snapshot;
}

async function waitForSnapshot(
  page: Page,
  projectId: string,
  predicate: (snapshot: ProjectSnapshot) => boolean
): Promise<ProjectSnapshot> {
  await expect
    .poll(async () => predicate(await readSnapshot(page, projectId)), {
      timeout: 30_000,
      intervals: [100, 250, 500],
    })
    .toBe(true);
  return readSnapshot(page, projectId);
}

function timelineEnd(clip: SfxClip): number {
  return clip.timelineStart + clip.sourceEnd - clip.sourceStart;
}

async function installLegacyFixture(): Promise<{ filePath: string; cleanup(): Promise<void> }> {
  const source = path.join(GENERATED_FIXTURES, "editable-sfx.wav");
  const { sfxDir } = validateReusedE2eStorage(process.env);
  const filePath = path.join(sfxDir, `sfx-${randomBytes(32).toString("hex")}.wav`);
  await mkdir(sfxDir, { recursive: true });
  await copyFile(source, filePath);
  return {
    filePath,
    async cleanup() {
      await rm(filePath, { force: true });
    },
  };
}

async function seekToFrame(page: Page, frame: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let index = 0; index < frame; index += 1) await page.keyboard.press("ArrowRight");
  const expected = (frame / 30).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuenow",
    expected
  );
}

test("edits independent effects and preserves manual SFX through regeneration and reopen", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );

    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    const blocks = page.locator("[data-sfx-clip-id]");
    await expect.poll(() => blocks.count(), { timeout: 60_000 }).toBeGreaterThan(1);

    const generated = await waitForSnapshot(
      page,
      projectId,
      (snapshot) => (snapshot.sfxClips?.filter((clip) => clip.origin === "automatic").length ?? 0) > 1
    );
    const editedAutomatic = generated.sfxClips!.find(
      (clip) => clip.origin === "automatic" && timelineEnd(clip) < generated.duration
    )!;
    expect(editedAutomatic).toBeDefined();
    expect(new Set(await blocks.evaluateAll((items) => items.map((item) => item.getAttribute("data-sfx-clip-id")))).size)
      .toBe(await blocks.count());

    const selectAutomatic = page.locator(`[data-sfx-select-id="${editedAutomatic.id}"]`);
    await selectAutomatic.focus();
    await expect(selectAutomatic).toBeFocused();
    await expect(selectAutomatic).toHaveAttribute("aria-label", /automatic/i);
    await selectAutomatic.press("ArrowRight");
    const moved = await waitForSnapshot(
      page,
      projectId,
      (snapshot) =>
        (snapshot.sfxClips?.find((clip) => clip.id === editedAutomatic.id)?.timelineStart ?? -1) >
        editedAutomatic.timelineStart
    );
    const movedAutomatic = moved.sfxClips!.find((clip) => clip.id === editedAutomatic.id)!;

    const trimEnd = page.getByRole("slider", {
      name: `Trim ${editedAutomatic.name} end`,
      exact: true,
    });
    await trimEnd.focus();
    await trimEnd.press("ArrowLeft");
    await page.getByRole("slider", { name: `Gain for ${editedAutomatic.name}` }).fill("1.25");
    await page.getByRole("slider", { name: `Fade in for ${editedAutomatic.name}` }).fill("0.12");
    await page.getByRole("slider", { name: `Fade out for ${editedAutomatic.name}` }).fill("0.15");
    await page.getByRole("button", { name: `Mute ${editedAutomatic.name}`, exact: true }).click();

    const authored = await waitForSnapshot(page, projectId, (snapshot) => {
      const clip = snapshot.sfxClips?.find((candidate) => candidate.id === editedAutomatic.id);
      return Boolean(
        clip &&
          clip.sourceEnd < movedAutomatic.sourceEnd &&
          clip.gain === 1.25 &&
          clip.fadeInSec === 0.12 &&
          clip.fadeOutSec === 0.15 &&
          clip.muted
      );
    });
    const authoredAutomatic = authored.sfxClips!.find((clip) => clip.id === editedAutomatic.id)!;

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForSnapshot(
      page,
      projectId,
      (snapshot) => !snapshot.sfxClips?.find((clip) => clip.id === editedAutomatic.id)?.muted
    );
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await waitForSnapshot(
      page,
      projectId,
      (snapshot) => snapshot.sfxClips?.find((clip) => clip.id === editedAutomatic.id)?.muted === true
    );

    await seekToFrame(page, 12);
    await page.getByRole("button", { name: "Add Whoosh at playhead", exact: true }).click();
    await page.getByLabel("Import sound effect").setInputFiles(
      path.join(GENERATED_FIXTURES, "editable-sfx.wav")
    );
    const withManualEffects = await waitForSnapshot(page, projectId, (snapshot) => {
      const manual = snapshot.sfxClips?.filter((clip) => clip.origin === "manual") ?? [];
      return snapshot.sfxAssets?.length === 1 && manual.length >= 2 &&
        manual.some((clip) => clip.source.kind === "built-in") &&
        manual.some((clip) => clip.source.kind === "imported");
    });
    const builtInManual = withManualEffects.sfxClips!.find(
      (clip) => clip.origin === "manual" && clip.source.kind === "built-in"
    )!;
    const importedManual = withManualEffects.sfxClips!.find(
      (clip) => clip.origin === "manual" && clip.source.kind === "imported"
    )!;
    const assetRoot = path.resolve(process.env.REPURPOSE_ASSET_DIR!);
    const importedAsset = withManualEffects.sfxAssets!.find(
      (asset) => importedManual.source.kind === "imported" && asset.id === importedManual.source.assetId
    )!;
    const importedRelativePath = path.relative(assetRoot, path.resolve(importedAsset.sourcePath));
    expect(importedRelativePath).not.toBe("");
    expect(importedRelativePath.startsWith("..") || path.isAbsolute(importedRelativePath)).toBe(false);
    expect(builtInManual.timelineStart).toBeCloseTo(importedManual.timelineStart, 3);
    expect(Math.min(timelineEnd(builtInManual), timelineEnd(importedManual))).toBeGreaterThan(
      Math.max(builtInManual.timelineStart, importedManual.timelineStart)
    );
    await expect(page.locator(`[data-sfx-clip-id="${builtInManual.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-sfx-clip-id="${importedManual.id}"]`)).toBeVisible();

    expect(importedManual.source.kind).toBe("imported");
    if (importedManual.source.kind !== "imported") throw new Error("Expected imported SFX source");
    const importedSource = importedManual.source;
    await selectAutomatic.focus();
    await page.getByRole("button", {
      name: `Replace ${editedAutomatic.name} with ${importedManual.name}`,
      exact: true,
    }).click();
    const expectedReplacementSourceEnd = Math.min(
      importedSource.srcDuration,
      authored.duration - authoredAutomatic.timelineStart
    );
    const replaced = await waitForSnapshot(page, projectId, (snapshot) => {
      const clip = snapshot.sfxClips?.find((candidate) => candidate.id === editedAutomatic.id);
      return Boolean(
        clip &&
          clip.origin === "manual" &&
          clip.source.kind === "imported" &&
          clip.source.assetId === importedSource.assetId &&
          clip.timelineStart === authoredAutomatic.timelineStart &&
          clip.sourceStart === 0 &&
          clip.sourceEnd === expectedReplacementSourceEnd &&
          clip.gain === authoredAutomatic.gain &&
          clip.fadeInSec === authoredAutomatic.fadeInSec &&
          clip.fadeOutSec === authoredAutomatic.fadeOutSec &&
          clip.muted === authoredAutomatic.muted
      );
    });
    const replacement = replaced.sfxClips!.find((clip) => clip.id === editedAutomatic.id)!;
    expect(replacement).toMatchObject({
      id: editedAutomatic.id,
      name: importedManual.name,
      origin: "manual",
      timelineStart: authoredAutomatic.timelineStart,
      sourceStart: 0,
      sourceEnd: expectedReplacementSourceEnd,
      gain: authoredAutomatic.gain,
      fadeInSec: authoredAutomatic.fadeInSec,
      fadeOutSec: authoredAutomatic.fadeOutSec,
      muted: authoredAutomatic.muted,
      source: importedSource,
    });
    await expect(selectAutomatic).toBeFocused();

    const idsBeforeDuplicate = new Set(replaced.sfxClips!.map((clip) => clip.id));
    await page.getByRole("button", { name: `Duplicate ${replacement.name}`, exact: true }).click();
    const duplicated = await waitForSnapshot(page, projectId, (snapshot) =>
      (snapshot.sfxClips ?? []).some(
        (clip) =>
          !idsBeforeDuplicate.has(clip.id) &&
          clip.origin === "manual" &&
          clip.source.kind === replacement.source.kind &&
          clip.gain === replacement.gain &&
          clip.fadeInSec === replacement.fadeInSec &&
          clip.fadeOutSec === replacement.fadeOutSec &&
          clip.muted === replacement.muted
      )
    );
    const duplicate = duplicated.sfxClips!.find(
      (clip) =>
        !idsBeforeDuplicate.has(clip.id) &&
        clip.origin === "manual" &&
        clip.name === replacement.name &&
        clip.gain === replacement.gain
    )!;
    await expect(page.locator(`[data-sfx-select-id="${duplicate.id}"]`)).toBeFocused();

    const manualBeforeRegeneration = duplicated.sfxClips!
      .filter((clip) => clip.origin === "manual")
      .sort((left, right) => left.id.localeCompare(right.id));
    const automaticBeforeRegeneration = duplicated.sfxClips!.filter(
      (clip) => clip.origin === "automatic"
    );
    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    const regenerated = await waitForSnapshot(page, projectId, (snapshot) => {
      const automatic = snapshot.sfxClips?.filter((clip) => clip.origin === "automatic") ?? [];
      return automatic.length > 1 && JSON.stringify(automatic) !== JSON.stringify(automaticBeforeRegeneration);
    });
    expect(
      regenerated.sfxClips!.filter((clip) => clip.origin === "manual").sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual(manualBeforeRegeneration);
    expect(regenerated.sfxAssets).toEqual(withManualEffects.sfxAssets);
    expect(regenerated.sfxTrack).toBeUndefined();
    expect(regenerated.sfxClips!.find((clip) => clip.id === editedAutomatic.id)).toEqual(replacement);

    await page.reload();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 30_000 });
    expect((await readSnapshot(page, projectId)).sfxClips).toEqual(regenerated.sfxClips);
    await page.getByRole("button", { name: "Back to all projects" }).click();
    const projectLink = page.locator(`a[href="/repurpose-studio/${projectId}"]`);
    await expect(projectLink).toBeVisible();
    await projectLink.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 30_000 });
    const reopened = await readSnapshot(page, projectId);
    expect(reopened.sfxClips).toEqual(regenerated.sfxClips);
    expect(reopened.sfxAssets).toEqual(regenerated.sfxAssets);
    expect(reopened.sfxTrack).toBeUndefined();
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});

test("migrates a legacy SFX bed into previewable clips and saves only the new model", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    type GainEvent = { kind: "set" | "ramp"; value: number; time: number };
    type TrackedParam = AudioParam & { __sfxGainEvents?: GainEvent[] };
    type TrackedGain = GainNode & { __sfxDestinationConnected?: boolean };
    type TrackedSource = AudioBufferSourceNode & { __sfxGain?: TrackedGain };
    const originalConnect = AudioBufferSourceNode.prototype.connect;
    Object.defineProperty(AudioBufferSourceNode.prototype, "connect", {
      configurable: true,
      value: function (this: TrackedSource, destination: AudioNode | AudioParam, ...rest: number[]) {
        if (destination instanceof GainNode) this.__sfxGain = destination as TrackedGain;
        return Reflect.apply(originalConnect, this, [destination, ...rest]);
      },
    });
    const originalGainConnect = GainNode.prototype.connect;
    Object.defineProperty(GainNode.prototype, "connect", {
      configurable: true,
      value: function (this: TrackedGain, destination: AudioNode | AudioParam, ...rest: number[]) {
        if (destination === this.context.destination) this.__sfxDestinationConnected = true;
        return Reflect.apply(originalGainConnect, this, [destination, ...rest]);
      },
    });
    const originalSetValueAtTime = AudioParam.prototype.setValueAtTime;
    Object.defineProperty(AudioParam.prototype, "setValueAtTime", {
      configurable: true,
      value: function (this: TrackedParam, value: number, time: number) {
        this.__sfxGainEvents ??= [];
        this.__sfxGainEvents.push({ kind: "set", value, time });
        return Reflect.apply(originalSetValueAtTime, this, [value, time]);
      },
    });
    const originalLinearRamp = AudioParam.prototype.linearRampToValueAtTime;
    Object.defineProperty(AudioParam.prototype, "linearRampToValueAtTime", {
      configurable: true,
      value: function (this: TrackedParam, value: number, time: number) {
        this.__sfxGainEvents ??= [];
        this.__sfxGainEvents.push({ kind: "ramp", value, time });
        return Reflect.apply(originalLinearRamp, this, [value, time]);
      },
    });
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: TrackedSource, ...args) {
      const state = window as typeof window & {
        __sfxPreviewStarts?: Array<{
          when: number;
          contextTime: number;
          playhead: number;
          offset: number;
          duration?: number;
          gainEvents: GainEvent[];
          contextState: AudioContextState;
          sourceConnectedToGain: boolean;
          gainConnectedToDestination: boolean;
        }>;
      };
      state.__sfxPreviewStarts ??= [];
      state.__sfxPreviewStarts.push({
        when: args[0] ?? 0,
        contextTime: this.context.currentTime,
        playhead: Number(document.querySelector('[aria-label="Playhead"]')?.getAttribute("aria-valuenow")),
        offset: args[1] ?? 0,
        duration: args[2],
        gainEvents: [...((this.__sfxGain?.gain as TrackedParam | undefined)?.__sfxGainEvents ?? [])],
        contextState: this.context.state,
        sourceConnectedToGain: this.__sfxGain !== undefined,
        gainConnectedToDestination: this.__sfxGain?.__sfxDestinationConnected === true,
      });
      return Reflect.apply(original, this, args);
    };
  });
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  const legacyFixture = await installLegacyFixture();
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );
    const legacyPath = legacyFixture.filePath;
    expect(path.dirname(legacyPath)).toBe(path.resolve(process.env.REPURPOSE_SFX_CACHE_DIR!));
    await seedProjectSnapshot<ProjectSnapshot>(page, projectId, (snapshot) => {
      delete snapshot.sfxClips;
      delete snapshot.sfxAssets;
      snapshot.sfxTrack = {
        src: `/api/repurpose/sfx?path=${encodeURIComponent(legacyPath)}`,
        sourcePath: legacyPath,
        durationSec: 1.73,
        gain: 1.37,
      };
      snapshot.playhead = 0;
      return snapshot;
    });

    const legacyBlock = page.locator('[data-sfx-clip-id="sfx-legacy"]');
    await expect(legacyBlock).toBeVisible();
    await expect(legacyBlock).toHaveAccessibleName(/Legacy Sound Effects, automatic/i);
    const migrated = await waitForSnapshot(page, projectId, (snapshot) => {
      const clip = snapshot.sfxClips?.[0];
      return snapshot.sfxTrack === undefined && snapshot.sfxClips?.length === 1 &&
        clip?.source.kind === "legacy" && clip.gain === 1.37;
    });
    expect(migrated.sfxClips![0]).toMatchObject({
      id: "sfx-legacy",
      origin: "automatic",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 1.73,
      gain: 1.37,
      source: { kind: "legacy", sourcePath: legacyPath, srcDuration: 1.73 },
    });

    const legacySelect = page.locator('[data-sfx-select-id="sfx-legacy"]');
    await legacySelect.focus();
    await legacySelect.press("Shift+ArrowRight");
    await waitForSnapshot(page, projectId, (snapshot) =>
      Math.abs((snapshot.sfxClips?.[0].timelineStart ?? 0) - 10 / 30) < 0.001
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForSnapshot(page, projectId, (snapshot) => snapshot.sfxClips?.[0].timelineStart === 0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await waitForSnapshot(page, projectId, (snapshot) =>
      Math.abs((snapshot.sfxClips?.[0].timelineStart ?? 0) - 10 / 30) < 0.001
    );
    await page.getByRole("slider", { name: "Source in for Legacy Sound Effects" }).fill("0.25");
    await page.getByRole("slider", { name: "Fade in for Legacy Sound Effects" }).fill("0.1");
    await page.getByRole("slider", { name: "Fade out for Legacy Sound Effects" }).fill("0.15");
    const editedLegacy = await waitForSnapshot(page, projectId, (snapshot) => {
      const clip = snapshot.sfxClips?.[0];
      return Boolean(
        clip &&
          Math.abs(clip.timelineStart - 10 / 30) < 0.001 &&
          clip.sourceStart === 0.25 &&
          clip.sourceEnd === 1.73 &&
          clip.gain === 1.37 &&
          clip.fadeInSec === 0.1 &&
          clip.fadeOutSec === 0.15
      );
    });
    expect(editedLegacy.sfxClips![0]).toMatchObject({
      sourceStart: 0.25,
      sourceEnd: 1.73,
      gain: 1.37,
      fadeInSec: 0.1,
      fadeOutSec: 0.15,
      origin: "automatic",
      source: { kind: "legacy", sourcePath: legacyPath, srcDuration: 1.73 },
    });
    expect(editedLegacy.sfxClips![0].timelineStart).toBeCloseTo(10 / 30, 12);

    const renderedEvidence = await page.evaluate(async ({ sourcePath, clip }) => {
      const response = await fetch(`/api/repurpose/sfx?path=${encodeURIComponent(sourcePath)}`);
      if (!response.ok) throw new Error(`Legacy source fetch failed: ${response.status}`);
      const decoder = new AudioContext();
      const sourceBuffer = await decoder.decodeAudioData(await response.arrayBuffer());
      await decoder.close();
      const sampleRate = 48_000;
      const clipDuration = clip.sourceEnd - clip.sourceStart;
      const renderedDuration = clip.timelineStart + clipDuration + 0.1;
      const offline = new OfflineAudioContext(1, Math.ceil(renderedDuration * sampleRate), sampleRate);
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      source.buffer = sourceBuffer;
      source.connect(gain);
      gain.connect(offline.destination);
      const start = clip.timelineStart;
      const end = start + clipDuration;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(clip.gain, start + clip.fadeInSec);
      gain.gain.setValueAtTime(clip.gain, end - clip.fadeOutSec);
      gain.gain.linearRampToValueAtTime(0, end);
      source.start(start, clip.sourceStart, clipDuration);
      const rendered = (await offline.startRendering()).getChannelData(0);
      const rms = (from: number, to: number) => {
        const first = Math.max(0, Math.floor(from * sampleRate));
        const last = Math.min(rendered.length, Math.ceil(to * sampleRate));
        let sum = 0;
        for (let index = first; index < last; index += 1) sum += rendered[index] ** 2;
        return last > first ? Math.sqrt(sum / (last - first)) : 0;
      };
      let firstAudibleSample = -1;
      for (let index = 0; index < rendered.length; index += 1) {
        if (Math.abs(rendered[index]) > 1e-4) {
          firstAudibleSample = index;
          break;
        }
      }
      return {
        firstAudibleSec: firstAudibleSample / sampleRate,
        beforeRms: rms(0.1, 0.2),
        fadeRms: rms(start + 0.01, start + 0.03),
        sustainedRms: rms(start + 0.15, start + 0.25),
        tailRms: rms(end + 0.02, end + 0.08),
      };
    }, {
      sourcePath: legacyPath,
      clip: editedLegacy.sfxClips![0],
    });
    expect(renderedEvidence.firstAudibleSec).toBeCloseTo(10 / 30, 2);
    expect(renderedEvidence.beforeRms).toBeLessThan(1e-6);
    expect(renderedEvidence.fadeRms).toBeGreaterThan(0.001);
    expect(renderedEvidence.sustainedRms).toBeGreaterThan(renderedEvidence.fadeRms * 2);
    expect(renderedEvidence.tailRms).toBeLessThan(1e-6);

    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    const sourceResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/repurpose/sfx" && url.searchParams.get("path") === legacyPath;
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    expect((await sourceResponse).ok()).toBe(true);
    await page.waitForTimeout(500);
    const initialStarts = await page.evaluate(() =>
      (window as typeof window & { __sfxPreviewStarts?: unknown[] }).__sfxPreviewStarts?.length ?? 0
    );
    if (initialStarts === 0) {
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      if (await pause.isVisible()) await pause.click();
      await page.getByRole("button", { name: "Go to start", exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as typeof window & { __sfxPreviewStarts?: unknown[] }).__sfxPreviewStarts?.length ?? 0
        ), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const starts = await page.evaluate(() =>
      (window as typeof window & {
        __sfxPreviewStarts?: Array<{
          when: number;
          contextTime: number;
          playhead: number;
          offset: number;
          duration?: number;
          gainEvents: Array<{ kind: "set" | "ramp"; value: number; time: number }>;
          contextState: AudioContextState;
          sourceConnectedToGain: boolean;
          gainConnectedToDestination: boolean;
        }>;
      }).__sfxPreviewStarts ?? []
    );
    const scheduledLegacy = starts.find((start) =>
      Math.abs(start.offset - 0.25) < 0.001 &&
      Math.abs((start.duration ?? 0) - 1.48) < 0.01 &&
      start.gainEvents.some(
        (event) => event.kind === "set" && event.value === 0 && Math.abs(event.time - start.when) < 0.001
      ) &&
      start.gainEvents.some(
        (event) => event.kind === "ramp" && Math.abs(event.value - 1.37) < 0.001 &&
          Math.abs(event.time - (start.when + 0.1)) < 0.01
      ) &&
      start.contextState === "running" &&
      start.sourceConnectedToGain &&
      start.gainConnectedToDestination
    );
    expect(scheduledLegacy).toBeDefined();
    expect(
      scheduledLegacy!.playhead + scheduledLegacy!.when - scheduledLegacy!.contextTime
    ).toBeCloseTo(10 / 30, 1);
    await expect.poll(async () => Number(
      await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow")
    )).toBeGreaterThan(0.1);
    await expect(page.getByRole("status", { name: "Sound effect preview warning" })).toHaveCount(0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    const regenerated = await waitForSnapshot(page, projectId, (snapshot) => {
      const automatic = snapshot.sfxClips?.filter((clip) => clip.origin === "automatic") ?? [];
      return snapshot.sfxTrack === undefined && automatic.length > 1 &&
        automatic.every((clip) => clip.source.kind === "built-in");
    });
    expect(regenerated.sfxClips).not.toContainEqual(expect.objectContaining({ id: "sfx-legacy" }));

    await page.reload();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 30_000 });
    const reopened = await readSnapshot(page, projectId);
    expect(reopened.sfxTrack).toBeUndefined();
    expect(reopened.sfxClips).toEqual(regenerated.sfxClips);
    expect(reopened.sfxClips?.every((clip) => clip.source.kind === "built-in")).toBe(true);
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
    await legacyFixture.cleanup();
  }
});
