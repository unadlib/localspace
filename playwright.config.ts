import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(rootDir, 'test', 'playwright'),
  timeout: 30 * 1000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: process.env.CI ? 1 : undefined,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'on-first-retry',
    baseURL: 'http://localhost:3333',
  },
  reporter: [['list']],
  webServer: {
    command: `npx serve -l 3333 "${rootDir}"`,
    url: 'http://localhost:3333',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
  },
});
