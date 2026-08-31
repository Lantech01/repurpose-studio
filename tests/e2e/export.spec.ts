import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeAudio,
  analyzeAudioDifference,
  analyzeAudioDifferenceWindows,
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
  seedProjectSnapshot,
} from "./helpers/project";
import type { Overlay, ProjectSnapshot } from "@/lib/repurpose/types";

test.setTimeout(300_000);
const EXPORT_FPS = 30;

interface PreviewParityFrame {
  frame: number;
  time: number;
  dataUrl: string;
  captureMode: "canvas" | "screenshot";
}

interface PixelParity {
  exportTime: number;
  fullMae: number;
  captionBandMae: number;
  fullLargeDiffRatio: number;
  captionBandLargeDiffRatio: number;
  previewVisual?: VisualStats;
  exportVisual?: VisualStats;
  previewSamples?: number[][];
  exportSamples?: number[][];
}

interface VisualStats {
  count: number;
  meanDelta: number;
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
  centerX: number | null;
  centerY: number | null;
}

interface PixelAnalysis {
  baseColor: [number, number, number];
  region: { left: number; top: number; right: number; bottom: number };
  points?: Array<{ x: number; y: number }>;
  threshold?: number;
}

interface NormalizedRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ColorRegionCounts {
  preview: number[];
  export: number[];
}

async function playheadValue(page: Page): Promise<number> {
  return Number(
    await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow")
  );
}

async function capturePreviewParityFrame(
  page: Page,
  frame: number,
  fps = 30,
  expectedSplitPct?: number
): Promise<PreviewParityFrame> {
  let currentFrame = Math.round((await playheadValue(page)) * fps);
  if (currentFrame > frame) {
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    currentFrame = 0;
  }
  let remaining = frame - currentFrame;
  while (remaining >= fps) {
    await page.keyboard.press("Shift+ArrowRight");
    remaining -= fps;
  }
  for (let index = 0; index < remaining; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  const time = frame / fps;
  await expect.poll(() => playheadValue(page)).toBeCloseTo(time, 2);
  if (expectedSplitPct !== undefined) {
    const divider = page.getByRole("separator", {
      name: "Adjust screen and face split",
    });
    await expect
      .poll(async () => Number(await divider.getAttribute("aria-valuenow")))
      .toBeCloseTo(expectedSplitPct, 1);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const canvas = page.locator("#preview-panel canvas").first();
  try {
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
    const dataUrl = await canvas.evaluate((element: HTMLCanvasElement) =>
      element.toDataURL("image/png")
    );
    return { frame, time, dataUrl, captureMode: "canvas" };
  } catch (error) {
    if (!(error instanceof Error) || !/SecurityError|tainted by cross-origin data/i.test(error.message)) {
      throw error;
    }
  }

  await page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>("#preview-panel canvas");
    if (!source) throw new Error("Preview canvas is unavailable");
    const capture = document.createElement("canvas");
    capture.id = "e2e-preview-parity-capture";
    capture.width = source.width;
    capture.height = source.height;
    capture.style.position = "fixed";
    capture.style.left = "0";
    capture.style.top = "0";
    capture.style.width = `${source.width}px`;
    capture.style.height = `${source.height}px`;
    capture.style.zIndex = "2147483647";
    document.body.append(capture);
  });
  const nativeCapture = page.locator("#e2e-preview-parity-capture");
  let previous: Buffer | null = null;
  let current: Buffer | null = null;
  let stableCount = 0;
  try {
    for (let attempt = 0; attempt < 30 && stableCount < 2; attempt += 1) {
      await page.evaluate(() => {
        const source = document.querySelector<HTMLCanvasElement>("#preview-panel canvas");
        const capture = document.querySelector<HTMLCanvasElement>("#e2e-preview-parity-capture");
        const context = capture?.getContext("2d");
        if (!source || !capture || !context) throw new Error("Preview capture canvas is unavailable");
        context.clearRect(0, 0, capture.width, capture.height);
        context.drawImage(source, 0, 0);
      });
      current = await nativeCapture.screenshot({ animations: "disabled" });
      stableCount = previous?.equals(current) ? stableCount + 1 : 0;
      previous = current;
      if (stableCount < 2) await page.waitForTimeout(100);
    }
  } finally {
    await page.evaluate(() => document.querySelector("#e2e-preview-parity-capture")?.remove());
  }
  expect(stableCount, `preview frame ${frame} did not settle`).toBe(2);
  return {
    frame,
    time,
    dataUrl: `data:image/png;base64,${current!.toString("base64")}`,
    captureMode: "screenshot",
  };
}

