import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
const EXPORT_FPS = 30;

interface PreviewParityFrame {
  frame: number;
  time: number;
  dataUrl: string;
}

interface PixelParity {
  exportTime: number;
  fullMae: number;
  captionBandMae: number;
  fullLargeDiffRatio: number;
  captionBandLargeDiffRatio: number;
}

async function playheadValue(page: Page): Promise<number> {
  return Number(
    await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow")
  );
}

async function capturePreviewParityFrame(
  page: Page,
  frame: number,
  fps = 30
): Promise<PreviewParityFrame> {
  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  for (let index = 0; index < frame; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  const time = frame / fps;
  await expect.poll(() => playheadValue(page)).toBeCloseTo(time, 2);
  await page.evaluate(() => {
    delete (window as typeof window & { __previewParityState?: unknown }).__previewParityState;
  });
  await page.waitForFunction(
    () => {
      const state = window as typeof window & {
        __previewParityState?: { signature: number; stableCount: number };
      };
      const source = document.querySelector<HTMLCanvasElement>("#preview-panel canvas");
      if (!source) return false;
      const sample = document.createElement("canvas");
      sample.width = 48;
      sample.height = 48;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(source, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let signature = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        signature ^= pixels[index];
        signature = Math.imul(signature, 16777619);
        signature ^= pixels[index + 1];
        signature = Math.imul(signature, 16777619);
        signature ^= pixels[index + 2];
        signature = Math.imul(signature, 16777619);
      }
      const previous = state.__previewParityState;
      const stableCount = previous?.signature === signature ? previous.stableCount + 1 : 0;
      state.__previewParityState = { signature, stableCount };
      return stableCount >= 3;
    },
    undefined,
    { polling: 100, timeout: 10_000 }
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const dataUrl = await page
    .locator("#preview-panel canvas")
    .first()
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png"));
  return { frame, time, dataUrl };
}

async function comparePreviewToExport(
  video: ReturnType<Page["locator"]>,
  preview: PreviewParityFrame,
  fps = 30
): Promise<PixelParity> {
  return video.evaluate(
    async (element: HTMLVideoElement, { previewDataUrl, seekTime }) => {
      element.currentTime = seekTime;
      await new Promise<void>((resolve, reject) => {
        element.addEventListener("seeked", () => resolve(), { once: true });
        element.addEventListener("error", () => reject(element.error), { once: true });
      });
      element.pause();

      const previewImage = new Image();
      previewImage.src = previewDataUrl;
      await previewImage.decode();
      const width = element.videoWidth;
      const height = element.videoHeight;
      const makeCanvas = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      };
      const previewCanvas = makeCanvas();
      const exportCanvas = makeCanvas();
      const previewContext = previewCanvas.getContext("2d", { willReadFrequently: true });
      const exportContext = exportCanvas.getContext("2d", { willReadFrequently: true });
      if (!previewContext || !exportContext) throw new Error("2D canvas is unavailable");
      previewContext.drawImage(previewImage, 0, 0, width, height);
      exportContext.drawImage(element, 0, 0, width, height);
      const left = previewContext.getImageData(0, 0, width, height).data;
      const right = exportContext.getImageData(0, 0, width, height).data;
      let fullSum = 0;
      let fullCount = 0;
      let fullLarge = 0;
      let bandSum = 0;
      let bandCount = 0;
      let bandLarge = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const inCaptionBand =
            y >= height * 0.38 &&
            y <= height * 0.62 &&
            x >= width * 0.1 &&
            x <= width * 0.9;
          const offset = (y * width + x) * 4;
          const difference =
            (Math.abs(left[offset] - right[offset]) +
              Math.abs(left[offset + 1] - right[offset + 1]) +
              Math.abs(left[offset + 2] - right[offset + 2])) /
            3;
          fullSum += difference;
          fullCount += 1;
          if (difference > 24) fullLarge += 1;
          if (inCaptionBand) {
            bandSum += difference;
            bandCount += 1;
            if (difference > 24) bandLarge += 1;
          }
        }
      }
      return {
        exportTime: element.currentTime,
        fullMae: fullSum / fullCount,
        captionBandMae: bandSum / bandCount,
        fullLargeDiffRatio: fullLarge / fullCount,
        captionBandLargeDiffRatio: bandLarge / bandCount,
      };
    },
    {
      previewDataUrl: preview.dataUrl,
      // Seek halfway through the encoded frame so Chrome cannot select the
      // preceding frame at an exact timestamp boundary.
      seekTime: (preview.frame + 0.5) / fps,
    }
  );
}

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
    const parityFrames: PreviewParityFrame[] = [];
    for (const frame of [15, 45, 75]) {
      parityFrames.push(await capturePreviewParityFrame(page, frame));
    }
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    for (let index = 0; index < 45; index += 1) await page.keyboard.press("ArrowRight");
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot(
      "export-layers.png",
      { animations: "disabled", maxDiffPixelRatio: 0.03 }
    );

    const layeredPath = await saveExport(page, testInfo, "layered-1080p.mp4");
    await assertExportMetadata(controlPath);
    await assertExportMetadata(musicControlPath);
    await assertExportMetadata(layeredPath);

    const exportedBytes = await readFile(layeredPath);
    await context.route("**/__e2e-layered-export.mp4", async (route) => {
      const range = route.request().headers().range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const suffixLength = range[1] === "" ? Number(range[2]) : undefined;
        const start = suffixLength === undefined
          ? Number(range[1])
          : Math.max(0, exportedBytes.length - suffixLength);
        const end = suffixLength === undefined && range[2] !== ""
          ? Math.min(Number(range[2]), exportedBytes.length - 1)
          : exportedBytes.length - 1;
        await route.fulfill({
          status: 206,
          contentType: "video/mp4",
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${exportedBytes.length}`,
          },
          body: exportedBytes.subarray(start, end + 1),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(exportedBytes.length),
        },
        body: exportedBytes,
      });
    });
    const player = await context.newPage();
    await player.setViewportSize({ width: 600, height: 1_020 });
    await player.goto("/repurpose-studio");
    await player.setContent(
      '<video src="/__e2e-layered-export.mp4" preload="auto" playsinline></video>'
    );
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
      video.pause();
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      };
    });
    expect(decoded).toMatchObject({ width: 1080, height: 1920 });
    expect(decoded.duration).toBeGreaterThan(2.5);
    const pixelParity: PixelParity[] = [];
    for (const preview of parityFrames) {
      const frameLabel = preview.time.toFixed(1);
      const previewBytes = Buffer.from(preview.dataUrl.split(",")[1], "base64");
      await writeFile(testInfo.outputPath(`preview-${frameLabel}s.png`), previewBytes);
      await testInfo.attach(`preview-${preview.time.toFixed(1)}s.png`, {
        body: previewBytes,
        contentType: "image/png",
      });
      const metrics = await comparePreviewToExport(exportedVideo, preview);
      pixelParity.push(metrics);
      const exportedFrame = await exportedVideo.screenshot({ animations: "disabled" });
      await writeFile(testInfo.outputPath(`export-${frameLabel}s.png`), exportedFrame);
      await testInfo.attach(`export-${preview.time.toFixed(1)}s.png`, {
        body: exportedFrame,
        contentType: "image/png",
      });
    }
    console.log("EXPORT_PIXEL_PARITY", JSON.stringify(pixelParity));
    for (const [index, metrics] of pixelParity.entries()) {
      expect(metrics.exportTime).toBeCloseTo((parityFrames[index].frame + 0.5) / EXPORT_FPS, 2);
      expect(metrics.fullMae).toBeLessThan(12);
      expect(metrics.captionBandMae).toBeLessThan(12);
      expect(metrics.fullLargeDiffRatio).toBeLessThan(0.02);
      expect(metrics.captionBandLargeDiffRatio).toBeLessThan(0.02);
    }
    await exportedVideo.evaluate(async (video: HTMLVideoElement) => {
      video.currentTime = 1.5 + 1 / 60;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(video.error), { once: true });
      });
      video.pause();
    });
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
