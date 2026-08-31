import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
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
  const hash = createHash("sha256").update(await readFile(source)).digest("hex");
  const directory = process.env.REPURPOSE_SFX_CACHE_DIR
    ? path.resolve(process.env.REPURPOSE_SFX_CACHE_DIR)
    : path.join(os.homedir(), "Downloads", "repurpose-overlays");
  const filePath = path.join(directory, `sfx-${hash}.wav`);
  await mkdir(directory, { recursive: true });
  let created = false;
  try {
    await access(filePath);
  } catch {
    await copyFile(source, filePath);
    created = true;
  }
  return {
    filePath,
    async cleanup() {
      if (created) await rm(filePath, { force: true });
    },
  };
}

async function seekToFrame(page: Page, frame: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let index = 0; index < frame; index += 1) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuenow",
    new RegExp(`^${(frame / 30).toFixed(3).replace(/0+$/, "")}`)
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
    type GainEvent = { value: number; time: number };
    type TrackedParam = AudioParam & { __sfxGainEvents?: GainEvent[] };
    type TrackedSource = AudioBufferSourceNode & { __sfxGain?: GainNode };
    const originalConnect = AudioBufferSourceNode.prototype.connect;
    Object.defineProperty(AudioBufferSourceNode.prototype, "connect", {
      configurable: true,
      value: function (this: TrackedSource, destination: AudioNode | AudioParam, ...rest: number[]) {
        if (destination instanceof GainNode) this.__sfxGain = destination;
        return Reflect.apply(originalConnect, this, [destination, ...rest]);
      },
    });
    const originalSetValueAtTime = AudioParam.prototype.setValueAtTime;
    Object.defineProperty(AudioParam.prototype, "setValueAtTime", {
      configurable: true,
      value: function (this: TrackedParam, value: number, time: number) {
        this.__sfxGainEvents ??= [];
        this.__sfxGainEvents.push({ value, time });
        return Reflect.apply(originalSetValueAtTime, this, [value, time]);
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
    const editedLegacy = await waitForSnapshot(page, projectId, (snapshot) => {
      const clip = snapshot.sfxClips?.[0];
      return Boolean(
        clip &&
          Math.abs(clip.timelineStart - 10 / 30) < 0.001 &&
          clip.sourceStart === 0.25 &&
          clip.sourceEnd === 1.73 &&
          clip.gain === 1.37
      );
    });
    expect(editedLegacy.sfxClips![0]).toMatchObject({
      sourceStart: 0.25,
      sourceEnd: 1.73,
      gain: 1.37,
      origin: "automatic",
      source: { kind: "legacy", sourcePath: legacyPath, srcDuration: 1.73 },
    });
    expect(editedLegacy.sfxClips![0].timelineStart).toBeCloseTo(10 / 30, 12);

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
          gainEvents: Array<{ value: number; time: number }>;
        }>;
      }).__sfxPreviewStarts ?? []
    );
    const scheduledLegacy = starts.find((start) =>
      Math.abs(start.offset - 0.25) < 0.001 &&
      Math.abs((start.duration ?? 0) - 1.48) < 0.01 &&
      start.gainEvents.some(
        (event) => Math.abs(event.value - 1.37) < 0.001 && Math.abs(event.time - start.when) < 0.001
      )
    );
    expect(scheduledLegacy).toBeDefined();
    expect(
      scheduledLegacy!.playhead + scheduledLegacy!.when - scheduledLegacy!.contextTime
    ).toBeCloseTo(10 / 30, 1);
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
