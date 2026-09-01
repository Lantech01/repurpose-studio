import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeMedia } from "./helpers/audio-analysis";
import {
  GENERATED_FIXTURES,
  cleanupProject,
  collectBrowserErrors,
  createProjectWithFootage,
  currentDurableProjectId,
} from "./helpers/project";

test.setTimeout(300_000);

type BandSamples = { top: number[]; bottom: number[] };
type FixtureColor = "red" | "blue";

function matchesFixtureColor(sample: number[], color: FixtureColor): boolean {
  const [red, green, blue, alpha = 255] = sample;
  return color === "red"
    ? alpha > 240 && red > 170 && red - green > 80 && red - blue > 80
    : alpha > 240 && blue > 110 && blue - red > 70 && blue - green > 45;
}

function expectFixtureBands(samples: BandSamples, color: FixtureColor): void {
  expect(
    matchesFixtureColor(samples.top, color),
    `${color} top sample: ${samples.top.join(",")}`
  ).toBe(true);
  expect(
    matchesFixtureColor(samples.bottom, color),
    `${color} bottom sample: ${samples.bottom.join(",")}`
  ).toBe(true);
}

async function sampleCanvasBands(canvas: Locator): Promise<BandSamples> {
  return canvas.evaluate((source: HTMLCanvasElement) => {
    const context = source.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Preview 2D canvas is unavailable");
    const averageAt = (yRatio: number): number[] => {
      const size = Math.max(1, Math.round(Math.min(source.width, source.height) * 0.01));
      const x = Math.max(0, Math.round(source.width / 2 - size / 2));
      const y = Math.max(0, Math.round(source.height * yRatio - size / 2));
      const pixels = context.getImageData(x, y, size, size).data;
      const sums = [0, 0, 0, 0];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 4; channel += 1) {
          sums[channel] += pixels[offset + channel];
        }
      }
      const count = pixels.length / 4;
      return sums.map((sum) => Math.round(sum / count));
    };
    return { top: averageAt(0.25), bottom: averageAt(0.75) };
  });
}

async function sampleThumbnailBands(image: Locator): Promise<BandSamples> {
  return image.evaluate((source: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = source.naturalWidth;
    canvas.height = source.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Thumbnail 2D canvas is unavailable");
    context.drawImage(source, 0, 0);
    const averageAt = (yRatio: number): number[] => {
      const size = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.04));
      const x = Math.max(0, Math.round(canvas.width / 2 - size / 2));
      const y = Math.max(0, Math.round(canvas.height * yRatio - size / 2));
      const pixels = context.getImageData(x, y, size, size).data;
      const sums = [0, 0, 0, 0];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 4; channel += 1) {
          sums[channel] += pixels[offset + channel];
        }
      }
      const count = pixels.length / 4;
      return sums.map((sum) => Math.round(sum / count));
    };
    return { top: averageAt(0.25), bottom: averageAt(0.75) };
  });
}

async function saveEndpointExport(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath(name);
  await download.saveAs(outputPath);
  await expect(page.getByRole("button", { name: "Export MP4", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByRole("alert").filter({ hasText: "Export failed" })).toHaveCount(0);
  return outputPath;
}

async function sampleExportBands(
  context: BrowserContext,
  filePath: string,
  routeName: string
): Promise<BandSamples> {
  const probe = await probeMedia(filePath);
  expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
    width: 1080,
    height: 1920,
  });
  const bytes = await readFile(filePath);
  const routeUrl = `**/${routeName}`;
  await context.route(routeUrl, async (route) => {
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
  try {
    await player.goto("/repurpose-studio");
    await player.setContent(`<video src="/${routeName}" preload="auto" playsinline></video>`);
    return await player.locator("video").evaluate(async (video: HTMLVideoElement) => {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadedmetadata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(video.error), { once: true });
        });
      }
      video.currentTime = Math.min(0.5, Math.max(0, video.duration / 2));
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(video.error), { once: true });
      });
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const drawing = canvas.getContext("2d", { willReadFrequently: true });
      if (!drawing) throw new Error("Export 2D canvas is unavailable");
      drawing.drawImage(video, 0, 0);
      const averageAt = (yRatio: number): number[] => {
        const size = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.01));
        const x = Math.max(0, Math.round(canvas.width / 2 - size / 2));
        const y = Math.max(0, Math.round(canvas.height * yRatio - size / 2));
        const pixels = drawing.getImageData(x, y, size, size).data;
        const sums = [0, 0, 0, 0];
        for (let offset = 0; offset < pixels.length; offset += 4) {
          for (let channel = 0; channel < 4; channel += 1) {
            sums[channel] += pixels[offset + channel];
          }
        }
        const count = pixels.length / 4;
        return sums.map((sum) => Math.round(sum / count));
      };
      return { top: averageAt(0.25), bottom: averageAt(0.75) };
    });
  } finally {
    await player.close();
    await context.unroute(routeUrl);
  }
}

async function persistedSplit(page: Page, projectId: string): Promise<number | undefined> {
  const response = await page.request.get(`/api/repurpose/projects/${projectId}`);
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    project?: { snapshot?: { clips?: Array<{ kept?: boolean; splitRatio?: number }> } };
  };
  return body.project?.snapshot?.clips?.find((clip) => clip.kept)?.splitRatio;
}

