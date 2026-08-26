import { expect, test } from "@playwright/test";
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
