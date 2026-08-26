import { defineConfig, devices } from "@playwright/test";

const reuseExistingServer = process.env.REPURPOSE_E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
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
    command: "npm run dev -- --port 3001",
    url: "http://127.0.0.1:3001/repurpose-studio",
    reuseExistingServer,
    timeout: 120_000,
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