async function expectSplit(separator: Locator, expectedPercent: number): Promise<void> {
  await expect
    .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
    .toBeCloseTo(expectedPercent, 5);
}

function effectivePercent(ratio: number): number {
  return (Math.round(1920 * ratio) / 1920) * 100;
}

async function dragSplit(separator: Locator, ratio: number): Promise<void> {
  const handle = await separator.boundingBox();
  const preview = await separator.locator("..").boundingBox();
  expect(handle).not.toBeNull();
  expect(preview).not.toBeNull();
  await separator.page().mouse.move(
    handle!.x + handle!.width / 2,
    handle!.y + handle!.height / 2
  );
  await separator.page().mouse.down();
  await separator.page().mouse.move(
    preview!.x + preview!.width / 2,
    preview!.y + preview!.height * ratio,
    { steps: 8 }
  );
  await separator.page().mouse.up();
}

test("persists and restores the full Face/Screen split range", async (
  { page, context },
  testInfo
) => {
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "split-screen-red.mp4"),
      path.join(GENERATED_FIXTURES, "split-face-blue-aac.mp4")
    );
    const separator = page.getByRole("separator", {
      name: "Adjust screen and face split",
    });
    await expect(separator).toBeVisible();
    const captionsToggle = page.getByTitle("Disable captions");
    if (await captionsToggle.isVisible()) await captionsToggle.click();
    const previewCanvas = page.locator("#preview-panel canvas").first();

    await dragSplit(separator, 0);
    await expectSplit(separator, 0);
    await expect
      .poll(async () => {
        const samples = await sampleCanvasBands(previewCanvas);
        return [samples.top, samples.bottom].every((sample) =>
          matchesFixtureColor(sample, "blue")
        );
      })
      .toBe(true);
    expectFixtureBands(await sampleCanvasBands(previewCanvas), "blue");
    const faceFullExport = await saveEndpointExport(page, testInfo, "face-full.mp4");
    expectFixtureBands(
      await sampleExportBands(context, faceFullExport, "__e2e-face-full.mp4"),
      "blue"
    );
    await expect
      .poll(() => persistedSplit(page, projectId!), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(0);

    await page.getByRole("button", { name: "Back to all projects" }).click();
    const faceFullLink = page.locator(`a[href="/repurpose-studio/${projectId}"]`);
    const faceFullThumbnail = faceFullLink.locator('img[src^="/api/repurpose/thumb"]');
    await expect(faceFullThumbnail).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => faceFullThumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expectFixtureBands(await sampleThumbnailBands(faceFullThumbnail), "blue");
    await faceFullLink.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    const restoredSeparator = page.getByRole("separator", {
      name: "Adjust screen and face split",
    });
    await expectSplit(restoredSeparator, 0);

    await dragSplit(restoredSeparator, 0.5);
    await expectSplit(restoredSeparator, 50);
    await dragSplit(restoredSeparator, 1);
    await expectSplit(restoredSeparator, 100);
    await expect
      .poll(async () => {
        const samples = await sampleCanvasBands(previewCanvas);
        return [samples.top, samples.bottom].every((sample) =>
          matchesFixtureColor(sample, "red")
        );
      })
      .toBe(true);
    expectFixtureBands(await sampleCanvasBands(previewCanvas), "red");
    const screenFullExport = await saveEndpointExport(page, testInfo, "screen-full.mp4");
    expectFixtureBands(
      await sampleExportBands(context, screenFullExport, "__e2e-screen-full.mp4"),
      "red"
    );

    await restoredSeparator.focus();
    await restoredSeparator.press("Home");
    await expectSplit(restoredSeparator, 0);
    await restoredSeparator.press("ArrowDown");
    await expectSplit(restoredSeparator, effectivePercent(0.01));
    await restoredSeparator.press("ArrowRight");
    await expectSplit(restoredSeparator, effectivePercent(0.02));
    await restoredSeparator.press("ArrowUp");
    await expectSplit(restoredSeparator, effectivePercent(0.01));
    await restoredSeparator.press("ArrowLeft");
    await expectSplit(restoredSeparator, 0);
    await restoredSeparator.press("End");
    await expectSplit(restoredSeparator, 100);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expectSplit(restoredSeparator, 0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expectSplit(restoredSeparator, 100);

    await expect
      .poll(() => persistedSplit(page, projectId!), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1);

    await page.reload();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await expectSplit(
      page.getByRole("separator", { name: "Adjust screen and face split" }),
      100
    );
    expect(await persistedSplit(page, projectId)).toBe(1);

    await page.getByRole("button", { name: "Back to all projects" }).click();
    await expect(page).toHaveURL(/\/repurpose-studio$/);
    const projectLink = page.locator(`a[href="/repurpose-studio/${projectId}"]`);
    await expect(projectLink).toBeVisible();
    const thumbnail = projectLink.locator('img[src^="/api/repurpose/thumb"]');
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expectFixtureBands(await sampleThumbnailBands(thumbnail), "red");
    expect(await persistedSplit(page, projectId)).toBe(1);

    await projectLink.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await expectSplit(
      page.getByRole("separator", { name: "Adjust screen and face split" }),
      100
    );
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
