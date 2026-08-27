import { expect, type Page } from "@playwright/test";
import path from "node:path";

export const GENERATED_FIXTURES = path.resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "generated"
);

export interface BrowserErrorCollector {
  consoleErrors: string[];
  pageErrors: string[];
  httpErrors: string[];
  requestFailures: string[];
  assertEmpty(): void;
}

export function collectBrowserErrors(page: Page): BrowserErrorCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];
  const requestFailures: string[] = [];
  const failedRequestDetails: Array<{
    method: string;
    url: string;
    errorText: string;
  }> = [];
  const expectedConsoleFailureUrls = new Set<string>();
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location().url;
      consoleErrors.push(`${message.text()}${location ? ` @ ${location}` : ""}`);
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(
      JSON.stringify({
        name: error.name,
        message: error.message,
        stack: error.stack,
        url: page.url(),
      })
    );
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const expectedOptional404 =
      response.status() === 404 &&
      response.request().method() === "GET" &&
      [
        "/repurpose/claude-routines-words.json",
        "/repurpose/final-transcript.txt",
        "/repurpose/footage-manifest.json",
      ].includes(url.pathname);
    const expectedSaveRace =
      response.status() === 409 &&
      response.request().method() === "POST" &&
      url.pathname === "/api/repurpose/projects";
    if (expectedSaveRace) expectedConsoleFailureUrls.add(response.url());
    if (response.status() >= 400 && !expectedOptional404 && !expectedSaveRace) {
      httpErrors.push(
        `${response.request().method()} ${response.status()} ${response.url()}`
      );
    }
  });
  page.on("requestfailed", (request) => {
    const detail = {
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? "unknown failure",
    };
    failedRequestDetails.push(detail);
    requestFailures.push(`${detail.method} ${detail.url} (${detail.errorText})`);
  });
  return {
    consoleErrors,
    pageErrors,
    httpErrors,
    requestFailures,
    assertEmpty() {
      const unexpectedConsoleErrors = consoleErrors.filter((message) => {
        if (!message.startsWith("Failed to load resource:")) return true;
        const location = message.split(" @ ")[1];
        if (!location) return true;
        const url = new URL(location);
        return !(
          [
            "/repurpose/claude-routines-words.json",
            "/repurpose/final-transcript.txt",
            "/repurpose/footage-manifest.json",
          ].includes(url.pathname) ||
          expectedConsoleFailureUrls.has(location)
        );
      });
      const unexpectedRequestFailures = failedRequestDetails
        .filter(({ method, url: rawUrl, errorText }) => {
          if (errorText !== "net::ERR_ABORTED") return true;
          const url = new URL(rawUrl);
          const knownLifecycleAbort =
            (method === "GET" &&
              [
                "/api/repurpose/video",
                "/api/repurpose/asset",
                "/api/repurpose/thumb",
              ].includes(url.pathname)) ||
            (method === "POST" && url.pathname === "/api/repurpose/proxy") ||
            (method === "GET" &&
              /^\/api\/repurpose\/projects\/[^/]+$/.test(url.pathname)) ||
            (method === "GET" && url.searchParams.has("_rsc"));
          return !knownLifecycleAbort;
        })
        .map(({ method, url, errorText }) => `${method} ${url} (${errorText})`);
      expect(
        {
          consoleErrors: unexpectedConsoleErrors,
          httpErrors,
          requestFailures: unexpectedRequestFailures,
        },
        "unexpected browser console, HTTP, or request failures"
      ).toEqual({ consoleErrors: [], httpErrors: [], requestFailures: [] });
      expect(pageErrors, "unexpected uncaught page errors").toEqual([]);
    },
  };
}

async function installImportPhaseRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __repurposeImportPhases?: string[];
      __repurposeImportObserver?: MutationObserver;
    };
    state.__repurposeImportPhases = [];
    state.__repurposeImportObserver?.disconnect();
    const capture = () => {
      const text = document.body.innerText;
      for (const label of [
        "Copiando arquivo",
        "Inspecionando mídia",
        "Verificando compatibilidade no Chrome",
        "Convertendo HEVC para H.264",
        "Criando proxy de prévia",
        "Pronto",
      ]) {
        if (text.includes(label)) state.__repurposeImportPhases?.push(label);
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    state.__repurposeImportObserver = observer;
    capture();
  });
}

export async function observedImportPhases(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = window as typeof window & { __repurposeImportPhases?: string[] };
    return [...new Set(state.__repurposeImportPhases ?? [])];
  });
}

async function chooseFileFromButton(
  page: Page,
  buttonName: string,
  filePath: string
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
  await chooser.setFiles(filePath);
}

async function waitForReadyCount(page: Page, count: number): Promise<void> {
  await expect(page.getByText("Pronto", { exact: true })).toHaveCount(count, {
    timeout: 60_000,
  });
}

