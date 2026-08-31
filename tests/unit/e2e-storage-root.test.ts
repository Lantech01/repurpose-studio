// @vitest-environment node

import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  e2eStoragePaths,
  validateOwnedE2eRoot,
  validateReusedE2eStorage,
} from "@/tests/e2e/helpers/storage-root";

describe("Playwright storage isolation", () => {
  it("accepts only a uniquely named direct child of the OS temp directory for owned cleanup", () => {
    const valid = path.join(os.tmpdir(), "repurpose-studio-e2e-abc123");
    expect(validateOwnedE2eRoot(valid)).toBe(path.resolve(valid));
    expect(() => validateOwnedE2eRoot(os.tmpdir())).toThrow(/refusing/i);
    expect(() => validateOwnedE2eRoot(path.join(os.tmpdir(), "other-suite"))).toThrow(/refusing/i);
    expect(() => validateOwnedE2eRoot(path.join(os.homedir(), "Downloads"))).toThrow(/refusing/i);
  });

  it("requires reused-server asset and SFX roots to be distinct children of the declared root", () => {
    const root = path.join(os.tmpdir(), "caller-owned-repurpose-e2e");
    const paths = e2eStoragePaths(root);
    expect(validateReusedE2eStorage({
      REPURPOSE_E2E_ROOT: root,
      REPURPOSE_ASSET_DIR: paths.assetDir,
      REPURPOSE_SFX_CACHE_DIR: paths.sfxDir,
      REPURPOSE_PROJECTS_DIR: paths.projectsDir,
    })).toEqual({ ...paths, ownsRoot: false });
    expect(() => validateReusedE2eStorage({
      REPURPOSE_E2E_ROOT: root,
      REPURPOSE_ASSET_DIR: path.join(root, "..", "outside"),
      REPURPOSE_SFX_CACHE_DIR: paths.sfxDir,
      REPURPOSE_PROJECTS_DIR: paths.projectsDir,
    })).toThrow(/contained/i);
    expect(() => validateReusedE2eStorage({})).toThrow(/REPURPOSE_E2E_ROOT/);
  });

  it("runs its managed server from a production build", async () => {
    const paths = e2eStoragePaths(path.join(os.tmpdir(), "caller-owned-repurpose-e2e"));
    vi.stubEnv("REPURPOSE_E2E_REUSE_SERVER", "1");
    vi.stubEnv("REPURPOSE_E2E_ROOT", paths.root);
    vi.stubEnv("REPURPOSE_ASSET_DIR", paths.assetDir);
    vi.stubEnv("REPURPOSE_SFX_CACHE_DIR", paths.sfxDir);
    vi.stubEnv("REPURPOSE_PROJECTS_DIR", paths.projectsDir);
    vi.stubEnv("REPURPOSE_E2E_OWNS_ROOT", "0");
    vi.resetModules();

    try {
      const config = (await import("../../playwright.config")).default;
      expect(config.webServer).toMatchObject({
        command: "npm run build && npm run start -- --port 3001",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
