import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "America/Indiana/Indianapolis",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: "npm run dev -- --port 3100",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ADA_DEMO_MODE: "true",
      ADA_DATA_DIR: path.join(process.cwd(), ".data-e2e"),
      ADA_NEXT_DIST_DIR: ".next-e2e",
      APP_URL: baseURL,
      // Tests only use demo interpretation and captured email; never real providers.
      OPENAI_API_KEY: "",
      RESEND_API_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
    },
  },
});