async function comparePreviewToExport(
  video: ReturnType<Page["locator"]>,
  preview: PreviewParityFrame,
  fps = 30,
  analysis?: PixelAnalysis
): Promise<PixelParity> {
  await video.evaluate(async (element: HTMLVideoElement, seekTime) => {
    element.currentTime = seekTime;
    await new Promise<void>((resolve, reject) => {
      element.addEventListener("seeked", () => resolve(), { once: true });
      element.addEventListener("error", () => reject(element.error), { once: true });
    });
    element.pause();
  }, (preview.frame + 0.5) / fps);
  const exportScreenshotDataUrl = preview.captureMode === "screenshot"
    ? `data:image/png;base64,${(await video.screenshot({ animations: "disabled" })).toString("base64")}`
    : null;
  return video.evaluate(
    async (element: HTMLVideoElement, { previewDataUrl, exportScreenshotDataUrl, analysis }) => {
      const previewImage = new Image();
      previewImage.src = previewDataUrl;
      await previewImage.decode();
      const exportImage = exportScreenshotDataUrl ? new Image() : null;
      if (exportImage && exportScreenshotDataUrl) {
        exportImage.src = exportScreenshotDataUrl;
        await exportImage.decode();
      }
      const width = Math.min(540, element.videoWidth);
      const height = Math.round((element.videoHeight / element.videoWidth) * width);
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
      exportContext.drawImage(exportImage ?? element, 0, 0, width, height);
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
      const visualStats = (pixels: Uint8ClampedArray): VisualStats | undefined => {
        if (!analysis) return undefined;
        const threshold = analysis.threshold ?? 35;
        const x0 = Math.max(0, Math.floor(analysis.region.left * width));
        const x1 = Math.min(width, Math.ceil(analysis.region.right * width));
        const y0 = Math.max(0, Math.floor(analysis.region.top * height));
        const y1 = Math.min(height, Math.ceil(analysis.region.bottom * height));
        let count = 0;
        let deltaSum = 0;
        let left = width;
        let right = -1;
        let top = height;
        let bottom = -1;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const offset = (y * width + x) * 4;
            const delta = Math.max(
              Math.abs(pixels[offset] - analysis.baseColor[0]),
              Math.abs(pixels[offset + 1] - analysis.baseColor[1]),
              Math.abs(pixels[offset + 2] - analysis.baseColor[2])
            );
            if (delta <= threshold) continue;
            count += 1;
            deltaSum += delta;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
        return {
          count,
          meanDelta: count > 0 ? deltaSum / count : 0,
          left: count > 0 ? left : null,
          right: count > 0 ? right : null,
          top: count > 0 ? top : null,
          bottom: count > 0 ? bottom : null,
          centerX: count > 0 ? (left + right) / 2 : null,
          centerY: count > 0 ? (top + bottom) / 2 : null,
        };
      };
      const samples = (pixels: Uint8ClampedArray): number[][] | undefined =>
        analysis?.points?.map(({ x, y }) => {
          const px = Math.max(0, Math.min(width - 1, Math.round(x * width)));
          const py = Math.max(0, Math.min(height - 1, Math.round(y * height)));
          return [...pixels.slice((py * width + px) * 4, (py * width + px) * 4 + 4)];
        });
      return {
        exportTime: element.currentTime,
        fullMae: fullSum / fullCount,
        captionBandMae: bandSum / bandCount,
        fullLargeDiffRatio: fullLarge / fullCount,
        captionBandLargeDiffRatio: bandLarge / bandCount,
        previewVisual: visualStats(left),
        exportVisual: visualStats(right),
        previewSamples: samples(left),
        exportSamples: samples(right),
      };
    },
    {
      previewDataUrl: preview.dataUrl,
      exportScreenshotDataUrl,
      analysis,
    }
  );
}

async function countColorInRegions(
  video: Locator,
  preview: PreviewParityFrame,
  target: [number, number, number],
  regions: NormalizedRegion[],
  tolerance = 55,
  fps = EXPORT_FPS
): Promise<ColorRegionCounts> {
  return video.evaluate(
    async (element: HTMLVideoElement, input) => {
      element.currentTime = (input.frame + 0.5) / input.fps;
      await new Promise<void>((resolve, reject) => {
        element.addEventListener("seeked", () => resolve(), { once: true });
        element.addEventListener("error", () => reject(element.error), { once: true });
      });
      element.pause();

      const previewImage = new Image();
      previewImage.src = input.previewDataUrl;
      await previewImage.decode();
      const width = Math.min(540, element.videoWidth);
      const height = Math.round((element.videoHeight / element.videoWidth) * width);
      const pixelsFor = (source: CanvasImageSource) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("2D canvas is unavailable");
        context.drawImage(source, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const count = (pixels: Uint8ClampedArray, region: NormalizedRegion) => {
        const x0 = Math.max(0, Math.floor(region.left * width));
        const x1 = Math.min(width, Math.ceil(region.right * width));
        const y0 = Math.max(0, Math.floor(region.top * height));
        const y1 = Math.min(height, Math.ceil(region.bottom * height));
        let matches = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const offset = (y * width + x) * 4;
            if (
              Math.abs(pixels[offset] - input.target[0]) <= input.tolerance &&
              Math.abs(pixels[offset + 1] - input.target[1]) <= input.tolerance &&
              Math.abs(pixels[offset + 2] - input.target[2]) <= input.tolerance
            ) {
              matches += 1;
            }
          }
        }
        return matches;
      };
      const previewPixels = pixelsFor(previewImage);
      const exportPixels = pixelsFor(element);
      return {
        preview: input.regions.map((region) => count(previewPixels, region)),
        export: input.regions.map((region) => count(exportPixels, region)),
      };
    },
    {
      previewDataUrl: preview.dataUrl,
      frame: preview.frame,
      fps,
      target,
      regions,
      tolerance,
    }
  );
}

