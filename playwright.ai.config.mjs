import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";

export default defineConfig({
  ...base,
  testMatch: ["stage2.e2e.mjs", "stage3.e2e.mjs", "chat-polish.e2e.mjs", "editor-polish.e2e.mjs", "reading-polish.e2e.mjs"],
  timeout: 45000,
  outputDir: "artifacts/ai-browser",
  use: { ...base.use, baseURL: "http://127.0.0.1:4319" },
  webServer: {
    command: "node tests/browser/ai-server.mjs",
    url: "http://127.0.0.1:4319/api/health",
    reuseExistingServer: false,
  },
});
