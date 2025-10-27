import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(rootDir, 'test', 'playwright'),
  timeout: 30 * 1000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 5,
  workers: process.env.CI ? 1 : undefined,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'on-first-retry',
  },
  reporter: [['list']],
});
