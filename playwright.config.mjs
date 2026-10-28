import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30000,
  expect: { timeout: 10000 },
  workers: 1,
  outputDir: "artifacts/browser",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4318",
    locale: "zh-CN",
    timezoneId: "Europe/Paris",
    launchOptions: {
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "phone",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:4318/api/health",
    env: { PORT: "4318", DATA_DIR: "artifacts/e2e-data" },
    reuseExistingServer: false,
  },
});
