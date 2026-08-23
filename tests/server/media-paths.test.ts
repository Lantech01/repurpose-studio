// @vitest-environment node

import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type MediaPaths = typeof import("@/lib/repurpose/media-paths.server");

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

async function loadPolicy() {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-media-paths-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  await Promise.all([
    mkdir(path.join(home, "Downloads"), { recursive: true }),
    mkdir(path.join(home, "Desktop"), { recursive: true }),
    mkdir(path.join(home, "Documents"), { recursive: true }),
    mkdir(path.join(home, "Movies"), { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);

  vi.resetModules();
  vi.doMock("node:os", () => ({
    default: { homedir: () => home, tmpdir: () => temp },
    homedir: () => home,
    tmpdir: () => temp,
  }));
  const policy = (await import("@/lib/repurpose/media-paths.server")) as MediaPaths;
  return { root, home, temp, policy };
}

describe("resolveAllowedVideoPath", () => {
  it("accepts video files below every permitted local root", async () => {
    const { home, temp, policy } = await loadPolicy();
    const roots = ["Downloads", "Desktop", "Documents", "Movies"].map((name) => path.join(home, name));
    roots.push(temp);

    for (const [index, root] of roots.entries()) {
      const extension = [".mp4", ".mov", ".m4v", ".webm", ".mkv"][index];
      const file = path.join(root, `clip-${index}${extension}`);
      await writeFile(file, "video");
      await expect(policy.resolveAllowedVideoPath(file)).resolves.toBe(await import("node:fs/promises").then(({ realpath }) => realpath(file)));
    }
  });

  it("rejects traversal and symlink escapes", async () => {
    const { root, home, policy } = await loadPolicy();
    const outside = path.join(root, "private.mp4");
    const linked = path.join(home, "Downloads", "linked");
    await writeFile(outside, "private");
    // Windows permits directory junctions without Developer Mode/admin rights.
    await symlink(root, linked, "junction");

    await expect(policy.resolveAllowedVideoPath(path.join(home, "Downloads", "..", "..", "private.mp4"))).resolves.toBeNull();
    await expect(policy.resolveAllowedVideoPath(path.join(linked, "private.mp4"))).resolves.toBeNull();
  });

  it("accepts an allowed filename that starts with two dots", async () => {
    const { home, policy } = await loadPolicy();
    const file = path.join(home, "Downloads", "..hidden.mp4");
    await writeFile(file, "video");

    await expect(policy.resolveAllowedVideoPath(file)).resolves.toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(file))
    );
  });

  it("allows only known video extensions", async () => {
    const { home, policy } = await loadPolicy();
    const source = path.join(home, "Downloads");
    for (const extension of [".mp4", ".mov", ".m4v", ".webm", ".mkv"]) {
      const file = path.join(source, `allowed${extension}`);
      await writeFile(file, "video");
      await expect(policy.resolveAllowedVideoPath(file)).resolves.not.toBeNull();
    }
    const textFile = path.join(source, "not-video.txt");
    await writeFile(textFile, "secret");
    await expect(policy.resolveAllowedVideoPath(textFile)).resolves.toBeNull();
  });
});
