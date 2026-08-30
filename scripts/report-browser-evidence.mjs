import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import process from 'node:process';
import { chromium, firefox, webkit } from '@playwright/test';

const browserTypes = { chromium, firefox, webkit };
const requestedBrowser = process.argv[2];

assert.ok(
  Object.hasOwn(browserTypes, requestedBrowser),
  'Usage: node scripts/report-browser-evidence.mjs <chromium|firefox|webkit>'
);

const require = createRequire(import.meta.url);
const playwrightVersion = require('@playwright/test/package.json').version;
const browserType = browserTypes[requestedBrowser];
const browser = await browserType.launch({ headless: true });

try {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: requestedBrowser,
        playwrightVersion,
        engineVersion: browser.version(),
      },
      null,
      2
    )}\n`
  );
} finally {
  await browser.close();
}
