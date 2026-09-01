import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

import {
  GENERATED_FIXTURES,
  cleanupProject,
  collectBrowserErrors,
  createProjectWithFootage,
  currentDurableProjectId,
  observedImportPhases,
  reloadAndReopenProject,
  verifyPlayPauseAndSeek,
} from "./helpers/project";

async function verifyResponsivePreview(page: Page): Promise<void> {
  const originalViewport = page.viewportSize();
  for (const viewport of [
    { width: 1_600, height: 1_000 },
    { width: 1_280, height: 600 },
    { width: 768, height: 1_024 },
  ]) {
    await page.setViewportSize(viewport);
    const panel = page.locator("#preview-panel");
    const available = panel.locator(":scope > div").first();
    const frame = available.locator(":scope > div").first();
    const canvas = panel.locator("canvas").first();
    await expect
      .poll(async () => {
        const [availableBox, frameBox, canvasBox] = await Promise.all([
          available.boundingBox(),
          frame.boundingBox(),
          canvas.boundingBox(),
        ]);
        if (!availableBox || !frameBox || !canvasBox) return false;
        const expectedWidth = Math.min(340, availableBox.width, availableBox.height * 9 / 16);
        return (
          Math.abs(canvasBox.width - expectedWidth) <= 1 &&
          Math.abs(canvasBox.height - expectedWidth * 16 / 9) <= 1 &&
          Math.abs(canvasBox.width - frameBox.width) <= 1 &&
          Math.abs(canvasBox.height - frameBox.height) <= 1
        );
      })
      .toBe(true);
    const [availableBox, canvasBox, timelineBox] = await Promise.all([
      available.boundingBox(),
      canvas.boundingBox(),
      page.locator("#timeline-panel").boundingBox(),
    ]);
    expect(availableBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(timelineBox).not.toBeNull();
    expect(canvasBox!.width / canvasBox!.height).toBeCloseTo(9 / 16, 3);
    expect(canvasBox!.x).toBeGreaterThanOrEqual(availableBox!.x - 1);
    expect(canvasBox!.y).toBeGreaterThanOrEqual(availableBox!.y - 1);
    expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(
      availableBox!.x + availableBox!.width + 1
    );
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(
      availableBox!.y + availableBox!.height + 1
    );
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(timelineBox!.y + 1);
    await expect(canvas).toBeInViewport({ ratio: 0.99 });
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
}

test("HEVC project converts once and reopens with playable working masters", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "hevc-aac.mov")
    );
    expect(await observedImportPhases(page)).toContain(
      "Convertendo HEVC para H.264"
    );
    expect(browserErrors.pageErrors, "page errors after HEVC import").toEqual([]);
    await verifyResponsivePreview(page);
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot("hevc-ready.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });

    await verifyPlayPauseAndSeek(page);
    expect(browserErrors.pageErrors, "page errors after HEVC transport").toEqual([]);
    await reloadAndReopenProject(page, projectId);
    expect(browserErrors.pageErrors, "page errors after HEVC reopen").toEqual([]);
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot("hevc-reopened.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });

    const response = await page.request.get(`/api/repurpose/projects/${projectId}`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      project: {
        snapshot: {
          footageMeta: {
            faceCamPath: string;
            screenPath: string;
            faceCamSource: { originalPath: string; workingPath: string };
            screenSource: { originalPath: string; workingPath: string };
          };
        };
      };
    };
    const meta = body.project.snapshot.footageMeta;
    for (const [url, source] of [
      [meta.faceCamPath, meta.faceCamSource],
      [meta.screenPath, meta.screenSource],
    ] as const) {
      expect(source.workingPath).not.toBe(source.originalPath);
      expect(source.workingPath).toMatch(/compat-v1\.mp4$/);
      expect(url).toContain(encodeURIComponent(source.workingPath));
      expect(url).not.toContain("preview");
    }
    await expect(page.getByText("Conflito ao salvar")).toHaveCount(0);
    await expect(page.getByText("Não foi possível carregar o projeto")).toHaveCount(0);
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
