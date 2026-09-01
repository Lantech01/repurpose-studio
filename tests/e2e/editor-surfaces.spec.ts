import { expect, test, type Locator, type Page } from "@playwright/test";
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
  clips?: Array<{ id: string; srcEnd: number; splitRatio?: number }>;
  overlays?: Array<{
    id: string;
    kind: "image" | "video";
    src: string;
    sourcePath?: string;
    videoSource?: { workingPath: string; previewPath?: string };
    timelineStart: number;
    timelineEnd: number;
    srcStart?: number;
    srcDuration?: number;
    transform: { x: number; y: number; scale: number; rotation: number };
    entranceEffect?: { type: string; durationSec: number; direction?: string };
    exitEffect?: { type: string; durationSec: number; direction?: string };
    cornerRadius?: number;
  }>;
  captionBlocks?: Array<{
    id: string;
    start: number;
    end: number;
    overrideStyle?: {
      pinToSplit?: boolean;
      positionYPct?: number;
      splitOffsetPct?: number;
    };
  }>;
  loopPlayback?: boolean;
  inPoint?: number | null;
  outPoint?: number | null;
  musicTrack?: { name?: string } | null;
  sfxClips?: Array<{
    origin: "automatic" | "manual";
    source:
      | { kind: "built-in"; key: string }
      | { kind: "imported"; assetId: string; srcDuration: number }
      | { kind: "legacy"; sourcePath: string; srcDuration: number };
  }>;
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

