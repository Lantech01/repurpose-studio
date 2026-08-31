// @vitest-environment node

import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const tempRoots: string[] = [];

function persistedClip(source: unknown, id = "sfx-clip-1") {
  return {
    id,
    name: "Persisted SFX",
    source,
    origin: "manual",
    timelineStart: 0,
    sourceStart: 0,
    sourceEnd: 1,
    gain: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("node:os");
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("repurpose-studio.project-reference-runtime")];
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted SFX project references", () => {
  it("dedupes the same generated WAV referenced by an old track and new legacy clips", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-refs-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    await mkdir(projects.PROJECTS_DIR, { recursive: true });
    const referencedPath = path.join(home, "Downloads", "repurpose-overlays", "..", "repurpose-overlays", `sfx-${"a".repeat(64)}.wav`);
    fs.writeFileSync(path.join(projects.PROJECTS_DIR, "valid.json"), JSON.stringify({
      id: "valid",
      name: "Valid",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      snapshot: {
        sfxTrack: { sourcePath: referencedPath },
        sfxClips: [
          persistedClip(
            {
              kind: "legacy",
              sourcePath: referencedPath,
              srcDuration: 1,
            },
            "sfx-clip-1",
          ),
          persistedClip(
            {
              kind: "legacy",
              sourcePath: referencedPath,
              srcDuration: 1,
            },
            "sfx-clip-2",
          ),
        ],
      },
    }));

    await expect(projects.listReferencedSfxPaths()).resolves.toEqual(new Set([
      projects.normalizeProjectMediaPath(referencedPath),
    ]));
  });

  it("ignores valid built-in and imported clip sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-ignore-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    await mkdir(projects.PROJECTS_DIR, { recursive: true });
    await writeFile(path.join(projects.PROJECTS_DIR, "ignored.json"), JSON.stringify({
      id: "ignored",
      name: "Ignored",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      snapshot: {
        sfxClips: [
          persistedClip({ kind: "built-in", key: "ding" }, "sfx-clip-1"),
          persistedClip(
            { kind: "imported", assetId: "sfx-asset-1", srcDuration: 1 },
            "sfx-clip-2",
          ),
        ],
      },
    }));

    await expect(projects.listReferencedSfxPaths()).resolves.toEqual(new Set());
  });

  it.each([
    ["non-array", { sfxClips: {} }],
    ["non-object entry", { sfxClips: [null] }],
    ["missing source", { sfxClips: [persistedClip(undefined)] }],
    ["malformed source", { sfxClips: [persistedClip([])] }],
    ["unknown source kind", { sfxClips: [persistedClip({ kind: "other" })] }],
    ["relative legacy path", { sfxClips: [persistedClip({ kind: "legacy", sourcePath: "relative.wav", srcDuration: 1 })] }],
    ["non-string legacy path", { sfxClips: [persistedClip({ kind: "legacy", sourcePath: 42, srcDuration: 1 })] }],
    ["control-character legacy path", { sfxClips: [persistedClip({ kind: "legacy", sourcePath: "C:\\cache\\bad\u0000.wav", srcDuration: 1 })] }],
    ["invalid legacy duration", { sfxClips: [persistedClip({ kind: "legacy", sourcePath: "C:\\cache\\sound.wav", srcDuration: 0 })] }],
    ["legacy path disguised as built-in", { sfxClips: [persistedClip({ kind: "built-in", key: "ding", sourcePath: "C:\\cache\\hidden.wav" })] }],
  ])("fails closed for a %s", async (_label, malformedSnapshot) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-malformed-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    await mkdir(projects.PROJECTS_DIR, { recursive: true });
    await writeFile(path.join(projects.PROJECTS_DIR, "malformed.json"), JSON.stringify({
      id: "malformed",
      name: "Malformed",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      snapshot: malformedSnapshot,
    }));

    await expect(projects.listReferencedSfxPaths()).rejects.toMatchObject({
      code: "PROJECT_REFERENCE_SNAPSHOT_UNAVAILABLE",
    });
  });

  it("protects a migrated saved snapshot after the old track field disappears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-migrated-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    await mkdir(projects.PROJECTS_DIR, { recursive: true });
    const referencedPath = path.join(home, "Downloads", "repurpose-overlays", `sfx-${"b".repeat(64)}.wav`);
    await writeFile(path.join(projects.PROJECTS_DIR, "migrated.json"), JSON.stringify({
      id: "migrated",
      name: "Migrated",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      snapshot: {
        sfxClips: [persistedClip({
          kind: "legacy",
          sourcePath: referencedPath,
          srcDuration: 1,
        })],
      },
    }));

    await expect(projects.listReferencedSfxPaths()).resolves.toEqual(new Set([
      projects.normalizeProjectMediaPath(referencedPath),
    ]));
  });

  it("rejects the snapshot when project enumeration fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-enumeration-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("enumeration unavailable"), { code: "EACCES" });
    });

    await expect(projects.listReferencedSfxPaths()).rejects.toMatchObject({
      code: "PROJECT_REFERENCE_SNAPSHOT_UNAVAILABLE",
    });
    readdir.mockRestore();
  });

  it("rejects the snapshot when an individual project cannot prove references absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-corrupt-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    await mkdir(projects.PROJECTS_DIR, { recursive: true });
    await writeFile(path.join(projects.PROJECTS_DIR, "corrupt.json"), "{not-json");

    await expect(projects.listReferencedSfxPaths()).rejects.toMatchObject({
      code: "PROJECT_REFERENCE_SNAPSHOT_UNAVAILABLE",
    });
  });

  it("serializes a deferred save before a reference snapshot can evict its SFX final", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-project-save-race-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const projects = await import("@/lib/repurpose/projects");
    const referencedPath = path.join(home, "Downloads", "repurpose-overlays", `sfx-${"a".repeat(64)}.wav`);
    await mkdir(path.dirname(referencedPath), { recursive: true });
    await writeFile(referencedPath, "wav");
    let saveWriteStarted!: () => void;
    let resumeSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => { saveWriteStarted = resolve; });
    const saveMayFinish = new Promise<void>((resolve) => { resumeSave = resolve; });
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, options) => {
      const result = await originalWriteFile(file, data, options);
      if (String(file).endsWith(".tmp")) {
        saveWriteStarted();
        await saveMayFinish;
      }
      return result;
    });
    const project = {
      id: "save-race",
      name: "Save race",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      saveRevision: 1,
      saveWriterId: "writer-id",
      saveWriterBaseRevision: 0,
      createRequestId: null,
      createWriterId: null,
      snapshot: { sfxTrack: { sourcePath: referencedPath } },
    } as unknown as Parameters<typeof projects.writeProject>[0];

    const save = projects.writeProject(project);
    try {
      expect(await Promise.race([
        saveStarted.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
      ])).toBe(true);
      let sweepEntered = false;
      const sweep = projects.withProjectReferenceSnapshot(async (references) => {
        sweepEntered = true;
        if (!references.has(projects.normalizeProjectMediaPath(referencedPath) ?? "")) {
          await rm(referencedPath, { force: true });
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sweepEntered).toBe(false);
      resumeSave();
      await save;
      await sweep;
      await expect(fs.promises.stat(referencedPath)).resolves.toMatchObject({ size: 3 });
    } finally {
      resumeSave();
    }
  });
});
