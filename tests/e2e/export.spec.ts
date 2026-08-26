import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeAudio,
  analyzeAudioDifference,
  frameRate,
  mediaDuration,
  probeMedia,
} from "./helpers/audio-analysis";
import {
  GENERATED_FIXTURES,
  cleanupProject,
  collectBrowserErrors,
  createProjectWithFootage,
  currentDurableProjectId,
} from "./helpers/project";

test.setTimeout(300_000);

async function saveExport(
  page: Page,
  testInfo: TestInfo,
  artifactName: string
): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath(artifactName);
  await download.saveAs(outputPath);
  await expect(page.getByRole("button", { name: "Export MP4", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByRole("alert").filter({ hasText: "Export failed" })).toHaveCount(0);
  return outputPath;
}

async function chooseFiles(
  page: Page,
  buttonName: string,
  files: string | string[]
): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

async function assertExportMetadata(filePath: string): Promise<void> {
  const probe = await probeMedia(filePath);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
  expect(video).toBeDefined();
  expect(video!.codec_name).toBe("h264");
  expect(video).toMatchObject({ width: 1080, height: 1920 });
  expect(audio.length).toBeGreaterThanOrEqual(1);
  const fps = frameRate(video!);
  expect(Math.abs(mediaDuration(probe) - 3)).toBeLessThanOrEqual(
    Math.max(0.5, 2 / fps)
  );
}

test("exports a three-second layered 1080p MP4 with narration, music, and timed SFX", async ({
  page,
  context,
}, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
    });
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );

    const controlPath = await saveExport(page, testInfo, "control-base.mp4");

    const captionsHeading = page.getByRole("heading", { name: "Captions", exact: true });
    await captionsHeading
      .locator("..")
      .getByRole("button", { name: "Off", exact: true })
      .click();
    await expect(
      captionsHeading.locator("..").getByRole("button", { name: "On", exact: true })
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await chooseFiles(page, "Add media (image / video)", [
      path.join(GENERATED_FIXTURES, "overlay.png"),
      path.join(GENERATED_FIXTURES, "overlay.mp4"),
    ]);
    await expect(page.locator("video[data-overlay-id]")).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/repurpose/projects/${projectId}`
          );
          const body = (await response.json()) as {
            project?: { snapshot?: { overlays?: unknown[] } };
          };
          return body.project?.snapshot?.overlays?.length ?? 0;
        },
        { timeout: 30_000 }
      )
      .toBe(2);
    const persistedOverlays = await page.request
      .get(`/api/repurpose/projects/${projectId}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          project?: { snapshot?: { overlays?: Array<{ kind: string; src: string; sourcePath?: string }> } };
        };
        return body.project?.snapshot?.overlays ?? [];
      });
    expect(persistedOverlays.find((overlay) => overlay.kind === "image")?.src).toMatch(
      /^\/api\/repurpose\/asset\?path=/
    );

    await chooseFiles(
      page,
      "Add music",
      path.join(GENERATED_FIXTURES, "music.wav")
    );
    await expect(page.getByText(/music\.wav \(3s\)/)).toBeVisible({ timeout: 30_000 });
    const musicControlPath = await saveExport(
      page,
      testInfo,
      "music-control.mp4"
    );

    await page.getByRole("button", { name: "Generate SFX track", exact: true }).click();
    await expect(page.getByText("SFX track loaded (3s)", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("slider", { name: "SFX track volume" }).fill("2");
    await expect(page.getByText("200%", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "screenshot", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
      "aria-valuenow",
      /1\.[34]/
    );
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot(
      "export-layers.png",
      { animations: "disabled", maxDiffPixelRatio: 0.03 }
    );

    const layeredPath = await saveExport(page, testInfo, "layered-1080p.mp4");
    await assertExportMetadata(controlPath);
    await assertExportMetadata(musicControlPath);
    await assertExportMetadata(layeredPath);

    const player = await context.newPage();
    await player.setViewportSize({ width: 600, height: 1_020 });
    await player.goto(pathToFileURL(layeredPath).href);
    const exportedVideo = player.locator("video");
    const decoded = await exportedVideo.evaluate(async (video: HTMLVideoElement) => {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadedmetadata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(video.error), { once: true });
        });
      }
      video.controls = false;
      video.style.width = "540px";
      video.style.height = "960px";
      video.style.objectFit = "contain";
      video.style.background = "black";
      video.currentTime = 1.4;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(video.error), { once: true });
      });
      video.pause();
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      };
    });
    expect(decoded).toMatchObject({ width: 1080, height: 1920 });
    expect(decoded.duration).toBeGreaterThan(2.5);
    await expect(exportedVideo).toHaveScreenshot("exported-layers.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });
    await player.close();

    const [controlAudio, musicControlAudio, layeredAudio, sfxDifference] = await Promise.all([
      analyzeAudio(controlPath, 2.2),
      analyzeAudio(musicControlPath, 2.2),
      analyzeAudio(layeredPath, 2.2),
      analyzeAudioDifference(musicControlPath, layeredPath, 2.2),
    ]);
    console.log(
      "EXPORT_AUDIO_MEASUREMENTS",
      JSON.stringify({
        control: controlAudio,
        musicControl: musicControlAudio,
        layered: layeredAudio,
        sfxDifference,
      })
    );
    expect(layeredAudio.hz220).toBeGreaterThanOrEqual(controlAudio.hz220 * 4);
    expect(layeredAudio.sfxWindowRms).toBeGreaterThanOrEqual(
      controlAudio.sfxWindowRms * 1.5
    );
    // Subtract an export with the same narration + continuous music. A nonzero
    // residual in the timed event window can only come from the added SFX layer.
    expect(sfxDifference.eventRms).toBeGreaterThan(0.01);
    expect(sfxDifference.fullRms).toBeGreaterThan(0.005);
    expect(layeredAudio.hz440).toBeGreaterThanOrEqual(controlAudio.hz440 * 0.5);
    expect(layeredAudio.hz440).toBeGreaterThan(0.01);
    await expect(page.getByRole("status", { name: "Export warning" })).toHaveCount(0);
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
