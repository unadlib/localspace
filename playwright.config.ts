import {
  defineConfig,
  devices,
  type PlaywrightTestConfig,
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const sharedPlaywrightConfig = {
  testDir: path.join(rootDir, 'test', 'playwright'),
  timeout: 30 * 1000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // CI treats a first-attempt failure as a release signal. Local retries remain
  // useful for collecting traces while diagnosing workstation-only failures.
  retries: process.env.CI ? 0 : 2,
  workers: process.env.CI ? 1 : undefined,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'on-first-retry',
    baseURL: 'http://localhost:3333',
  },
  reporter: [['list']],
  webServer: {
    command: `pnpm exec serve -l 3333 "${rootDir}"`,
    url: 'http://localhost:3333',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
  },
} satisfies PlaywrightTestConfig;

export const supportedBrowserProjects = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
  },
  {
    name: 'webkit',
    use: { ...devices['Desktop Safari'] },
  },
] satisfies NonNullable<PlaywrightTestConfig['projects']>;

export default defineConfig({
  ...sharedPlaywrightConfig,
  projects: supportedBrowserProjects,
  testIgnore: '**/*benchmark.spec.ts',
});
