import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8toIstanbul from 'v8-to-istanbul';

const COVERAGE_ENV = process.env.PLAYWRIGHT_COVERAGE === '1';
const WORKSPACE_ROOT = path.resolve(process.cwd());
const COVERAGE_DIR = path.join(WORKSPACE_ROOT, '.nyc_output');
const SOURCE_ROOT = path.join(WORKSPACE_ROOT, 'src');
const LOCALSPACE_BROWSER_BUNDLES = new Set([
  path.join(WORKSPACE_ROOT, 'dist', 'index.esm.js'),
  path.join(WORKSPACE_ROOT, 'dist', 'index.umd.js'),
]);

const randomId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(8).toString('hex');

const sanitizeFileName = (value: string) =>
  value.replace(/[^a-zA-Z0-9.-]+/g, '_') || `anonymous_${randomId()}`;

const isWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

const resolveServedPath = (pathname: string): string | null => {
  const candidate = path.resolve(WORKSPACE_ROOT, pathname.replace(/^\/+/, ''));
  return isWithin(candidate, WORKSPACE_ROOT) ? candidate : null;
};

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
      const scriptPath = resolveServedPath(decodeURIComponent(parsed.pathname));
      return scriptPath ?? parsed.href;
    } catch {
      return url;
    }
  }

  return url;
};

const isLocalSpaceSource = (fileName: string): boolean => {
  if (fileName.startsWith('file://')) {
    return isWithin(fileURLToPath(fileName), SOURCE_ROOT);
  }

  if (!path.isAbsolute(fileName)) {
    return isWithin(path.resolve(WORKSPACE_ROOT, fileName), SOURCE_ROOT);
  }

  return isWithin(fileName, SOURCE_ROOT);
};

type CoverageEntry = Awaited<
  ReturnType<Page['coverage']['stopJSCoverage']>
>[number];

async function persistCoverage(entries: CoverageEntry[]): Promise<void> {
  const localSpaceEntries = entries
    .map((entry) => ({
      entry,
      scriptPath: normalizeScriptUrl(entry.url),
    }))
    .filter(
      (candidate): candidate is { entry: CoverageEntry; scriptPath: string } =>
        candidate.scriptPath !== null &&
        LOCALSPACE_BROWSER_BUNDLES.has(candidate.scriptPath)
    );

  if (localSpaceEntries.length === 0) {
    return;
  }

  await fs.mkdir(COVERAGE_DIR, { recursive: true });

  for (const { entry, scriptPath } of localSpaceEntries) {
    if (!entry.functions?.length) {
      throw new Error(
        `[playwright-coverage] LocalSpace bundle has no V8 function coverage: ${entry.url}`
      );
    }

    try {
      const converter = v8toIstanbul(scriptPath, 0, {
        source: entry.source,
      });
      await converter.load();
      converter.applyCoverage(entry.functions);
      const istanbulCoverage = converter.toIstanbul();
      if (!Object.keys(istanbulCoverage).some(isLocalSpaceSource)) {
        throw new Error(
          `source map for ${entry.url} did not resolve to the local src directory`
        );
      }
      const fileName = `${sanitizeFileName(scriptPath)}-${randomId()}.json`;
      await fs.writeFile(
        path.join(COVERAGE_DIR, fileName),
        JSON.stringify(istanbulCoverage),
        'utf-8'
      );
    } catch (error) {
      const coverageError = new Error(
        `[playwright-coverage] Failed to map LocalSpace bundle coverage: ${entry.url}`
      );
      (coverageError as Error & { cause?: unknown }).cause = error;
      throw coverageError;
    }
  }
}

const coverageAwareTest = COVERAGE_ENV
  ? base.extend({
      page: async ({ page }, use) => {
        await page.coverage.startJSCoverage();

        await use(page);

        const coverage = await page.coverage.stopJSCoverage();
        await persistCoverage(coverage);
      },
    })
  : base;

export const test = coverageAwareTest;
export const expect = coverageAwareTest.expect;
