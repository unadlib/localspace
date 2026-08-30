import { defineConfig } from '@playwright/test';
import {
  sharedPlaywrightConfig,
  supportedBrowserProjects,
} from './playwright.config';

export default defineConfig({
  ...sharedPlaywrightConfig,
  // Performance baselines remain Chromium-specific and are not support tests.
  projects: supportedBrowserProjects.filter(({ name }) => name === 'chromium'),
  testMatch: '**/*benchmark.spec.ts',
});
