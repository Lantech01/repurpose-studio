import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

import {
  GENERATED_FIXTURES,
  assertPlaybackFrozenWithin100ms,
  cleanupProject,
  collectBrowserErrors,
  createProjectWithFootage,
  currentDurableProjectId,
  reloadAndReopenProject,
} from "./helpers/project";

type SurfaceSnapshot = {
  clips?: Array<{ id: string; srcEnd: number }>;
  overlays?: Array<{ id: string }>;
  loopPlayback?: boolean;
  inPoint?: number | null;
  outPoint?: number | null;
  musicTrack?: { name?: string } | null;
  sfxTrack?: { sourcePath?: string } | null;
};

async function readSnapshot(page: Page, projectId: string): Promise<SurfaceSnapshot> {
  const response = await page.request.get(`/api/repurpose/projects/${projectId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    project?: { snapshot?: SurfaceSnapshot };
  };
  return body.project?.snapshot ?? {};
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

async function dispatchGeneratedPng(
  page: Page,
  mode: "drop" | "paste",
  name: string,
  color: string
): Promise<void> {
  await page.evaluate(
    async ({ mode, name, color }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas is unavailable");
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("PNG encoding failed"))),
          "image/png"
        )
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], name, { type: "image/png" }));

      if (mode === "paste") {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: transfer });
        document.dispatchEvent(event);
        return;
      }

      const heading = [...document.querySelectorAll("h3")].find(
        (element) => element.textContent?.trim() === "Files"
      );
      const target = heading?.parentElement?.parentElement;
      if (!target) throw new Error("Files drop target not found");
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    },
    { mode, name, color }
  );
}

async function playhead(page: Page): Promise<number> {
  return Number(
    await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow")
  );
}

async function goToFrame(page: Page, frame: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let index = 0; index < frame; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
}

test("dogfoods the remaining editor surfaces through the browser", async ({ page }) => {
  test.setTimeout(300_000);
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );
    await chooseFiles(
      page,
      "Load final transcript (.srt)",
      path.join(GENERATED_FIXTURES, "raw.srt")
    );

    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    expect(await playhead(page)).toBeCloseTo(1 / 30, 2);
    await page.keyboard.press("Space");
    await expect.poll(() => playhead(page), { timeout: 5_000 }).toBeGreaterThan(0.08);
    await page.keyboard.press("Space");
    await assertPlaybackFrozenWithin100ms(
      () => playhead(page),
      (milliseconds) => page.waitForTimeout(milliseconds)
    );
    await page.keyboard.press("l");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.keyboard.press("k");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.getByRole("button", { name: "Playback speed" })).toContainText("0.75x");
    await page.keyboard.press("k");

    await goToFrame(page, 45);
    expect(await playhead(page)).toBeCloseTo(1.5, 2);
    await page.keyboard.press("KeyS");
    await expect
      .poll(async () => (await readSnapshot(page, projectId!)).clips?.length ?? 0)
      .toBe(2);

    const firstClip = page.locator("[data-clip-id]").first();
    const firstClipId = await firstClip.getAttribute("data-clip-id");
    const beforeTrim = (await readSnapshot(page, projectId!)).clips?.find(
      (clip) => clip.id === firstClipId
    )?.srcEnd;
    expect(beforeTrim).toBeDefined();
    const trimHandle = firstClip.locator('[data-trim-edge="end"]');
    const trimBox = await trimHandle.boundingBox();
    expect(trimBox).not.toBeNull();
    await page.mouse.move(trimBox!.x + trimBox!.width / 2, trimBox!.y + trimBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(trimBox!.x - 18, trimBox!.y + trimBox!.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (await readSnapshot(page, projectId!)).clips?.find(
            (clip) => clip.id === firstClipId
          )?.srcEnd ?? Number.POSITIVE_INFINITY
      )
      .toBeLessThan(beforeTrim!);

    await goToFrame(page, 43);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => playhead(page), { timeout: 5_000 }).toBeGreaterThan(1.52);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Toggle loop" }).click();
    await expect(page.getByRole("button", { name: "Toggle loop" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.getByRole("button", { name: "Set in point" }).click();
    await goToFrame(page, 84);
    await page.getByRole("button", { name: "Set out point" }).click();
    await expect(page.getByRole("button", { name: "Clear in/out region" })).toBeVisible();

    const captionsHeading = page.getByRole("heading", { name: "Captions", exact: true });
    await captionsHeading
      .locator("..")
      .getByRole("button", { name: "Off", exact: true })
      .click();
    await expect(
      captionsHeading.locator("..").getByRole("button", { name: "On", exact: true })
    ).toHaveAttribute("aria-pressed", "true");

    await chooseFiles(page, "Import", [
      path.join(GENERATED_FIXTURES, "overlay.png"),
      path.join(GENERATED_FIXTURES, "music.wav"),
    ]);
    await expect(page.getByText("overlay.png", { exact: true })).toBeVisible();
    await expect(page.getByText("music.wav", { exact: true })).toBeVisible();
    await page
      .locator("li")
      .filter({ hasText: "overlay.png" })
      .getByRole("button")
      .first()
      .click();
    await page
      .locator("li")
      .filter({ hasText: "music.wav" })
      .getByRole("button")
      .first()
      .click();
    await expect(page.getByText(/music\.wav \(3s\)/)).toBeVisible();

    await dispatchGeneratedPng(page, "drop", "surface-drop.png", "#24a148");
    await expect(page.getByText("surface-drop.png", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page
      .locator("li")
      .filter({ hasText: "surface-drop.png" })
      .getByRole("button")
      .first()
      .click();
    await expect
      .poll(async () => (await readSnapshot(page, projectId!)).overlays?.length ?? 0, {
        timeout: 30_000,
      })
      .toBe(2);
    const overlaysBeforePaste = (await readSnapshot(page, projectId)).overlays?.length ?? 0;
    await dispatchGeneratedPng(page, "paste", "surface-paste.png", "#8a3ffc");
    await expect
      .poll(async () => (await readSnapshot(page, projectId!)).overlays?.length ?? 0, {
        timeout: 30_000,
      })
      .toBe(overlaysBeforePaste + 1);

    await page.getByRole("button", { name: "Generate SFX track", exact: true }).click();
    await expect(page.getByText("SFX track loaded (3s)", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(async () => (await readSnapshot(page, projectId!)).sfxTrack?.sourcePath ?? "", {
        timeout: 30_000,
      })
      .not.toBe("");
    const finalSnapshot = await readSnapshot(page, projectId);
    expect(finalSnapshot.loopPlayback).toBe(true);
    expect(finalSnapshot.musicTrack?.name).toBe("music.wav");
    expect(finalSnapshot.sfxTrack?.sourcePath).toBeTruthy();

    await page.getByRole("button", { name: "Clear in/out region" }).click();
    await page.getByRole("button", { name: "Toggle loop" }).click();
    await expect
      .poll(async () => {
        const snapshot = await readSnapshot(page, projectId!);
        return [snapshot.loopPlayback, snapshot.inPoint, snapshot.outPoint];
      })
      .toEqual([false, null, null]);
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await expect.poll(() => playhead(page)).toBe(0);
    await reloadAndReopenProject(page, projectId);

    await page.getByRole("button", { name: "Back to all projects" }).click();
    const projectLink = page.locator(`a[href="/repurpose-studio/${projectId}"]`);
    await expect(projectLink).toBeVisible();
    await page.getByRole("button", { name: /^Delete / }).first().click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(projectLink).toHaveCount(0);
    projectId = undefined;
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
