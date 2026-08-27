import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeAudio, mediaDuration, probeMedia } from "./helpers/audio-analysis";
import {
  GENERATED_FIXTURES,
  cleanupProject,
  collectBrowserErrors,
  currentDurableProjectId,
} from "./helpers/project";

const ACTUAL_HEVC_PATH = process.env.REPURPOSE_ACTUAL_HEVC_PATH;
const REPORT_DIR = path.resolve(
  process.cwd(),
  ".gstack",
  "qa-reports",
  "repurpose-studio-stabilization-2026-08-21"
);
const SCREENSHOTS_DIR = path.join(REPORT_DIR, "screenshots");

type ImportEvent = { label: string; iso: string; elapsedMs: number };

type Snapshot = {
  clips?: Array<{
    id: string;
    srcStart: number;
    srcEnd: number;
    timelineStart: number;
    timelineEnd: number;
    kept: boolean;
  }>;
  overlays?: Array<{
    id: string;
    kind: string;
    videoSource?: VideoSource;
  }>;
  mediaAssets?: Array<{
    id: string;
    name: string;
    kind: string;
    videoSource?: VideoSource;
  }>;
  footageMeta?: {
    faceCamPath: string;
    screenPath: string;
    fps: number;
    faceCamSource?: VideoSource;
    screenSource?: VideoSource;
  };
  playhead?: number;
  inPoint?: number | null;
  outPoint?: number | null;
};

