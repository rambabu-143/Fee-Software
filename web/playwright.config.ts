import { defineConfig } from '@playwright/test'

// Needs a migrated+seeded throwaway DB (default fees_g1, see README 'UI tests'); never point it at the dev DB.
const DB = process.env.UI_DATABASE_URL ?? 'postgresql://fees:fees@localhost:5432/fees_g1?schema=public'
const API_PORT = process.env.UI_API_PORT ?? '3501'
const WEB_PORT = process.env.UI_WEB_PORT ?? '5601'

export default defineConfig({
  testDir: './e2e',
  workers: 1, // ponytail: serial on purpose, specs share one DB and build on each other's data
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npx nest start',
      cwd: '../api',
      env: { DATABASE_URL: DB, PORT: API_PORT },
      url: `http://localhost:${API_PORT}/api/health`,
      timeout: 180_000,
      reuseExistingServer: !!process.env.UI_REUSE,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      env: { API_URL: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !!process.env.UI_REUSE,
    },
  ],
})