async function saveExport(
  page: Page,
  testInfo: TestInfo,
  artifactName: string,
  options: { programmaticClick?: boolean } = {}
): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  const exportButton = page.getByRole("button", { name: "Export MP4", exact: true });
  if (options.programmaticClick) {
    await exportButton.evaluate((button: HTMLButtonElement) => button.click());
  } else {
    await exportButton.click();
  }
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath(artifactName);
  await download.saveAs(outputPath);
  await expect(page.getByRole("button", { name: "Export MP4", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByRole("alert").filter({ hasText: "Export failed" })).toHaveCount(0);
  return outputPath;
}

async function readProjectSnapshot(page: Page, projectId: string): Promise<ProjectSnapshot> {
  const response = await page.request.get(`/api/repurpose/projects/${projectId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    project: { snapshot: ProjectSnapshot };
  };
  return body.project.snapshot;
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

async function assertExportMetadata(
  filePath: string,
  expected: { width: number; height: number; duration: number } = {
    width: 1080,
    height: 1920,
    duration: 3,
  }
): Promise<void> {
  const probe = await probeMedia(filePath);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
  expect(video).toBeDefined();
  expect(video!.codec_name).toBe("h264");
  expect(video).toMatchObject({ width: expected.width, height: expected.height });
  expect(audio.length).toBeGreaterThanOrEqual(1);
  const fps = frameRate(video!);
  expect(Math.abs(mediaDuration(probe) - expected.duration)).toBeLessThanOrEqual(
    Math.max(0.5, 2 / fps)
  );
}

async function openExportedVideo(
  context: BrowserContext,
  filePath: string,
  routeName: string
): Promise<{ player: Page; video: Locator }> {
  const bytes = await readFile(filePath);
  const routePath = `/__${routeName}.mp4`;
  await context.route(`**${routePath}`, async (route) => {
    const range = route.request().headers().range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const suffixLength = range[1] === "" ? Number(range[2]) : undefined;
      const start =
        suffixLength === undefined
          ? Number(range[1])
          : Math.max(0, bytes.length - suffixLength);
      const end =
        suffixLength === undefined && range[2] !== ""
          ? Math.min(Number(range[2]), bytes.length - 1)
          : bytes.length - 1;
      await route.fulfill({
        status: 206,
        contentType: "video/mp4",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
        body: bytes.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
  });

  const player = await context.newPage();
  await player.goto("/repurpose-studio");
  await player.setContent(`<video src="${routePath}" preload="auto" playsinline></video>`);
  const video = player.locator("video");
  await video.evaluate(async (element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        element.addEventListener("loadedmetadata", () => resolve(), { once: true });
        element.addEventListener("error", () => reject(element.error), { once: true });
      });
    }
    element.pause();
  });
  return { player, video };
}

test("exports representative editable SFX with narration and music in a layered 1080p MP4", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(600_000);
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

    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    await expect.poll(() => page.locator("[data-sfx-clip-id]").count(), { timeout: 60_000 })
      .toBeGreaterThan(1);
    await page.getByLabel("Import sound effect").setInputFiles(
      path.join(GENERATED_FIXTURES, "editable-sfx.wav")
    );
    await expect
      .poll(async () => {
        const snapshot = await readProjectSnapshot(page, projectId!);
        const imported = snapshot.sfxClips?.find(
          (clip) => clip.origin === "manual" && clip.source.kind === "imported"
        );
        return imported && snapshot.sfxAssets?.length === 1 ? imported : null;
      }, { timeout: 30_000, intervals: [100, 250, 500] })
      .not.toBeNull();
    const beforeRegeneration = await readProjectSnapshot(page, projectId);
    const importedId = beforeRegeneration.sfxClips!.find(
      (clip) => clip.origin === "manual" && clip.source.kind === "imported"
    )!.id;
    const importedAsset = beforeRegeneration.sfxAssets!.find((asset) =>
      beforeRegeneration.sfxClips!.some(
        (clip) => clip.id === importedId && clip.source.kind === "imported" && clip.source.assetId === asset.id
      )
    )!;
    const assetRoot = path.resolve(process.env.REPURPOSE_ASSET_DIR!);
    const importedRelativePath = path.relative(assetRoot, path.resolve(importedAsset.sourcePath));
    expect(importedRelativePath).not.toBe("");
    expect(importedRelativePath.startsWith("..") || path.isAbsolute(importedRelativePath)).toBe(false);
    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await readProjectSnapshot(page, projectId!);
        return [
          snapshot.sfxClips?.some((clip) => clip.id === importedId && clip.origin === "manual"),
          (snapshot.sfxClips?.filter((clip) => clip.origin === "automatic").length ?? 0) > 1,
        ];
      }, { timeout: 30_000, intervals: [100, 250, 500] })
      .toEqual([true, true]);

    const regeneratedSfx = await readProjectSnapshot(page, projectId);
    const imported = regeneratedSfx.sfxClips!.find((clip) => clip.id === importedId)!;
    const automatic = regeneratedSfx.sfxClips!.find(
      (clip) =>
        clip.origin === "automatic" &&
        clip.source.kind === "built-in" &&
        clip.source.key === "mouse_click"
    )!;
    expect(automatic).toBeDefined();
    const moveTo = async (id: string, from: number, target: number) => {
      const select = page.locator(`[data-sfx-select-id="${id}"]`);
      await select.focus();
      const frames = Math.round((target - from) * EXPORT_FPS);
      const key = frames < 0 ? "ArrowLeft" : "ArrowRight";
      for (let index = 0; index < Math.abs(frames); index += 1) await select.press(key);
    };

    await moveTo(imported.id, imported.timelineStart, 0.2);
    await page.getByRole("slider", { name: `Source in for ${imported.name}` }).fill("0.5");
    await page.getByRole("slider", { name: `Source out for ${imported.name}` }).fill("1.501");
    await page.getByRole("slider", { name: `Gain for ${imported.name}` }).fill("1");
    await page.getByRole("slider", { name: `Fade in for ${imported.name}` }).fill("0.2");
    await page.getByRole("slider", { name: `Fade out for ${imported.name}` }).fill("0.2");
    await page.getByRole("button", { name: `Duplicate ${imported.name}`, exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await readProjectSnapshot(page, projectId!);
        return snapshot.sfxClips?.filter(
          (clip) => clip.origin === "manual" && clip.source.kind === "imported"
        ).length === 2 ? snapshot : null;
      }, { timeout: 30_000, intervals: [100, 250, 500] })
      .not.toBeNull();
    const duplicatedSnapshot = await readProjectSnapshot(page, projectId);
    const mutedImport = duplicatedSnapshot.sfxClips!.find(
      (clip) => clip.origin === "manual" && clip.source.kind === "imported" && clip.id !== imported.id
    )!;
    await moveTo(mutedImport.id, mutedImport.timelineStart, 1.6);
    await page.getByRole("button", { name: `Mute ${mutedImport.name}`, exact: true }).click();

    await moveTo(automatic.id, automatic.timelineStart, 0.7);
    await page.getByRole("slider", { name: `Source in for ${automatic.name}` }).fill("0.56");
    await page.getByRole("slider", { name: `Source out for ${automatic.name}` }).fill("0.701");
    await page.getByRole("slider", { name: `Gain for ${automatic.name}` }).fill("2");
    await page.getByRole("slider", { name: `Fade in for ${automatic.name}` }).fill("0");
    await page.getByRole("slider", { name: `Fade out for ${automatic.name}` }).fill("0");
    for (const clip of regeneratedSfx.sfxClips!.filter(
      (candidate) => candidate.origin === "automatic" && candidate.id !== automatic.id && !candidate.muted
    )) {
      await page.locator(`[data-sfx-select-id="${clip.id}"]`).focus();
      await page.getByRole("button", { name: `Mute ${clip.name}`, exact: true }).click();
    }

    await expect
      .poll(async () => {
        const snapshot = await readProjectSnapshot(page, projectId!);
        const activeManual = snapshot.sfxClips?.find((clip) => clip.id === imported.id);
        const activeAutomatic = snapshot.sfxClips?.find((clip) => clip.id === automatic.id);
        const mutedManual = snapshot.sfxClips?.find((clip) => clip.id === mutedImport.id);
        const otherAutomatic = snapshot.sfxClips?.filter(
          (clip) => clip.origin === "automatic" && clip.id !== automatic.id
        ) ?? [];
        return Boolean(
          activeManual && Math.abs(activeManual.timelineStart - 0.2) < 0.02 &&
          activeManual.sourceStart === 0.5 && activeManual.sourceEnd === 1.501 &&
          activeManual.fadeInSec === 0.2 && activeManual.fadeOutSec === 0.2 &&
          activeAutomatic && Math.abs(activeAutomatic.timelineStart - 0.7) < 0.02 &&
          activeAutomatic.sourceStart === 0.56 && activeAutomatic.sourceEnd === 0.701 &&
          activeAutomatic.gain === 2 && !activeAutomatic.muted &&
          mutedManual?.muted && Math.abs(mutedManual.timelineStart - 1.6) < 0.02 &&
          otherAutomatic.every((clip) => clip.muted)
        );
      }, { timeout: 30_000, intervals: [100, 250, 500] })
      .toBe(true);
    const configuredSfx = await readProjectSnapshot(page, projectId);
    expect(configuredSfx.sfxTrack).toBeUndefined();
    expect(configuredSfx.sfxAssets).toHaveLength(1);
    expect(configuredSfx.sfxClips?.filter((clip) => !clip.muted)).toHaveLength(2);
    expect(configuredSfx.sfxClips?.some((clip) => clip.origin === "manual" && clip.source.kind === "imported"))
      .toBe(true);
    expect(configuredSfx.sfxClips?.some((clip) => clip.origin === "automatic" && !clip.muted))
      .toBe(true);

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

    const [controlAudio, musicControlAudio, layeredAudio, sfxDifference, sfxWindows] = await Promise.all([
      analyzeAudio(controlPath, 0.78),
      analyzeAudio(musicControlPath, 0.78),
      analyzeAudio(layeredPath, 0.78),
      analyzeAudioDifference(musicControlPath, layeredPath, 0.78),
      analyzeAudioDifferenceWindows(
        musicControlPath,
        layeredPath,
        [0.22, 0.52, 0.78, 1.17, 2]
      ),
    ]);
    console.log(
      "EXPORT_AUDIO_MEASUREMENTS",
      JSON.stringify({
        control: controlAudio,
        musicControl: musicControlAudio,
        layered: layeredAudio,
        sfxDifference,
        sfxWindows,
      })
    );
    expect(musicControlAudio.hz220).toBeGreaterThanOrEqual(controlAudio.hz220 * 4);
    const narrationParity = layeredAudio.hz440 / musicControlAudio.hz440;
    const musicParity = layeredAudio.hz220 / musicControlAudio.hz220;
    expect(narrationParity).toBeGreaterThan(0.95);
    expect(narrationParity).toBeLessThan(1.05);
    expect(musicParity).toBeGreaterThan(0.95);
    expect(musicParity).toBeLessThan(1.05);
    expect(sfxDifference.hz440).toBeLessThan(musicControlAudio.hz440 * 0.05);
    expect(sfxDifference.hz220).toBeLessThan(musicControlAudio.hz220 * 0.05);
    // Subtract an export with the same narration + continuous music. A nonzero
    // residual in the timed event window can only come from the added SFX layer.
    expect(sfxDifference.eventRms).toBeGreaterThan(0.01);
    expect(sfxDifference.fullRms).toBeGreaterThan(0.005);
    const [fadeIn, manualOnly, overlap, fadeOut, muted] = sfxWindows;
    expect(manualOnly.rms).toBeGreaterThan(fadeIn.rms * 2);
    expect(manualOnly.rms).toBeGreaterThan(fadeOut.rms * 2);
    expect(overlap.rms).toBeGreaterThan(manualOnly.rms * 1.2);
    expect(muted.rms).toBeLessThan(manualOnly.rms * 0.15);
    expect(manualOnly.hz880).toBeGreaterThan(manualOnly.hz660 * 5);
    expect(manualOnly.hz880).toBeGreaterThan(manualOnly.hz1100 * 5);
    expect(musicControlAudio.hz440 / controlAudio.hz440).toBeGreaterThan(0.95);
    expect(musicControlAudio.hz440 / controlAudio.hz440).toBeLessThan(1.05);
    await expect(page.getByRole("status", { name: "Export warning" })).toHaveCount(0);
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});

test("matches authored overlay effects in preview, 1080p, and 4K at pixel boundaries", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  const players: Page[] = [];
  try {
    const overlaySourceAudio = await analyzeAudio(
      path.join(GENERATED_FIXTURES, "overlay.mp4"),
      0.55
    );
    expect(overlaySourceAudio.hz220).toBeGreaterThan(0.1);
    expect(overlaySourceAudio.hz220).toBeGreaterThan(overlaySourceAudio.hz440 * 20);

    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
    });
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "split-screen-red.mp4"),
      path.join(GENERATED_FIXTURES, "split-face-blue-aac.mp4")
    );

    const baseSnapshot = await seedProjectSnapshot<ProjectSnapshot>(
      page,
      projectId,
      (snapshot) => {
        const source = snapshot.clips[0];
        const sourceStart = source.srcStart;
        snapshot.clips = [
          {
            ...source,
            id: `${source.id}-face-endpoint`,
            srcStart: sourceStart,
            srcEnd: sourceStart + 0.5,
            timelineStart: 0,
            timelineEnd: 0.5,
            splitRatio: 0,
            transitionIn: undefined,
          },
          {
            ...source,
            id: `${source.id}-screen-endpoint`,
            srcStart: sourceStart + 0.5,
            srcEnd: sourceStart + 1.1,
            timelineStart: 0.5,
            timelineEnd: 1.1,
            splitRatio: 1,
            transitionIn: undefined,
          },
        ];
        snapshot.duration = 1.1;
        snapshot.playhead = 0;
        snapshot.inPoint = null;
        snapshot.outPoint = null;
        const captionWords = [
          {
            text: "DETACHED",
            start: sourceStart,
            end: sourceStart + 1.1,
          },
        ];
        snapshot.words = captionWords;
        snapshot.captionsEnabled = true;
        snapshot.captionStyle = {
          ...snapshot.captionStyle!,
          fill: "#00FF00",
          activeFill: "#00FF00",
          strokeColor: "#003300",
          strokeWidthPct: 0.08,
          shadowColor: "",
          boxColor: "",
          glowColor: "",
          sizePct: 0.1,
          uppercase: true,
          anim: "none",
        };
        snapshot.captionBlocks = [
          {
            id: "task8-detached-caption",
            words: captionWords,
            start: sourceStart,
            end: sourceStart + 1.1,
            overrideStyle: { pinToSplit: false, positionYPct: 0.76 },
          },
        ];
        snapshot.overlays = [];
        snapshot.musicTrack = null;
        snapshot.sfxClips = [];
        snapshot.sfxAssets = [];
        return snapshot;
      }
    );
    expect(baseSnapshot.clips.map((clip) => clip.splitRatio)).toEqual([0, 1]);
    expect(baseSnapshot.captionBlocks).toEqual([
      expect.objectContaining({
        id: "task8-detached-caption",
        overrideStyle: { pinToSplit: false, positionYPct: 0.76 },
      }),
    ]);

    const controlPath = await saveExport(
      page,
      testInfo,
      "appearance-control-1080p.mp4"
    );
    await chooseFiles(page, "Add media (image / video)", [
      path.join(GENERATED_FIXTURES, "overlay.png"),
      path.join(GENERATED_FIXTURES, "overlay.mp4"),
    ]);
    const imported = await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/repurpose/projects/${projectId}`
          );
          if (!response.ok()) return null;
          const body = (await response.json()) as {
            project?: { snapshot?: ProjectSnapshot };
          };
          const overlays = body.project?.snapshot?.overlays;
          return overlays?.length === 2 ? overlays : null;
        },
        { timeout: 60_000, intervals: [250, 500, 1_000] }
      )
      .not.toBeNull();
    void imported;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/repurpose/projects/${projectId}`
          );
          const body = (await response.json()) as {
            project?: { snapshot?: ProjectSnapshot };
          };
          return body.project?.snapshot?.overlays?.find(
            (overlay) => overlay.kind === "video"
          )?.videoSource?.previewPath;
        },
        { timeout: 60_000, intervals: [250, 500, 1_000] }
      )
      .toContain("quality=proxy");
    const importedResponse = await page.request.get(
      `/api/repurpose/projects/${projectId}`
    );
    const importedBody = (await importedResponse.json()) as {
      project: { snapshot: ProjectSnapshot };
    };
    const importedImage = importedBody.project.snapshot.overlays?.find(
      (overlay) => overlay.kind === "image"
    );
    const importedVideo = importedBody.project.snapshot.overlays?.find(
      (overlay) => overlay.kind === "video"
    );
    expect(importedImage).toBeDefined();
    expect(importedVideo).toBeDefined();
    expect(importedVideo?.muted).toBe(true);
    expect(importedVideo?.videoSource?.previewPath).toBeTruthy();
    expect(importedVideo?.src).toContain(
      encodeURIComponent(importedVideo!.videoSource!.workingPath)
    );
    expect(importedVideo?.src).not.toContain(
      encodeURIComponent(importedVideo!.videoSource!.previewPath!)
    );
    const proxyResponse = await page.request.get(
      importedVideo!.videoSource!.previewPath!
    );
    expect(proxyResponse.ok()).toBe(true);
    const proxyPath = testInfo.outputPath("overlay-positive-control-proxy.mp4");
    await writeFile(proxyPath, await proxyResponse.body());
    const overlayProxyAudio = await analyzeAudio(proxyPath, 0.55);
    expect(overlayProxyAudio.hz220).toBeGreaterThan(0.1);
    expect(overlayProxyAudio.hz220).toBeGreaterThan(overlayProxyAudio.hz440 * 20);

    const seededSnapshot = await seedProjectSnapshot<ProjectSnapshot>(
      page,
      projectId,
      (snapshot) => {
        const faceSlide: Overlay = {
          ...importedImage!,
          id: "task8-face-slide",
          timelineStart: 0,
          timelineEnd: 0.5,
          transform: { x: 0.35, y: 0.5, scale: 0.35, rotation: 0 },
          band: "face",
          zIndex: 1,
          opacity: 1,
          entranceEffect: { type: "slide", durationSec: 0.2, direction: "left" },
          exitEffect: { type: "fade", durationSec: 0.2 },
          cornerRadius: 0.5,
        };
        const screenPop: Overlay = {
          ...importedVideo!,
          id: "task8-screen-pop",
          timelineStart: 0.5,
          timelineEnd: 1,
          srcStart: 0.5,
          transform: { x: 0.5, y: 0.5, scale: 0.32, rotation: -17 },
          band: "screen",
          zIndex: 2,
          opacity: 1,
          muted: true,
          entranceEffect: { type: "pop", durationSec: 0.2 },
          exitEffect: { type: "slide", durationSec: 0.2, direction: "right" },
          cornerRadius: 0.16,
        };
        const freeOversized: Overlay = {
          ...importedImage!,
          id: "task8-free-oversized",
          timelineStart: 0,
          timelineEnd: 1.1,
          transform: { x: 0.82, y: -0.03, scale: 1.1, rotation: 37 },
          band: "free",
          zIndex: 0,
          opacity: 1,
          entranceEffect: { type: "none", durationSec: 0.35 },
          exitEffect: { type: "none", durationSec: 0.35 },
          cornerRadius: 0.5,
        };
        snapshot.overlays = [freeOversized, faceSlide, screenPop];
        snapshot.playhead = 0;
        return snapshot;
      }
    );
    expect(seededSnapshot.overlays?.map((overlay) => overlay.band)).toEqual([
      "free",
      "face",
      "screen",
    ]);
    expect(JSON.stringify(seededSnapshot)).not.toMatch(/gesture|transient/i);
    const overlayPreviewVideo = page.locator(
      'video[data-overlay-id="task8-screen-pop"]'
    );
    await expect(overlayPreviewVideo).toHaveCount(1);
    await expect(overlayPreviewVideo).toHaveAttribute(
      "data-overlay-src",
      /quality=proxy/
    );
    expect(
      await overlayPreviewVideo.evaluate((video: HTMLVideoElement) => video.muted)
    ).toBe(true);

    const frameNumbers = [0, 3, 9, 12, 15, 18, 21, 27, 30];
    const previewFrames: PreviewParityFrame[] = [];
    for (const frame of frameNumbers) {
      previewFrames.push(
        await capturePreviewParityFrame(page, frame, EXPORT_FPS, frame < 15 ? 0 : 100)
      );
    }
    await page.getByLabel("Import sound effect").setInputFiles(
      path.join(GENERATED_FIXTURES, "editable-sfx.wav")
    );
    await expect
      .poll(async () => {
        const snapshot = await readProjectSnapshot(page, projectId!);
        return snapshot.sfxClips?.some(
          (clip) => clip.origin === "manual" && clip.source.kind === "imported"
        ) ? snapshot : null;
      }, { timeout: 30_000, intervals: [100, 250, 500] })
      .not.toBeNull();
    const visualSfxSnapshot = await readProjectSnapshot(page, projectId);
    expect(visualSfxSnapshot.sfxClips?.some((clip) => !clip.muted)).toBe(true);
    console.log("TASK9_SFX_ONLY_PIXEL_CONTROL", JSON.stringify({
      previewCapturedBeforeSfx: true,
      exportResolutions: ["1080p", "4K"],
    }));

    const detachedCaptionFrame = previewFrames.find(({ frame }) => frame === 9)!;
    await capturePreviewParityFrame(page, detachedCaptionFrame.frame, EXPORT_FPS, 0);
    const captionHandle = page.getByRole("slider", { name: "Move active caption" });
    await expect(captionHandle).toBeVisible();
    const persistedCaptionBox = await captionHandle.boundingBox();
    const previewBox = await page.locator("#preview-panel canvas").first().boundingBox();
    expect(persistedCaptionBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    await page.waitForTimeout(1_000);
    const beforeTransientExport = await readProjectSnapshot(page, projectId);
    expect(beforeTransientExport.captionBlocks).toEqual(seededSnapshot.captionBlocks);

    await page.evaluate(() => {
      const state = window as typeof window & { __task8PointerId?: number };
      delete state.__task8PointerId;
      window.addEventListener(
        "pointerdown",
        (event) => {
          state.__task8PointerId = event.pointerId;
        },
        { capture: true, once: true }
      );
    });
    const captionStart = {
      x: persistedCaptionBox!.x + persistedCaptionBox!.width / 2,
      y: persistedCaptionBox!.y + persistedCaptionBox!.height / 2,
    };
    await page.mouse.move(captionStart.x, captionStart.y);
    await page.mouse.down();
    await page.mouse.move(captionStart.x, previewBox!.y + 20, { steps: 8 });
    const transientCaptionBox = await captionHandle.boundingBox();
    expect(transientCaptionBox).not.toBeNull();
    expect(transientCaptionBox!.y).toBeLessThan(persistedCaptionBox!.y - 100);
    expect(await readProjectSnapshot(page, projectId)).toEqual(beforeTransientExport);

    const export1080Path = await saveExport(
      page,
      testInfo,
      "appearance-transient-1080p.mp4",
      { programmaticClick: true }
    );
    const afterTransientExport = await readProjectSnapshot(page, projectId);
    expect(afterTransientExport).toEqual(beforeTransientExport);
    expect((await captionHandle.boundingBox())?.y).toBeCloseTo(transientCaptionBox!.y, 1);
    console.log(
      "TASK8_CAPTION_TRANSIENT",
      JSON.stringify({
        persistedY: persistedCaptionBox!.y,
        transientY: transientCaptionBox!.y,
        snapshotUnchanged: true,
        exportedPosition: "persisted-detached",
      })
    );
    await page.evaluate(() => {
      const state = window as typeof window & { __task8PointerId?: number };
      if (state.__task8PointerId === undefined) {
        throw new Error("Caption pointer id was not captured");
      }
      window.dispatchEvent(
        new PointerEvent("pointercancel", {
          bubbles: true,
          pointerId: state.__task8PointerId,
        })
      );
      delete state.__task8PointerId;
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await captionHandle.boundingBox())?.y ?? Number.NaN)
      .toBeCloseTo(persistedCaptionBox!.y, 1);
    expect(await readProjectSnapshot(page, projectId)).toEqual(beforeTransientExport);

    await page.getByRole("button", { name: "4K", exact: true }).click();
    await expect(page.getByRole("button", { name: "4K", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const export4kPath = await saveExport(page, testInfo, "appearance-4k.mp4");

    await assertExportMetadata(controlPath, {
      width: 1080,
      height: 1920,
      duration: 1.1,
    });
    await assertExportMetadata(export1080Path, {
      width: 1080,
      height: 1920,
      duration: 1.1,
    });
    await assertExportMetadata(export4kPath, {
      width: 2160,
      height: 3840,
      duration: 1.1,
    });

    const opened1080 = await openExportedVideo(
      context,
      export1080Path,
      "task8-appearance-1080p"
    );
    const opened4k = await openExportedVideo(
      context,
      export4kPath,
      "task8-appearance-4k"
    );
    players.push(opened1080.player, opened4k.player);
    const metricsByResolution = new Map<string, PixelParity[]>();
    for (const [resolution, video] of [
      ["1080p", opened1080.video],
      ["4k", opened4k.video],
    ] as const) {
      const metrics: PixelParity[] = [];
      for (const preview of previewFrames) {
        const faceFrame = preview.frame < 15;
        const freeOnlyFrame = preview.frame === 0 || preview.frame === 15;
        metrics.push(
          await comparePreviewToExport(video, preview, EXPORT_FPS, {
            baseColor: faceFrame ? [36, 80, 164] : [229, 57, 53],
            region: freeOnlyFrame
              ? { left: 0.35, top: 0, right: 1, bottom: 0.35 }
              : faceFrame
                ? { left: 0, top: 0.32, right: 0.7, bottom: 0.68 }
                : { left: 0.18, top: 0.3, right: 0.9, bottom: 0.7 },
            threshold: freeOnlyFrame ? 30 : 35,
            ...(preview.frame === 9
              ? {
                  points: [
                    { x: 0.18, y: 0.445 },
                    { x: 0.35, y: 0.5 },
                  ],
                }
              : {}),
          })
        );
      }
      metricsByResolution.set(resolution, metrics);
      console.log(`TASK8_${resolution.toUpperCase()}_PIXELS`, JSON.stringify(metrics));
      for (const [index, metric] of metrics.entries()) {
        expect(metric.exportTime).toBeCloseTo(
          (previewFrames[index].frame + 0.5) / EXPORT_FPS,
          2
        );
        expect(metric.fullMae).toBeLessThan(12);
        expect(metric.fullLargeDiffRatio).toBeLessThan(0.02);
        expect(metric.captionBandMae).toBeLessThan(12);
        expect(metric.captionBandLargeDiffRatio).toBeLessThan(0.02);
      }
    }

    const visualWidth = (stats: VisualStats | undefined) =>
      stats?.left == null || stats.right == null ? 0 : stats.right - stats.left + 1;
    const visualHeight = (stats: VisualStats | undefined) =>
      stats?.top == null || stats.bottom == null ? 0 : stats.bottom - stats.top + 1;
    const colorDelta = (sample: number[] | undefined, base: number[]) =>
      sample ? Math.max(...base.map((value, index) => Math.abs(sample[index] - value))) : 0;
    for (const metrics of metricsByResolution.values()) {
      for (const surface of ["previewVisual", "exportVisual"] as const) {
        expect(metrics[0][surface]?.count ?? 0).toBeGreaterThan(2_000);
        expect(visualWidth(metrics[0][surface])).toBeGreaterThan(120);
        expect(visualHeight(metrics[0][surface])).toBeGreaterThan(60);
        expect(metrics[1][surface]?.count ?? 0).toBeGreaterThan(500);
        expect(metrics[1][surface]?.centerX ?? Infinity).toBeLessThan(
          (metrics[2][surface]?.centerX ?? 0) - 35
        );
        expect(metrics[1][surface]?.meanDelta ?? Infinity).toBeLessThan(
          metrics[2][surface]?.meanDelta ?? 0
        );
        expect(metrics[3][surface]?.meanDelta ?? Infinity).toBeLessThan(
          metrics[2][surface]?.meanDelta ?? 0
        );
        expect(metrics[4][surface]?.count ?? 0).toBeGreaterThan(2_000);
        expect(visualWidth(metrics[4][surface])).toBeGreaterThan(120);
        expect(visualHeight(metrics[4][surface])).toBeGreaterThan(60);
        expect(visualWidth(metrics[5][surface])).toBeGreaterThan(
          visualWidth(metrics[6][surface]) + 4
        );
        expect(metrics[7][surface]?.centerX ?? 0).toBeGreaterThan(
          (metrics[6][surface]?.centerX ?? Infinity) + 20
        );
        expect(metrics[8][surface]?.count ?? 0).toBeLessThan(100);
      }
      const settled = metrics[2];
      expect(colorDelta(settled.previewSamples?.[0], [36, 80, 164])).toBeLessThan(20);
      expect(colorDelta(settled.exportSamples?.[0], [36, 80, 164])).toBeLessThan(20);
      expect(colorDelta(settled.previewSamples?.[1], [36, 80, 164])).toBeGreaterThan(80);
      expect(colorDelta(settled.exportSamples?.[1], [36, 80, 164])).toBeGreaterThan(80);
    }

    for (const [resolution, video] of [
      ["1080p", opened1080.video],
      ["4k", opened4k.video],
    ] as const) {
      const counts = await countColorInRegions(
        video,
        detachedCaptionFrame,
        [0, 255, 0],
        [
          { left: 0.1, top: 0.66, right: 0.9, bottom: 0.86 },
          { left: 0.1, top: 0, right: 0.9, bottom: 0.18 },
        ]
      );
      console.log(`TASK8_${resolution.toUpperCase()}_DETACHED_CAPTION`, JSON.stringify(counts));
      expect(counts.preview[0]).toBeGreaterThan(400);
      expect(counts.export[0]).toBeGreaterThan(400);
      expect(counts.preview[1]).toBeLessThan(20);
      expect(counts.export[1]).toBeLessThan(20);
    }

    const [controlAudio, audio1080, audio4k] = await Promise.all([
      analyzeAudio(controlPath, 0.55),
      analyzeAudio(export1080Path, 0.55),
      analyzeAudio(export4kPath, 0.55),
    ]);
    console.log(
      "TASK8_OVERLAY_AUDIO",
      JSON.stringify({
        overlaySource: overlaySourceAudio,
        overlayProxy: overlayProxyAudio,
        control: controlAudio,
        export1080: audio1080,
        export4k: audio4k,
      })
    );
    for (const candidate of [audio1080, audio4k]) {
      expect(candidate.hz440 / controlAudio.hz440).toBeGreaterThan(0.9);
      expect(candidate.hz440 / controlAudio.hz440).toBeLessThan(1.1);
      expect(candidate.fullRms / controlAudio.fullRms).toBeGreaterThan(0.9);
      expect(candidate.fullRms / controlAudio.fullRms).toBeLessThan(1.1);
      expect(candidate.hz220).toBeLessThan(candidate.hz440 * 0.1);
      expect(candidate.hz220).toBeLessThan(overlaySourceAudio.hz220 * 0.01);
      expect(candidate.hz220).toBeLessThan(overlayProxyAudio.hz220 * 0.01);
    }

    const afterExportResponse = await page.request.get(
      `/api/repurpose/projects/${projectId}`
    );
    const afterExport = (await afterExportResponse.json()) as {
      project: { snapshot: ProjectSnapshot };
    };
    expect(afterExport.project.snapshot.overlays).toEqual(seededSnapshot.overlays);
    expect(JSON.stringify(afterExport.project.snapshot)).not.toMatch(/gesture|transient/i);
    browserErrors.assertEmpty();
  } finally {
    for (const player of players) await player.close().catch(() => undefined);
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