type VideoSource = {
  originalPath: string;
  workingPath: string;
  previewPath?: string;
  compatibilityStatus: "native" | "converted";
  inspection: {
    fingerprint: string;
    durationSec: number;
    video: { codec: string; width: number; height: number; fps: number };
    audio: null | { codec: string; channels: number; sampleRate: number };
  };
};

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function chooseFiles(
  page: Page,
  buttonName: string,
  files: string | string[]
): Promise<void> {
  let button = page.getByRole("button", { name: buttonName, exact: true });
  if (!(await button.isVisible())) {
    const reimport = page.getByText("Re-import footage", { exact: true });
    if (await reimport.isVisible()) await reimport.click();
    button = page.getByRole("button", { name: buttonName, exact: true });
  }
  const chooserPromise = page.waitForEvent("filechooser");
  await button.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

async function readSnapshot(page: Page, projectId: string): Promise<Snapshot> {
  const response = await page.request.get(`/api/repurpose/projects/${projectId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { project?: { snapshot?: Snapshot } };
  return body.project?.snapshot ?? {};
}

async function waitForSnapshot(
  page: Page,
  projectId: string,
  predicate: (snapshot: Snapshot) => boolean,
  timeout = 180_000
): Promise<Snapshot> {
  let latest: Snapshot = {};
  await expect
    .poll(
      async () => {
        latest = await readSnapshot(page, projectId);
        return predicate(latest);
      },
      { timeout, intervals: [250, 500, 1_000, 2_000] }
    )
    .toBe(true);
  return latest;
}

async function installImportRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __actualImportEvents?: ImportEvent[];
      __actualImportObserver?: MutationObserver;
      __actualImportStarted?: number;
    };
    state.__actualImportEvents = [];
    state.__actualImportStarted = performance.now();
    state.__actualImportObserver?.disconnect();
    const capture = () => {
      const labels = [
        "Copiando arquivo",
        "Inspecionando mídia",
        "Verificando compatibilidade no Chrome",
        "Convertendo HEVC para H.264",
        "Criando proxy de prévia",
        "Pronto",
      ];
      const text = document.body.innerText;
      for (const label of labels) {
        if (
          text.includes(label) &&
          !state.__actualImportEvents?.some((event) => event.label === label)
        ) {
          state.__actualImportEvents?.push({
            label,
            iso: new Date().toISOString(),
            elapsedMs: performance.now() - (state.__actualImportStarted ?? 0),
          });
        }
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    state.__actualImportObserver = observer;
    capture();
  });
}

async function importEvents(page: Page): Promise<ImportEvent[]> {
  return page.evaluate(() => {
    const state = window as typeof window & { __actualImportEvents?: ImportEvent[] };
    return state.__actualImportEvents ?? [];
  });
}

async function previewMediaState(page: Page): Promise<{
  videoTime: number;
  videoPaused: boolean;
  sourceUrl: string;
  canvasSignature: number;
}> {
  return page.locator("#preview-panel").evaluate((panel) => {
    const activeFace = Array.from(
      panel.querySelectorAll<HTMLVideoElement>('video[data-source-role="face"][data-slot-index]')
    ).find((video) => !video.muted);
    const source = panel.querySelector<HTMLCanvasElement>("canvas");
    if (!activeFace || !source) throw new Error("Active face video or preview canvas is unavailable");
    const sample = document.createElement("canvas");
    sample.width = 48;
    sample.height = 48;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(source, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let canvasSignature = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      canvasSignature ^= pixels[index];
      canvasSignature = Math.imul(canvasSignature, 16777619);
      canvasSignature ^= pixels[index + 1];
      canvasSignature = Math.imul(canvasSignature, 16777619);
      canvasSignature ^= pixels[index + 2];
      canvasSignature = Math.imul(canvasSignature, 16777619);
    }
    return {
      videoTime: activeFace.currentTime,
      videoPaused: activeFace.paused,
      sourceUrl: activeFace.currentSrc,
      canvasSignature: canvasSignature >>> 0,
    };
  });
}

async function playPause(page: Page): Promise<{
  before: number;
  after: number;
  videoBefore: number;
  videoAfter: number;
  sourceUrl: string;
  canvasChanged: boolean;
}> {
  const playhead = page.getByRole("slider", { name: "Playhead" });
  const before = Number(await playhead.getAttribute("aria-valuenow"));
  const mediaBefore = await previewMediaState(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  let mediaDuring = mediaBefore;
  await expect
    .poll(async () => {
      mediaDuring = await previewMediaState(page);
      return (
        Number(await playhead.getAttribute("aria-valuenow")) > before + 0.05 &&
        mediaDuring.videoTime > mediaBefore.videoTime + 0.05 &&
        !mediaDuring.videoPaused &&
        mediaDuring.canvasSignature !== mediaBefore.canvasSignature
      );
    }, {
      timeout: 10_000,
      intervals: [50, 100],
    })
    .toBe(true);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => (await previewMediaState(page)).videoPaused, {
      timeout: 5_000,
      intervals: [20, 50],
    })
    .toBe(true);
  const after = Number(await playhead.getAttribute("aria-valuenow"));
  await page.waitForTimeout(120);
  expect(
    Math.abs(Number(await playhead.getAttribute("aria-valuenow")) - after)
  ).toBeLessThanOrEqual(0.03);
  const mediaAfter = await previewMediaState(page);
  expect(mediaAfter.videoPaused).toBe(true);
  expect(mediaAfter.sourceUrl).toBe(mediaBefore.sourceUrl);
  return {
    before,
    after,
    videoBefore: mediaBefore.videoTime,
    videoAfter: mediaAfter.videoTime,
    sourceUrl: mediaAfter.sourceUrl,
    canvasChanged: mediaDuring.canvasSignature !== mediaBefore.canvasSignature,
  };
}

async function goToFrame(page: Page, frame: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let index = 0; index < frame; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
}

test("accepts the actual HEVC MOV through UI, proxy, reopen, and full-quality export", async ({
  page,
  context,
}) => {
  test.skip(
    !ACTUAL_HEVC_PATH,
    "Set REPURPOSE_ACTUAL_HEVC_PATH to an absolute HEVC MOV path for the opt-in actual-file acceptance."
  );
  test.skip(
    !existsSync(ACTUAL_HEVC_PATH!),
    `REPURPOSE_ACTUAL_HEVC_PATH does not exist: ${ACTUAL_HEVC_PATH}. The test only reads/uploads the source.`
  );
  test.setTimeout(1_200_000);

  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const sourcePath = path.resolve(ACTUAL_HEVC_PATH!);
  const sourceBefore = await stat(sourcePath);
  const sourceHashBefore = await sha256(sourcePath);
  const browserErrors = collectBrowserErrors(page);
  const transportCycles: Array<Awaited<ReturnType<typeof playPause>>> = [];
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    sourcePath,
    sourceBefore: {
      size: sourceBefore.size,
      mtimeMs: sourceBefore.mtimeMs,
      sha256: sourceHashBefore,
    },
  };
  let projectId: string | undefined;

  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
    });
    await page.setViewportSize({ width: 1_600, height: 1_000 });
    await page.goto("/repurpose-studio");
    await expect(page.locator(".animate-pulse")).toHaveCount(0, { timeout: 30_000 });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-before-import-hub.png"),
      fullPage: true,
    });
    browserErrors.assertEmpty();

    await page.getByRole("button", { name: "New Project", exact: true }).first().click();
    await expect(page).toHaveURL(/\/repurpose-studio\/new-/);
    await chooseFiles(
      page,
      "Load raw transcript (.srt / .json)",
      path.join(GENERATED_FIXTURES, "raw.srt")
    );
    await expect(page.getByText("Transcript", { exact: true })).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).pathname.split("/").pop() ?? "", {
        timeout: 30_000,
      })
      .not.toMatch(/^new-/);
    projectId = new URL(page.url()).pathname.split("/").pop()!;
    await chooseFiles(
      page,
      "Load final transcript (.srt)",
      path.join(GENERATED_FIXTURES, "raw.srt")
    );

    await installImportRecorder(page);
    const conversionWallStart = Date.now();
    await chooseFiles(page, "Import", sourcePath);
    const conversionIndicator = page
      .getByRole("progressbar", { name: "Convertendo HEVC para H.264" })
      .first();
    await expect
      .poll(
        async () =>
          (await importEvents(page)).some(
            (event) => event.label === "Convertendo HEVC para H.264"
          ),
        { timeout: 180_000, intervals: [50, 100, 250] }
      )
      .toBe(true);
    if (await conversionIndicator.isVisible()) {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, "02-actual-hevc-converting.png"),
        fullPage: true,
      });
    }
    await expect(page.getByText(path.basename(sourcePath), { exact: true })).toBeVisible({
      timeout: 900_000,
    });
    const conversionWallEnd = Date.now();
    evidence.importEvents = await importEvents(page);
    evidence.actualFilesImportWallMs = conversionWallEnd - conversionWallStart;
    await expect(page.getByText(/decode error|erro.*decod|não foi possível.*decod/i)).toHaveCount(0);
    browserErrors.assertEmpty();

    const actualAssetRow = page
      .locator("li")
      .filter({ hasText: path.basename(sourcePath) })
      .first();
    await actualAssetRow.getByRole("button").first().click();
    await expect(page.locator("video[data-overlay-id]")).toHaveCount(1, {
      timeout: 60_000,
    });

    await chooseFiles(page, "Screen", path.join(GENERATED_FIXTURES, "h264-aac.mp4"));
    await waitForSnapshot(
      page,
      projectId,
      (snapshot) => Boolean(snapshot.footageMeta?.screenSource),
      900_000
    );
    await chooseFiles(page, "Face", sourcePath);
    let snapshot = await waitForSnapshot(
      page,
      projectId,
      (candidate) =>
        Boolean(candidate.footageMeta?.faceCamSource) &&
        Boolean(candidate.footageMeta?.screenSource),
      900_000
    );
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 120_000,
    });

    snapshot = await waitForSnapshot(
      page,
      projectId,
      (candidate) => {
        const actualAsset = candidate.mediaAssets?.find(
          (asset) => asset.name === path.basename(sourcePath)
        );
        return Boolean(
          actualAsset?.videoSource?.previewPath &&
            candidate.footageMeta?.faceCamSource?.previewPath &&
            candidate.footageMeta?.screenSource?.previewPath
        );
      },
      900_000
    );
    await expect(page.getByText(/^Preparing fast preview /)).toHaveCount(0, {
      timeout: 120_000,
    });

    const actualAsset = snapshot.mediaAssets?.find(
      (asset) => asset.name === path.basename(sourcePath)
    );
    const faceSource = snapshot.footageMeta?.faceCamSource;
    const screenSource = snapshot.footageMeta?.screenSource;
    expect(actualAsset?.videoSource).toBeDefined();
    expect(faceSource).toBeDefined();
    expect(screenSource).toBeDefined();
    expect(faceSource!.compatibilityStatus).toBe("converted");
    expect(screenSource!.compatibilityStatus).toBe("native");
    expect(actualAsset!.videoSource!.originalPath).toBe(faceSource!.originalPath);
    expect(actualAsset!.videoSource!.workingPath).toBe(faceSource!.workingPath);
    expect(faceSource!.workingPath).not.toBe(faceSource!.originalPath);
    expect(faceSource!.workingPath).toMatch(/compat-v1\.mp4$/);
    expect(screenSource!.workingPath).toBe(screenSource!.originalPath);

    const pausedSourceUrls = await page
      .locator('video[data-source-role][data-slot-index="0"]')
      .evaluateAll((videos) => videos.map((video) => (video as HTMLVideoElement).currentSrc));
    expect(pausedSourceUrls).toHaveLength(2);
    expect(pausedSourceUrls.every((url) => url.includes("quality=proxy"))).toBe(true);

    const proxyResponse = await page.request.get(faceSource!.previewPath!);
    expect(proxyResponse.ok()).toBe(true);
    const proxyArtifactPath = path.join(REPORT_DIR, "actual-hevc-preview-proxy.mp4");
    await writeFile(proxyArtifactPath, await proxyResponse.body());
    const [workingProbe, proxyProbe] = await Promise.all([
      probeMedia(faceSource!.workingPath),
      probeMedia(proxyArtifactPath),
    ]);
    evidence.contentAddressedSources = {
      asset: actualAsset!.videoSource,
      face: faceSource,
      screen: screenSource,
    };
    evidence.pausedSourceUrls = pausedSourceUrls;
    evidence.workingProbe = workingProbe;
    evidence.proxyProbe = proxyProbe;
    evidence.proxyArtifactPath = proxyArtifactPath;
    const workingVideo = workingProbe.streams.find((stream) => stream.codec_type === "video");
    const proxyVideo = proxyProbe.streams.find((stream) => stream.codec_type === "video");
    expect(workingVideo).toMatchObject({ codec_name: "h264", width: 3840, height: 2160 });
    expect(proxyVideo?.codec_name).toBe("h264");
    expect(Math.min(proxyVideo?.width ?? 0, proxyVideo?.height ?? 0)).toBe(540);
    expect((proxyVideo?.width ?? 0) * (proxyVideo?.height ?? 0)).toBeLessThan(
      (workingVideo?.width ?? 0) * (workingVideo?.height ?? 0)
    );
    const previewBox = await page.locator("#preview-panel canvas").first().boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.width / previewBox!.height).toBeCloseTo(9 / 16, 2);
    evidence.previewCanvasCss = previewBox;
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-actual-hevc-ready-proxy.png"),
      fullPage: true,
    });
    browserErrors.assertEmpty();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      transportCycles.push(await playPause(page));
      browserErrors.assertEmpty();
    }
    expect(new Set(transportCycles.map((cycle) => cycle.sourceUrl)).size).toBe(1);
    evidence.transportCycles = transportCycles;

    await page.keyboard.press("Home");
    const playhead = page.getByRole("slider", { name: "Playhead" });
    await expect(playhead).toHaveAttribute("aria-valuenow", "0");
    const startValue = Number(await playhead.getAttribute("aria-valuenow"));
    await page.getByRole("button", { name: "Set in point" }).click();
    await goToFrame(page, 90);
    const middleValue = Number(await playhead.getAttribute("aria-valuenow"));
    expect(middleValue).toBeGreaterThan(1.45);
    expect(middleValue).toBeLessThan(1.55);
    await page.keyboard.press("End");
    const endValue = Number(await playhead.getAttribute("aria-valuenow"));
    expect(endValue).toBeGreaterThan(2.5);
    await page.getByRole("button", { name: "Set out point" }).click();
    await expect(page.getByRole("button", { name: "Clear in/out region" })).toBeVisible();
    evidence.seeks = { startValue, middleValue, endValue };
    browserErrors.assertEmpty();

    snapshot = await readSnapshot(page, projectId);
    expect(snapshot.overlays?.some((overlay) => overlay.kind === "video")).toBe(true);
    evidence.layeredSnapshot = snapshot;
    browserErrors.assertEmpty();

    const previewFps = snapshot.footageMeta?.fps ?? 60;
    const previewFrames = [
      { frame: 30, timestamp: 30 / previewFps, name: "07-preview-0.5s.png" },
      { frame: 90, timestamp: 90 / previewFps, name: "08-preview-1.5s.png" },
      { frame: 150, timestamp: 150 / previewFps, name: "09-preview-2.5s.png" },
    ];
    for (const frame of previewFrames) {
      await goToFrame(page, frame.frame);
      await page.locator("#preview-panel canvas").first().screenshot({
        path: path.join(SCREENSHOTS_DIR, frame.name),
        animations: "disabled",
      });
    }
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-layered-preview.png"),
      fullPage: true,
    });

    await waitForSnapshot(
      page,
      projectId,
      (candidate) => Math.abs((candidate.playhead ?? -1) - 2.5) < 0.05
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 120_000,
    });
    await page.getByRole("button", { name: "Back to all projects" }).click();
    await expect(page).toHaveURL(/\/repurpose-studio$/);
    await page.locator(`a[href="/repurpose-studio/${projectId}"]`).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
      timeout: 120_000,
    });
    await playPause(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-reopened-actual-project.png"),
      fullPage: true,
    });
    snapshot = await readSnapshot(page, projectId);
    expect(snapshot.footageMeta?.faceCamSource?.workingPath).toBe(faceSource!.workingPath);
    expect(snapshot.footageMeta?.faceCamSource?.previewPath).toBe(faceSource!.previewPath);
    evidence.reopenedSnapshot = snapshot;
    browserErrors.assertEmpty();

    const exportRequests: string[] = [];
    const recordExportRequest = (request: { url(): string }) => {
      if (request.url().includes("/api/repurpose/video?")) {
        exportRequests.push(request.url());
      }
    };
    page.on("request", recordExportRequest);
    const downloadPromise = page.waitForEvent("download", { timeout: 600_000 });
    const exportFailurePromise = page
      .getByRole("alert")
      .filter({ hasText: "Export failed" })
      .waitFor({ state: "visible", timeout: 600_000 })
      .then(async () => {
        throw new Error(
          (await page.getByRole("alert").filter({ hasText: "Export failed" }).textContent()) ??
            "Export failed"
        );
      });
    await page.getByRole("button", { name: "Export MP4", exact: true }).click();
    const download = await Promise.race([downloadPromise, exportFailurePromise]);
    const exportPath = path.join(REPORT_DIR, "actual-hevc-layered-1080p.mp4");
    await download.saveAs(exportPath);
    await expect(page.getByRole("button", { name: "Export MP4", exact: true })).toBeEnabled({
      timeout: 180_000,
    });
    page.off("request", recordExportRequest);
    await expect(page.getByRole("alert").filter({ hasText: "Export failed" })).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Export warning" })).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-export-complete.png"),
      fullPage: true,
    });

    const exportRequestDetails = exportRequests.map((rawUrl) => {
      const url = new URL(rawUrl);
      return {
        path: url.searchParams.get("path"),
        quality: url.searchParams.get("quality"),
      };
    });
    const expectedAuthoritativePaths = [
      screenSource!.workingPath,
      faceSource!.workingPath,
      actualAsset!.videoSource!.workingPath,
    ].filter((sourcePath, index, paths) => paths.indexOf(sourcePath) === index);
    expect(exportRequestDetails.length).toBeGreaterThan(0);
    expect(exportRequestDetails.every((request) => request.quality === null)).toBe(true);
    expect(
      [...new Set(exportRequestDetails.map((request) => request.path))].sort()
    ).toEqual([...expectedAuthoritativePaths].sort());

    const exportProbe = await probeMedia(exportPath);
    const exportVideo = exportProbe.streams.find((stream) => stream.codec_type === "video");
    const exportAudio = exportProbe.streams.filter((stream) => stream.codec_type === "audio");
    expect(exportVideo).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(exportAudio.length).toBeGreaterThanOrEqual(1);
    expect(mediaDuration(exportProbe)).toBeGreaterThan(2.4);
    expect(mediaDuration(exportProbe)).toBeLessThanOrEqual(3.2);
    const exportAudioSignal = await analyzeAudio(exportPath, 1.5);
    expect(exportAudioSignal.fullRms).toBeGreaterThan(0.001);

    const player = await context.newPage();
    await player.setViewportSize({ width: 600, height: 1_020 });
    await player.goto(pathToFileURL(exportPath).href);
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
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    });
    expect(decoded.width).toBe(1080);
    expect(decoded.height).toBe(1920);
    for (const frame of previewFrames) {
      await exportedVideo.evaluate(async (video: HTMLVideoElement, timestamp: number) => {
        video.currentTime = timestamp;
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(video.error), { once: true });
        });
        video.pause();
      }, frame.timestamp);
      await exportedVideo.screenshot({
        path: path.join(SCREENSHOTS_DIR, `export-${frame.timestamp.toFixed(1)}s.png`),
        animations: "disabled",
      });
    }
    await player.screenshot({
      path: path.join(SCREENSHOTS_DIR, "10-export-opened-in-chrome.png"),
      fullPage: true,
    });
    await player.close();

    snapshot = await readSnapshot(page, projectId);
    const fps = snapshot.footageMeta?.fps ?? 60;
    const originalKeptCount = snapshot.clips?.filter((clip) => clip.kept).length ?? 0;
    await goToFrame(page, Math.round(2 * fps));
    await page.getByRole("button", { name: "Split clip at playhead", exact: true }).click();
    await waitForSnapshot(
      page,
      projectId,
      (candidate) =>
        (candidate.clips?.filter((clip) => clip.kept).length ?? 0) === originalKeptCount + 1
    );
    await goToFrame(page, Math.round(fps));
    await page.getByRole("button", { name: "Split clip at playhead", exact: true }).click();
    snapshot = await waitForSnapshot(
      page,
      projectId,
      (candidate) =>
        (candidate.clips?.filter((clip) => clip.kept).length ?? 0) === originalKeptCount + 2
    );
    const middleClip = [...(snapshot.clips ?? [])]
      .filter((clip) => clip.kept)
      .sort((left, right) => left.srcStart - right.srcStart)[1];
    expect(middleClip).toBeDefined();
    await page
      .locator(`[data-clip-id="${middleClip.id}"]`)
      .getByTitle("Delete clip")
      .click();
    snapshot = await waitForSnapshot(
      page,
      projectId,
      (candidate) => candidate.clips?.find((clip) => clip.id === middleClip.id)?.kept === false
    );
    const keptClips = [...(snapshot.clips ?? [])]
      .filter((clip) => clip.kept)
      .sort((left, right) => left.timelineStart - right.timelineStart);
    expect(keptClips).toHaveLength(2);
    const [outgoing, incoming] = keptClips;
    expect(outgoing.timelineEnd).toBeCloseTo(incoming.timelineStart, 6);
    expect(incoming.srcStart - outgoing.srcEnd).toBeGreaterThan(0.5);
    const boundaryFrame = Math.round(incoming.timelineStart * fps);
    await goToFrame(page, boundaryFrame - 1);
    const beforeBoundaryTime = (boundaryFrame - 1) / fps;
    const expectedOutgoingTime =
      outgoing.srcStart + (beforeBoundaryTime - outgoing.timelineStart);
    await expect
      .poll(async () => Math.abs((await previewMediaState(page)).videoTime - expectedOutgoingTime))
      .toBeLessThanOrEqual(Math.max(2 / fps, 0.04));
    await goToFrame(page, boundaryFrame);
    await expect
      .poll(async () => Math.abs((await previewMediaState(page)).videoTime - incoming.srcStart))
      .toBeLessThanOrEqual(Math.max(2 / fps, 0.04));
    evidence.boundaryMapping = {
      fps,
      boundaryFrame,
      boundaryTime: incoming.timelineStart,
      sourceDiscontinuitySec: incoming.srcStart - outgoing.srcEnd,
      outgoing,
      incoming,
    };

    evidence.export = {
      path: exportPath,
      probe: exportProbe,
      decodedInChrome: decoded,
      audioSignal: { fullRms: exportAudioSignal.fullRms },
      expectedAuthoritativePaths,
      requests: exportRequestDetails,
    };
    browserErrors.assertEmpty();
  } finally {
    let cleanupError: string | undefined;
    try {
      projectId ??= currentDurableProjectId(page);
      if (projectId && !page.isClosed()) await cleanupProject(page, projectId);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      expect.soft(cleanupError, "acceptance project cleanup").toBeUndefined();
    }
    if (cleanupError) evidence.cleanupError = cleanupError;
    try {
      const sourceAfter = await stat(sourcePath);
      const sourceHashAfter = await sha256(sourcePath);
      evidence.sourceAfter = {
        size: sourceAfter.size,
        mtimeMs: sourceAfter.mtimeMs,
        sha256: sourceHashAfter,
      };
      expect.soft(sourceAfter.size, "protected source size").toBe(sourceBefore.size);
      expect.soft(sourceAfter.mtimeMs, "protected source mtime").toBe(sourceBefore.mtimeMs);
      expect.soft(sourceHashAfter, "protected source SHA-256").toBe(sourceHashBefore);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.sourceIntegrityError = message;
      expect.soft(message, "protected source remains readable").toBeUndefined();
    }
    evidence.browserErrors = {
      consoleErrors: browserErrors.consoleErrors,
      pageErrors: browserErrors.pageErrors,
      httpErrors: browserErrors.httpErrors,
      requestFailures: browserErrors.requestFailures,
    };
    evidence.completedAt = new Date().toISOString();
    await writeFile(
      path.join(REPORT_DIR, "actual-hevc-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8"
    );
  }
});
