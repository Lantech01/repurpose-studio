import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
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
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
  ],
});
