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

test("H.264 project remains playable after save, reload, and reopen", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );
    expect(await observedImportPhases(page)).not.toContain(
      "Convertendo HEVC para H.264"
    );

    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot("h264-ready.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });
    await verifyPlayPauseAndSeek(page);
    await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
      "aria-valuenow",
      /^(?!0(?:\.0+)?$).+/
    );
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot("h264-seek.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });

    await reloadAndReopenProject(page, projectId);
    await expect(page.locator("#preview-panel canvas").first()).toHaveScreenshot("h264-reopened.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    });
    await expect(page.getByText("Conflito ao salvar")).toHaveCount(0);
    await expect(page.getByText("Não foi possível carregar o projeto")).toHaveCount(0);
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