async function seekToFrame(page: Page, frame: number): Promise<void> {
  const time = frame / 30;
  await page.keyboard.press("Home");
  const seconds = Math.floor(frame / 30);
  for (let index = 0; index < seconds; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
  }
  for (let index = seconds * 30; index < frame; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect.poll(() => playhead(page)).toBeCloseTo(time, 3);
}

async function waitForSnapshot(
  page: Page,
  projectId: string,
  predicate: (snapshot: SurfaceSnapshot) => boolean
): Promise<SurfaceSnapshot> {
  await expect
    .poll(async () => predicate(await readSnapshot(page, projectId)), {
      timeout: 30_000,
      intervals: [100, 250, 500],
    })
    .toBe(true);
  return readSnapshot(page, projectId);
}

function timelineOverlay(page: Page, id: string) {
  return page.locator(`#timeline-panel [data-overlay-id="${id}"]`).first();
}

async function selectTimelineOverlay(page: Page, id: string): Promise<void> {
  const block = timelineOverlay(page, id);
  await expect(block).toBeVisible();
  await block.click({ position: { x: 20, y: 20 }, force: true });
  await expect(page.locator(`div.fixed[data-overlay-id="${id}"]`)).toBeVisible();
}

async function configureOverlayAppearance(
  page: Page,
  input: {
    entrance: string;
    entranceDuration: string;
    entranceDirection?: string;
    exit: string;
    exitDuration: string;
    exitDirection?: string;
    radiusPreset: string;
  }
): Promise<void> {
  await page.getByLabel("Efeito de entrada").selectOption(input.entrance);
  if (input.entranceDirection) {
    await page.getByLabel("Direcao da entrada").selectOption(input.entranceDirection);
  }
  await setRangeByKeyboard(
    page.getByLabel("Duracao da entrada"),
    Number(input.entranceDuration),
    0.1,
    2
  );
  await page.getByLabel("Efeito de saida").selectOption(input.exit);
  if (input.exitDirection) {
    await page.getByLabel("Direcao da saida").selectOption(input.exitDirection);
  }
  await setRangeByKeyboard(
    page.getByLabel("Duracao da saida"),
    Number(input.exitDuration),
    0.1,
    2
  );
  await page.getByRole("button", { name: input.radiusPreset, exact: true }).click();
}

async function setRangeByKeyboard(
  slider: Locator,
  value: number,
  min: number,
  max: number
): Promise<void> {
  await slider.focus();
  expect([min, max]).toContain(value);
  await slider.press(value === min ? "Home" : "End");
  await expect(slider).toHaveValue(String(value));
}

async function ariaLabelAt(
  page: Page,
  point: { x: number; y: number }
): Promise<string | null> {
  return page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[aria-label]")
        ?.getAttribute("aria-label") ?? null,
    point
  );
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
    await page
      .getByRole("dialog", { name: "Aplicar nova transcrição?" })
      .getByRole("button", { name: "Preservar cortes e adicionar legendas" })
      .click();

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

    await page.getByRole("button", { name: "Generate automatic effects", exact: true }).click();
    await expect
      .poll(async () => {
        return (await readSnapshot(page, projectId!)).sfxClips?.some(
          (clip) => clip.origin === "automatic" && clip.source.kind === "built-in",
        );
      }, { timeout: 30_000 })
      .toBe(true);
    const finalSnapshot = await readSnapshot(page, projectId);
    expect(finalSnapshot.loopPlayback).toBe(true);
    expect(finalSnapshot.musicTrack?.name).toBe("music.wav");
    expect(finalSnapshot.sfxTrack).toBeUndefined();
    expect(
      finalSnapshot.sfxClips?.some(
        (clip) =>
          clip.origin === "automatic" && clip.source.kind === "built-in",
      ),
    ).toBe(true);

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

test("integrates detachable captions with authored overlay appearance and persistence", async ({
  page,
}) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(15_000);
  const browserErrors = collectBrowserErrors(page);
  let projectId: string | undefined;
  try {
    projectId = await createProjectWithFootage(
      page,
      path.join(GENERATED_FIXTURES, "h264-aac.mp4")
    );

    await seekToFrame(page, 3);
    const captionHandle = page.getByRole("slider", { name: "Move active caption" });
    await expect(captionHandle).toBeVisible();
    const initialSnapshot = await waitForSnapshot(
      page,
      projectId,
      (snapshot) => (snapshot.captionBlocks?.length ?? 0) >= 2
    );
    const firstCaption = initialSnapshot.captionBlocks!.find(
      (block) => block.start <= 0.1 && block.end > 0.1
    );
    const secondCaption = initialSnapshot.captionBlocks!.find(
      (block) => block.start <= 2.5 && block.end > 2.5
    );
    expect(firstCaption).toBeDefined();
    expect(secondCaption).toBeDefined();
    expect(firstCaption!.id).not.toBe(secondCaption!.id);

    const attachedBox = await captionHandle.boundingBox();
    expect(attachedBox).not.toBeNull();
    await page.mouse.move(
      attachedBox!.x + attachedBox!.width / 2,
      attachedBox!.y + attachedBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      attachedBox!.x + attachedBox!.width / 2 + 70,
      attachedBox!.y + attachedBox!.height / 2 + 80,
      { steps: 5 }
    );
    await page.mouse.up();
    const detachedSnapshot = await waitForSnapshot(page, projectId, (snapshot) => {
      const block = snapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id);
      return block?.overrideStyle?.pinToSplit === false;
    });
    const detachedY = detachedSnapshot.captionBlocks!.find(
      ({ id }) => id === firstCaption!.id
    )!.overrideStyle!.positionYPct!;
    expect(detachedY).toBeGreaterThan(0.5);
    const detachedBox = await captionHandle.boundingBox();
    expect(detachedBox).not.toBeNull();

    await page.keyboard.press("Control+KeyZ");
    await waitForSnapshot(page, projectId, (snapshot) => {
      const block = snapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id);
      return block?.overrideStyle?.pinToSplit !== false;
    });
    await page.keyboard.press("Control+Shift+KeyZ");
    await waitForSnapshot(page, projectId, (snapshot) => {
      const block = snapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id);
      return block?.overrideStyle?.pinToSplit === false;
    });

    await seekToFrame(page, 75);
    const secondBeforeSplit = await captionHandle.boundingBox();
    expect(secondBeforeSplit).not.toBeNull();
    const divider = page.getByRole("separator", {
      name: "Adjust screen and face split",
    });
    await divider.focus();
    await divider.press("ArrowDown");
    await expect
      .poll(async () => Number(await divider.getAttribute("aria-valuenow")))
      .toBeGreaterThan(50.9);
    await expect
      .poll(async () => (await captionHandle.boundingBox())?.y ?? Number.NaN)
      .toBeGreaterThan(secondBeforeSplit!.y + 2);

    await seekToFrame(page, 3);
    const firstAfterSplit = await captionHandle.boundingBox();
    expect(firstAfterSplit).not.toBeNull();
    expect(firstAfterSplit!.y).toBeCloseTo(detachedBox!.y, 1);
    const firstAfterSplitSnapshot = await readSnapshot(page, projectId);
    expect(
      firstAfterSplitSnapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id)
        ?.overrideStyle?.positionYPct
    ).toBeCloseTo(detachedY, 4);

    await page.getByRole("button", { name: "Fixar na divisao", exact: true }).click();
    await waitForSnapshot(page, projectId, (snapshot) => {
      const style = snapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id)
        ?.overrideStyle;
      return (
        style?.pinToSplit === true &&
        style.positionYPct === undefined &&
        style.splitOffsetPct === undefined
      );
    });
    await page.getByRole("button", { name: "Soltar legenda", exact: true }).click();
    const positionSlider = page.getByRole("slider", {
      name: "Posicao absoluta da legenda",
    });
    await expect(positionSlider).toBeVisible();
    const keyboardStart = Number(await positionSlider.inputValue());
    await positionSlider.focus();
    await positionSlider.press("ArrowDown");
    await expect
      .poll(async () => Number(await positionSlider.inputValue()))
      .not.toBe(keyboardStart);

    const positionSliderBox = await positionSlider.boundingBox();
    expect(positionSliderBox).not.toBeNull();
    await page.mouse.click(
      positionSliderBox!.x + positionSliderBox!.width * 0.3,
      positionSliderBox!.y + positionSliderBox!.height / 2
    );
    await expect
      .poll(async () => Number(await positionSlider.inputValue()))
      .toBeGreaterThan(0.2);

    const preview = captionHandle.locator("..");
    const previewBox = await preview.boundingBox();
    const detachedCaptionBox = await captionHandle.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(detachedCaptionBox).not.toBeNull();
    const currentCaptionPosition = Number(await positionSlider.inputValue());
    const targetCaptionPosition =
      Number(await divider.getAttribute("aria-valuenow")) / 100;
    const startX = detachedCaptionBox!.x + detachedCaptionBox!.width / 2;
    const startY = detachedCaptionBox!.y + detachedCaptionBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(
      startX,
      startY +
        (targetCaptionPosition - currentCaptionPosition) * previewBox!.height +
        12,
      { steps: 6 }
    );
    await expect(page.locator("[data-caption-snap-guide]")).toBeVisible();
    await page.mouse.up();
    await waitForSnapshot(page, projectId, (snapshot) => {
      const style = snapshot.captionBlocks?.find(({ id }) => id === firstCaption!.id)
        ?.overrideStyle;
      return style?.pinToSplit === true && style.positionYPct === undefined;
    });

    await chooseFiles(page, "Add media (image / video)", [
      path.join(GENERATED_FIXTURES, "overlay.png"),
      path.join(GENERATED_FIXTURES, "overlay.mp4"),
    ]);
    const imported = await waitForSnapshot(
      page,
      projectId,
      (snapshot) => snapshot.overlays?.length === 2
    );
    const image = imported.overlays!.find((overlay) => overlay.kind === "image")!;
    const video = imported.overlays!.find((overlay) => overlay.kind === "video")!;
    expect(image).toBeDefined();
    expect(video).toBeDefined();
    expect(video.videoSource?.previewPath).toBeTruthy();
    expect(video.src).toContain(encodeURIComponent(video.videoSource!.workingPath));
    expect(video.src).not.toContain(encodeURIComponent(video.videoSource!.previewPath!));

    await seekToFrame(page, 30);
    await selectTimelineOverlay(page, image.id);
    await configureOverlayAppearance(page, {
      entrance: "slide",
      entranceDuration: "0.1",
      entranceDirection: "right",
      exit: "fade",
      exitDuration: "2",
      radiusPreset: "Redondo 16%",
    });
    await expect(page.getByLabel("Efeito de entrada")).toHaveValue("slide");
    await expect(page.getByLabel("Direcao da entrada")).toHaveValue("right");
    await expect(page.getByLabel("Duracao da entrada")).toHaveValue("0.1");
    await expect(page.getByLabel("Efeito de saida")).toHaveValue("fade");
    await expect(page.getByLabel("Duracao da saida")).toHaveValue("2");
    await expect(page.getByLabel("Raio dos cantos")).toHaveValue("0.16");
    const configuredImage = (
      await waitForSnapshot(page, projectId, (snapshot) => {
        const current = snapshot.overlays?.find((overlay) => overlay.id === image.id);
        return (
          current?.entranceEffect?.type === "slide" &&
          current.exitEffect?.type === "fade" &&
          current.cornerRadius === 0.16
        );
      })
    ).overlays!.find((overlay) => overlay.id === image.id)!;

    await seekToFrame(page, 30);
    await selectTimelineOverlay(page, video.id);
    await configureOverlayAppearance(page, {
      entrance: "pop",
      entranceDuration: "2",
      exit: "slide",
      exitDuration: "0.1",
      exitDirection: "up",
      radiusPreset: "Maximo 50%",
    });
    await expect(page.getByLabel("Efeito de entrada")).toHaveValue("pop");
    await expect(page.getByLabel("Efeito de saida")).toHaveValue("slide");
    await expect(page.getByLabel("Direcao da saida")).toHaveValue("up");
    await expect(page.getByLabel("Raio dos cantos")).toHaveValue("0.5");

    await selectTimelineOverlay(page, image.id);
    const bottomHandle = page.getByRole("button", {
      name: "Resize overlay south",
      exact: true,
    });
    const captionAtOverlap = await captionHandle.boundingBox();
    const bottomHandleBox = await bottomHandle.boundingBox();
    expect(captionAtOverlap).not.toBeNull();
    expect(bottomHandleBox).not.toBeNull();
    const handlePoint = {
      x: bottomHandleBox!.x + bottomHandleBox!.width / 2,
      y: bottomHandleBox!.y + bottomHandleBox!.height / 2,
    };
    expect(handlePoint.x).toBeGreaterThanOrEqual(captionAtOverlap!.x);
    expect(handlePoint.x).toBeLessThanOrEqual(captionAtOverlap!.x + captionAtOverlap!.width);
    expect(handlePoint.y).toBeGreaterThanOrEqual(captionAtOverlap!.y);
    expect(handlePoint.y).toBeLessThanOrEqual(captionAtOverlap!.y + captionAtOverlap!.height);
    expect(await ariaLabelAt(page, handlePoint)).toBe("Resize overlay south");

    const captionPoint = {
      x: captionAtOverlap!.x + captionAtOverlap!.width / 2,
      y: captionAtOverlap!.y + captionAtOverlap!.height / 2,
    };
    expect(await ariaLabelAt(page, captionPoint)).toBe("Move active caption");
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const dividerPoint = {
      x: dividerBox!.x + dividerBox!.width - 6,
      y: dividerBox!.y + dividerBox!.height / 2,
    };
    expect(await ariaLabelAt(page, dividerPoint)).toBe(
      "Adjust screen and face split"
    );

    await selectTimelineOverlay(page, video.id);
    const beforeTrimSnapshot = await readSnapshot(page, projectId);
    const beforeTrimVideo = beforeTrimSnapshot.overlays!.find(
      (overlay) => overlay.id === video.id
    )!;
    const videoBlock = timelineOverlay(page, video.id);
    const overlayTrimHandle = videoBlock.locator('[data-trim-edge="end"]');
    const overlayTrimBox = await overlayTrimHandle.boundingBox();
    expect(overlayTrimBox).not.toBeNull();
    await page.mouse.move(
      overlayTrimBox!.x + overlayTrimBox!.width / 2,
      overlayTrimBox!.y + overlayTrimBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      overlayTrimBox!.x - 30,
      overlayTrimBox!.y + overlayTrimBox!.height / 2,
      { steps: 4 }
    );
    await page.mouse.up();
    const trimmed = await waitForSnapshot(page, projectId, (snapshot) => {
      const current = snapshot.overlays?.find((overlay) => overlay.id === video.id);
      return Boolean(current && current.timelineEnd < beforeTrimVideo.timelineEnd);
    });
    const trimmedVideo = trimmed.overlays!.find((overlay) => overlay.id === video.id)!;
    expect(trimmedVideo.entranceEffect?.durationSec).toBe(2);
    expect(trimmedVideo.exitEffect?.durationSec).toBe(0.1);
    expect(trimmedVideo.timelineEnd - trimmedVideo.timelineStart).toBeLessThan(
      beforeTrimVideo.timelineEnd - beforeTrimVideo.timelineStart
    );

    await page.keyboard.press("Control+KeyD");
    const duplicated = await waitForSnapshot(
      page,
      projectId,
      (snapshot) => snapshot.overlays?.length === 3
    );
    const duplicate = duplicated.overlays!.find(
      (overlay) => overlay.id !== image.id && overlay.id !== video.id
    )!;
    expect(duplicate).toMatchObject({
      kind: "video",
      entranceEffect: trimmedVideo.entranceEffect,
      exitEffect: trimmedVideo.exitEffect,
      cornerRadius: trimmedVideo.cornerRadius,
    });

    await selectTimelineOverlay(page, image.id);
    await page.keyboard.press("Control+KeyC");
    const duplicateBlock = timelineOverlay(page, duplicate.id);
    await duplicateBlock.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+Shift+KeyV");
    const pasted = await waitForSnapshot(page, projectId, (snapshot) => {
      const current = snapshot.overlays?.find((overlay) => overlay.id === duplicate.id);
      return (
        current?.entranceEffect?.type === "slide" &&
        current.exitEffect?.type === "fade" &&
        current.cornerRadius === 0.16
      );
    });
    const pastedDuplicate = pasted.overlays!.find((overlay) => overlay.id === duplicate.id)!;
    expect(pastedDuplicate.entranceEffect).toEqual(configuredImage.entranceEffect);
    expect(pastedDuplicate.exitEffect).toEqual(configuredImage.exitEffect);
    expect(pastedDuplicate.cornerRadius).toBe(configuredImage.cornerRadius);
    await page.keyboard.press("Control+KeyZ");
    await waitForSnapshot(page, projectId, (snapshot) => {
      const current = snapshot.overlays?.find((overlay) => overlay.id === duplicate.id);
      return current?.entranceEffect?.type === "pop";
    });
    await page.keyboard.press("Control+Shift+KeyZ");
    await waitForSnapshot(page, projectId, (snapshot) => {
      const current = snapshot.overlays?.find((overlay) => overlay.id === duplicate.id);
      return current?.entranceEffect?.type === "slide";
    });

    await seekToFrame(page, 3);
    await page.getByRole("button", { name: "Soltar legenda", exact: true }).click();
    await expect(positionSlider).toBeVisible();
    await positionSlider.focus();
    await positionSlider.press("End");
    await waitForSnapshot(page, projectId, (snapshot) => {
      const style = snapshot.captionBlocks?.find(
        ({ id }) => id === firstCaption!.id
      )?.overrideStyle;
      return style?.pinToSplit === false && style.positionYPct === 1;
    });

    await reloadAndReopenProject(page, projectId);
    const reopened = await readSnapshot(page, projectId);
    const reopenedFirstCaption = reopened.captionBlocks?.find(
      ({ id }) => id === firstCaption!.id
    );
    expect(reopenedFirstCaption?.overrideStyle).toEqual({
      pinToSplit: false,
      positionYPct: 1,
    });
    expect(reopened.overlays).toHaveLength(3);
    const reopenedImage = reopened.overlays!.find(({ id }) => id === image.id);
    const reopenedVideo = reopened.overlays!.find(({ id }) => id === video.id);
    const reopenedDuplicate = reopened.overlays!.find(({ id }) => id === duplicate.id);
    expect(reopenedImage).toBeDefined();
    expect(reopenedVideo).toBeDefined();
    expect(reopenedDuplicate).toBeDefined();
    expect(new Set(reopened.overlays!.map(({ id }) => id)).size).toBe(3);
    expect(reopenedImage).toMatchObject({
      id: image.id,
      kind: "image",
      cornerRadius: 0.16,
      timelineStart: configuredImage.timelineStart,
      timelineEnd: configuredImage.timelineEnd,
    });
    expect(reopenedImage!.entranceEffect).toEqual({
      type: "slide",
      durationSec: 0.1,
      direction: "right",
    });
    expect(reopenedImage!.exitEffect).toEqual({ type: "fade", durationSec: 2 });
    expect(reopenedVideo).toMatchObject({
      id: video.id,
      kind: "video",
      cornerRadius: 0.5,
      timelineStart: trimmedVideo.timelineStart,
      timelineEnd: trimmedVideo.timelineEnd,
      srcStart: trimmedVideo.srcStart,
      srcDuration: trimmedVideo.srcDuration,
    });
    expect(reopenedVideo!.entranceEffect).toEqual({ type: "pop", durationSec: 2 });
    expect(reopenedVideo!.exitEffect).toEqual({
      type: "slide",
      durationSec: 0.1,
      direction: "up",
    });
    expect(reopenedDuplicate).toMatchObject({
      id: duplicate.id,
      kind: "video",
      cornerRadius: configuredImage.cornerRadius,
      timelineStart: pastedDuplicate.timelineStart,
      timelineEnd: pastedDuplicate.timelineEnd,
    });
    expect(reopenedDuplicate!.entranceEffect).toEqual(configuredImage.entranceEffect);
    expect(reopenedDuplicate!.exitEffect).toEqual(configuredImage.exitEffect);
    expect(reopenedDuplicate!.id).not.toBe(reopenedImage!.id);
    expect(reopenedDuplicate!.id).not.toBe(reopenedVideo!.id);
    console.log(
      "TASK8_REOPEN_PERSISTENCE",
      JSON.stringify({
        caption: reopenedFirstCaption?.overrideStyle,
        image: {
          id: reopenedImage!.id,
          entrance: reopenedImage!.entranceEffect,
          exit: reopenedImage!.exitEffect,
          radius: reopenedImage!.cornerRadius,
        },
        video: {
          id: reopenedVideo!.id,
          entrance: reopenedVideo!.entranceEffect,
          exit: reopenedVideo!.exitEffect,
          radius: reopenedVideo!.cornerRadius,
          timelineStart: reopenedVideo!.timelineStart,
          timelineEnd: reopenedVideo!.timelineEnd,
          srcStart: reopenedVideo!.srcStart,
          srcDuration: reopenedVideo!.srcDuration,
        },
        duplicate: {
          id: reopenedDuplicate!.id,
          entrance: reopenedDuplicate!.entranceEffect,
          exit: reopenedDuplicate!.exitEffect,
          radius: reopenedDuplicate!.cornerRadius,
        },
      })
    );
    expect(JSON.stringify(reopened)).not.toMatch(
      /captionGesture|appearanceGesture|keyboardPlacement|transient/i
    );
    browserErrors.assertEmpty();
  } finally {
    projectId ??= currentDurableProjectId(page);
    if (projectId) await cleanupProject(page, projectId);
  }
});
