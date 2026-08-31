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

    await selectAutomatic.focus();
    await page.getByRole("button", { name: `Duplicate ${editedAutomatic.name}`, exact: true }).click();
    const duplicated = await waitForSnapshot(page, projectId, (snapshot) =>
      (snapshot.sfxClips ?? []).some(
        (clip) =>
          clip.id !== editedAutomatic.id &&
          clip.origin === "manual" &&
          clip.source.kind === authoredAutomatic.source.kind &&
          clip.gain === authoredAutomatic.gain &&
          clip.fadeInSec === authoredAutomatic.fadeInSec &&
          clip.fadeOutSec === authoredAutomatic.fadeOutSec &&
          clip.muted === authoredAutomatic.muted
      )
    );
    const duplicate = duplicated.sfxClips!.find(
      (clip) =>
        clip.id !== editedAutomatic.id &&
        clip.origin === "manual" &&
        clip.name === editedAutomatic.name &&
        clip.gain === authoredAutomatic.gain
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
    const regeneratedOriginal = regenerated.sfxClips!.find(
      (clip) => clip.id === editedAutomatic.id
    );
    expect(
      regeneratedOriginal === undefined ||
        regeneratedOriginal.timelineStart !== authoredAutomatic.timelineStart ||
        regeneratedOriginal.gain !== authoredAutomatic.gain ||
        regeneratedOriginal.fadeInSec !== authoredAutomatic.fadeInSec ||
        regeneratedOriginal.fadeOutSec !== authoredAutomatic.fadeOutSec ||
        regeneratedOriginal.muted !== authoredAutomatic.muted
    ).toBe(true);

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
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const state = window as typeof window & {
        __sfxPreviewStarts?: Array<{ when: number; offset: number; duration?: number }>;
      };
      state.__sfxPreviewStarts ??= [];
      state.__sfxPreviewStarts.push({
        when: args[0] ?? 0,
        offset: args[1] ?? 0,
        duration: args[2],
      });
      return original.apply(this, args);
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
        durationSec: 2,
        gain: 0.65,
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
        clip?.source.kind === "legacy" && clip.gain === 0.65;
    });
    expect(migrated.sfxClips![0]).toMatchObject({
      id: "sfx-legacy",
      origin: "automatic",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 2,
      gain: 0.65,
      source: { kind: "legacy", sourcePath: legacyPath, srcDuration: 2 },
    });

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
        __sfxPreviewStarts?: Array<{ offset: number; duration?: number }>;
      }).__sfxPreviewStarts ?? []
    );
    expect(
      starts.some(
        (start) => start.offset >= 0 && start.offset < 2 && (start.duration ?? 0) > 0
      )
    ).toBe(true);
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
