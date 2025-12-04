import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8toIstanbul from 'v8-to-istanbul';

const COVERAGE_ENV = process.env.PLAYWRIGHT_COVERAGE === '1';
const COVERAGE_DIR = path.join(process.cwd(), '.nyc_output');
let warnedCoverageUnavailable = false;

const randomId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(8).toString('hex');

const sanitizeFileName = (value: string) =>
  value.replace(/[^a-zA-Z0-9.-]+/g, '_') || `anonymous_${randomId()}`;

const normalizeScriptUrl = (url?: string): string | null => {
  if (!url) {
    return null;
  }

  if (url.startsWith('file://')) {
    return fileURLToPath(url);
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return decodeURIComponent(parsed.pathname) || parsed.href;
    } catch {
      return url;
    }
  }

  return url;
};

type CoverageEntry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number];

async function persistCoverage(entries: CoverageEntry[]): Promise<void> {
  if (!entries.length) {
    return;
  }

  await fs.mkdir(COVERAGE_DIR, { recursive: true });

  for (const entry of entries) {
    if (!entry.functions?.length) {
      continue;
    }

    const scriptPath = normalizeScriptUrl(entry.url) ?? `anonymous://${randomId()}`;
    try {
      const converter = v8toIstanbul(scriptPath, 0, {
        source: entry.source,
      });
      await converter.load();
      converter.applyCoverage(entry.functions);
      const istanbulCoverage = converter.toIstanbul();
      const fileName = `${sanitizeFileName(scriptPath)}-${randomId()}.json`;
      await fs.writeFile(
        path.join(COVERAGE_DIR, fileName),
        JSON.stringify(istanbulCoverage),
        'utf-8',
      );
    } catch (error) {
      if (!warnedCoverageUnavailable) {
        console.warn(
          '[playwright-coverage] Failed to process coverage entry. Subsequent errors will be suppressed.',
          error,
        );
        warnedCoverageUnavailable = true;
      }
    }
  }
}

const coverageAwareTest = COVERAGE_ENV
  ? base.extend({
      page: async ({ page }, use) => {
        let collecting = false;
        if (COVERAGE_ENV) {
          try {
            await page.coverage.startJSCoverage({ reportAnonymousScripts: true });
            collecting = true;
          } catch (error) {
            if (!warnedCoverageUnavailable) {
              console.warn(
                '[playwright-coverage] Unable to start V8 coverage collection. Subsequent warnings will be suppressed.',
                error,
              );
              warnedCoverageUnavailable = true;
            }
          }
        }

        await use(page);

        if (collecting) {
          try {
            const coverage = await page.coverage.stopJSCoverage();
            await persistCoverage(coverage);
          } catch (error) {
            if (!warnedCoverageUnavailable) {
              console.warn(
                '[playwright-coverage] Unable to stop V8 coverage collection. Subsequent warnings will be suppressed.',
                error,
              );
              warnedCoverageUnavailable = true;
            }
          }
        }
      },
    })
  : base;

export const test = coverageAwareTest;
export const expect = coverageAwareTest.expect;
