// @vitest-environment node

import { execFile } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Clip, ProjectSnapshot } from "@/lib/repurpose/types";

const FACE_PATH = "C:\\media\\face.mp4";
const SCREEN_PATH = "C:\\media\\screen.mp4";

interface SourceAvailability {
  face: boolean;
  screen: boolean;
}

function clip(splitRatio?: number): Clip {
  return {
    id: "clip-1",
    kind: "take",
    label: "First",
    srcStart: 0,
    srcEnd: 4,
    timelineStart: 0,
    timelineEnd: 4,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: 4 }],
    keeperIndex: 0,
    splitRatio,
  };
}

function snapshot(globalRatio: unknown, clipRatio?: unknown): ProjectSnapshot {
  return {
    clips: [clip(clipRatio as number | undefined)],
    duration: 4,
    splitRatio: globalRatio as number,
    screenGrade: "none",
    faceGrade: "neutral",
    playhead: 0,
    inPoint: null,
    outPoint: null,
    loopPlayback: false,
    footageMeta: {
      faceCamPath: FACE_PATH,
      screenPath: SCREEN_PATH,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 4,
    },
  };
}

async function requestThumb(
  globalRatio: unknown,
  clipRatio?: unknown,
  availability: SourceAvailability = { face: true, screen: true }
): Promise<{ response: Response; execFileMock: ReturnType<typeof vi.fn> }> {
  const execFileMock = vi.fn(
    (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, "", "");
      return { kill: vi.fn() };
    }
  );
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: execFileMock as unknown as typeof execFile,
  }));
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      default: {
        ...actual,
        existsSync: vi.fn((candidate: fs.PathLike) => {
          if (String(candidate) === FACE_PATH) return availability.face;
          if (String(candidate) === SCREEN_PATH) return availability.screen;
          return true;
        }),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(() => Buffer.from([1, 2, 3])) as unknown as typeof fs.readFileSync,
        statSync: vi.fn(() => {
          throw Object.assign(new Error("missing cache"), { code: "ENOENT" });
        }),
      } satisfies Partial<typeof fs>,
    };
  });
  vi.doMock("@/lib/repurpose/projects", () => ({
    PROJECTS_DIR: "C:\\projects",
    isValidProjectId: (id: unknown) => typeof id === "string" && id.length > 0,
    readProject: () => ({ snapshot: snapshot(globalRatio, clipRatio) }),
  }));
  vi.resetModules();
  const { GET } = await import("@/app/api/repurpose/thumb/route");

  const response = await GET(
    new Request(`http://localhost/api/repurpose/thumb?id=thumb-${String(globalRatio)}-${String(clipRatio)}`)
  );

  return { response, execFileMock };
}

async function render(
  globalRatio: unknown,
  clipRatio?: unknown,
  availability?: SourceAvailability
): Promise<string[]> {
  const { response, execFileMock } = await requestThumb(
    globalRatio,
    clipRatio,
    availability
  );
  expect(response.status).toBe(200);
  expect(execFileMock).toHaveBeenCalledOnce();
  return execFileMock.mock.calls[0][1] as string[];
}

function filterFrom(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("@/lib/repurpose/projects");
  vi.resetModules();
});

describe("GET /api/repurpose/thumb full-range split", () => {
  test.each([
    ["exact zero", 0],
    ["tiny rounded zero", 0.49 / 480],
  ])("uses Face directly for %s", async (_name, ratio) => {
    const args = await render(ratio, undefined, { face: true, screen: false });
    const filter = filterFrom(args);

    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(args).toContain(FACE_PATH);
    expect(args).not.toContain(SCREEN_PATH);
    expect(filter).toBe(
      "[0:v]scale=480:480:force_original_aspect_ratio=increase,crop=480:480:(in_w-480)/2:(in_h-480)/2[out]"
    );
    expect(filter).not.toMatch(/scale=480:0|crop=480:0|vstack/);
  });

  test.each([
    ["exact one", 1],
    ["tiny rounded full", 1 - 0.49 / 480],
  ])("uses Screen directly for %s", async (_name, ratio) => {
    const args = await render(0.5, ratio, { face: false, screen: true });
    const filter = filterFrom(args);

    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(args).toContain(SCREEN_PATH);
    expect(args).not.toContain(FACE_PATH);
    expect(filter).toBe(
      "[0:v]scale=480:480:force_original_aspect_ratio=increase,crop=480:480:(in_w-480)/2:in_h-480[out]"
    );
    expect(filter).not.toMatch(/scale=480:0|crop=480:0|vstack/);
  });

  test("keeps a normal split and honors ratios outside the old 0.4-0.6 clamp", async () => {
    const normal = filterFrom(await render(0.2));
    const high = filterFrom(await render(0.79));

    expect(normal).toContain("scale=480:96");
    expect(normal).toContain("scale=480:384");
    expect(normal).toContain("[top][bot]vstack[out]");
    expect(high).toContain("scale=480:379");
    expect(high).toContain("scale=480:101");
  });

  test.each([Number.NaN, Infinity, "not-a-ratio"])(
    "falls back invalid ratio %s to an even split",
    async (ratio) => {
      const filter = filterFrom(await render(ratio));
      expect(filter).toContain("scale=480:240");
      expect(filter).toContain("[top][bot]vstack[out]");
    }
  );

  test.each([
    ["Face-full without Face", 0, undefined, { face: false, screen: true }],
    ["Screen-full without Screen", 1, undefined, { face: true, screen: false }],
    ["split without Face", 0.5, undefined, { face: false, screen: true }],
    ["split without Screen", 0.5, undefined, { face: true, screen: false }],
  ] satisfies Array<[string, unknown, unknown, SourceAvailability]>)(
    "returns no thumbnail for %s",
    async (_name, globalRatio, clipRatio, availability) => {
      const { response, execFileMock } = await requestThumb(
        globalRatio,
        clipRatio,
        availability
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("no thumb");
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );
});