export async function createProjectWithFootage(
  page: Page,
  videoFixture: string
): Promise<string> {
  await page.goto("/repurpose-studio");
  await expect(page.locator(".animate-pulse")).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("button", { name: "New Project", exact: true }).first().click();
  await expect(page).toHaveURL(/\/repurpose-studio\/new-/);
  await expect(page.getByText("Sources", { exact: true })).toBeVisible();
  await installImportPhaseRecorder(page);

  await chooseFileFromButton(
    page,
    "Load raw transcript (.srt / .json)",
    path.join(GENERATED_FIXTURES, "raw.srt")
  );
  await expect(page.getByText("Transcript", { exact: true })).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).pathname.split("/").pop() ?? "", {
      timeout: 20_000,
    })
    .not.toMatch(/^new-/);

  await chooseFileFromButton(page, "Screen", videoFixture);
  await waitForReadyCount(page, 1);
  await chooseFileFromButton(page, "Face", videoFixture);
  await waitForReadyCount(page, 2);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  const projectId = new URL(page.url()).pathname.split("/").pop()!;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/repurpose/projects/${projectId}`
        );
        if (!response.ok()) return [false, false];
        const body = (await response.json()) as {
          project?: {
            snapshot?: {
              footageMeta?: {
                faceCamSource?: { previewPath?: string };
                screenSource?: { previewPath?: string };
              };
            };
          };
        };
        const meta = body.project?.snapshot?.footageMeta;
        return [
          Boolean(meta?.screenSource?.previewPath),
          Boolean(meta?.faceCamSource?.previewPath),
        ];
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] }
    )
    .toEqual([true, true]);
  await expect(page.getByText(/^Preparing fast preview /)).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => {
      const state = window as typeof window & { __proxySettledSince?: number };
      if (document.body.innerText.includes("Preparing fast preview")) {
        state.__proxySettledSince = undefined;
        return false;
      }
      state.__proxySettledSince ??= performance.now();
      return performance.now() - state.__proxySettledSince >= 5_000;
    },
    undefined,
    { polling: 100, timeout: 60_000 }
  );

  return projectId;
}

export function currentDurableProjectId(page: Page): string | undefined {
  const id = new URL(page.url()).pathname.split("/").pop();
  return id && id !== "repurpose-studio" && !id.startsWith("new-")
    ? id
    : undefined;
}

async function playheadValue(page: Page): Promise<number> {
  const value = await page
    .getByRole("slider", { name: "Playhead" })
    .getAttribute("aria-valuenow");
  return Number(value);
}

export async function assertPlaybackFrozenWithin100ms(
  readPlayhead: () => Promise<number>,
  wait: (milliseconds: number) => Promise<void>,
  fps = 30
): Promise<void> {
  const pausedAt = await readPlayhead();
  await wait(100);
  const after100ms = await readPlayhead();
  const maxAdvance = 1 / fps + 0.01;
  if (after100ms - pausedAt > maxAdvance) {
    throw new Error(
      `Playhead advanced ${(after100ms - pausedAt).toFixed(3)}s within 100ms after Pause.`
    );
  }
}

async function verifyPlayPause(page: Page): Promise<void> {
  const beforePlay = await playheadValue(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => playheadValue(page), { timeout: 5_000, intervals: [50, 100] })
    .toBeGreaterThan(beforePlay + 0.05);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await assertPlaybackFrozenWithin100ms(
    () => playheadValue(page),
    (milliseconds) => page.waitForTimeout(milliseconds)
  );
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
}

async function seekForwardFromStart(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  await expect.poll(() => playheadValue(page)).toBe(0);
  const beforeSeek = await playheadValue(page);
  const handle = page.getByRole("slider", { name: "Playhead" });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 120, box!.y + 35);
  await expect
    .poll(() => playheadValue(page), { timeout: 2_000 })
    .toBeGreaterThan(beforeSeek + 0.25);
}

export async function verifyPlayPauseAndSeek(page: Page): Promise<void> {
  await verifyPlayPause(page);
  await seekForwardFromStart(page);
}

export async function reloadAndReopenProject(
  page: Page,
  projectId: string
): Promise<void> {
  const expectedPlayhead = await playheadValue(page);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/repurpose/projects/${projectId}`
        );
        if (!response.ok()) return Number.NaN;
        const body = (await response.json()) as {
          project?: { snapshot?: { playhead?: number } };
        };
        return body.project?.snapshot?.playhead ?? Number.NaN;
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBeCloseTo(expectedPlayhead, 2);
  await page.reload();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Back to all projects" }).click();
  await expect(page).toHaveURL(/\/repurpose-studio$/);
  await page.locator(`a[href="/repurpose-studio/${projectId}"]`).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await verifyPlayPause(page);
  await seekForwardFromStart(page);
}

export async function cleanupProject(page: Page, projectId: string): Promise<void> {
  await page.goto("/repurpose-studio");
  const response = await page.request.delete(`/api/repurpose/projects/${projectId}`);
  expect([200, 404]).toContain(response.status());
}
