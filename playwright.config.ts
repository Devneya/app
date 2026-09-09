import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "mock",
      testMatch: /mock\/.*\.spec\.ts/,
    },
  ],
  webServer: {
    stdout: "pipe",
    stderr: "pipe",
    command: "npm run build -- --mode test && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_USE_MOCKS: "true",
      VITE_API_BASE_URL: "https://api.devneya.com",
      VITE_GOTRUE_ANON_KEY: "mock-anon-key",
    },
  },
});
