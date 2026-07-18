import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3105);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CHROMIUM_EXECUTABLE = process.env.PAPERCLIP_E2E_CHROMIUM_EXECUTABLE?.trim();

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user-authenticated.spec.ts",
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: CHROMIUM_EXECUTABLE } } : {}),
      },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
