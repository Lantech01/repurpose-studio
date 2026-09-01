import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  E2E_ROOT_PREFIX,
  e2eStoragePaths,
  validateReusedE2eStorage,
} from "./tests/e2e/helpers/storage-root";

const reuseExistingServer = process.env.REPURPOSE_E2E_REUSE_SERVER === "1";
const inheritedOwnedStorage = !reuseExistingServer && process.env.REPURPOSE_E2E_OWNS_ROOT === "1"
  ? validateReusedE2eStorage(process.env)
  : null;
const storage = reuseExistingServer
  ? validateReusedE2eStorage(process.env)
  : inheritedOwnedStorage
    ? { ...inheritedOwnedStorage, ownsRoot: true }
  : {
      ...e2eStoragePaths(mkdtempSync(path.join(os.tmpdir(), E2E_ROOT_PREFIX))),
      ownsRoot: true,
    };
const storageEnvironment = {
  REPURPOSE_E2E_ROOT: storage.root,
  REPURPOSE_ASSET_DIR: storage.assetDir,
  REPURPOSE_SFX_CACHE_DIR: storage.sfxDir,
  REPURPOSE_PROJECTS_DIR: storage.projectsDir,
  REPURPOSE_E2E_OWNS_ROOT: storage.ownsRoot ? "1" : "0",
};
Object.assign(process.env, storageEnvironment);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: ".gstack/qa-reports/playwright-html",
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && npm run start -- --port 3001",
    url: "http://127.0.0.1:3001/repurpose-studio",
    reuseExistingServer,
    timeout: 120_000,
    env: {
      ...process.env,
      ...storageEnvironment,
    },
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        // Keep the compatibility workflow deterministic on Windows machines
        // that have the optional system HEVC codec installed.
        launchOptions: {
          args: ["--disable-features=PlatformHEVCDecoderSupport"],
        },
      },
    },
  ],
});
