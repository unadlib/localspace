import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(path.resolve(scriptDirectory, '..'));
const baselinePath = path.join(
  repositoryRoot,
  'benchmarks',
  'baselines',
  'v2.1.0.json'
);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const parseArguments = (arguments_) => {
  const options = {
    output: undefined,
    samples: baseline.contract.samples,
    warmups: baseline.contract.warmups,
    skipBuild: false,
    skipLegacyProbes: false,
  };

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--output') {
      options.output = arguments_[++index];
    } else if (argument === '--samples') {
      options.samples = Number(arguments_[++index]);
    } else if (argument === '--warmups') {
      options.warmups = Number(arguments_[++index]);
    } else if (argument === '--skip-build') {
      options.skipBuild = true;
    } else if (argument === '--skip-legacy-probes') {
      options.skipLegacyProbes = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  for (const [name, value] of [
    ['samples', options.samples],
    ['warmups', options.warmups],
  ]) {
    if (!Number.isSafeInteger(value) || value < (name === 'samples' ? 1 : 0)) {
      throw new Error(`--${name} must be a valid non-negative sample count.`);
    }
  }
  return options;
};

const options = parseArguments(process.argv.slice(2));

const run = (command, arguments_, commandOptions = {}) => {
  const result = spawnSync(command, arguments_, {
    cwd: commandOptions.cwd ?? repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(commandOptions.env ?? {}) },
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${output ? `:\n${output}` : ''}`
    );
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const parsePackResult = (stdout) => {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result || !Array.isArray(result.files)) {
    throw new Error('npm pack did not return a file manifest.');
  }
  return result;
};

const summarizePack = (result) => {
  const groups = {};
  for (const file of result.files) {
    const group = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
    const current = groups[group] ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += file.size;
    groups[group] = current;
  }
  return {
    version: result.version,
    integrity: result.integrity,
    shasum: result.shasum,
    entryCount: result.entryCount,
    packedBytes: result.size,
    unpackedBytes: result.unpackedSize,
    groups,
  };
};

const assertPublishedBaseline = (pack) => {
  const expected = baseline.package;
  for (const [field, actual] of [
    ['version', pack.version],
    ['integrity', pack.integrity],
    ['shasum', pack.shasum],
    ['entryCount', pack.entryCount],
    ['packedBytes', pack.size],
    ['unpackedBytes', pack.unpackedSize],
  ]) {
    if (actual !== expected[field]) {
      throw new Error(
        `Published baseline ${field} mismatch: expected ${expected[field]}, received ${actual}.`
      );
    }
  }
};

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const flattenNumbers = (value, prefix = '', output = {}) => {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'number') {
      output[name] = child;
    } else if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenNumbers(child, name, output);
    }
  }
  return output;
};

const summarizeSamples = (samples) => {
  const metrics = {};
  for (const sample of samples) {
    const flattened = flattenNumbers(sample);
    for (const [name, value] of Object.entries(flattened)) {
      (metrics[name] ??= []).push(value);
    }
  }
  return Object.fromEntries(
    Object.entries(metrics).map(([name, values]) => [
      name,
      {
        median: percentile(values, 0.5),
        p25: percentile(values, 0.25),
        p75: percentile(values, 0.75),
        min: Math.min(...values),
        max: Math.max(...values),
      },
    ])
  );
};

const createRatios = (baselineSummary, candidateSummary) =>
  Object.fromEntries(
    Object.keys(baselineSummary)
      .filter((name) => candidateSummary[name])
      .map((name) => {
        const baselineMedian = baselineSummary[name].median;
        const candidateMedian = candidateSummary[name].median;
        return [
          name,
          {
            candidateToBaseline:
              baselineMedian === 0 ? null : candidateMedian / baselineMedian,
            percentChange:
              baselineMedian === 0
                ? null
                : ((candidateMedian - baselineMedian) / baselineMedian) * 100,
          },
        ];
      })
  );

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

const startServer = async (roots) => {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>LocalSpace benchmark</title>');
        return;
      }

      const match = Object.entries(roots).find(([prefix]) =>
        requestUrl.pathname.startsWith(`/${prefix}/`)
      );
      if (!match) {
        response.writeHead(404).end();
        return;
      }
      const [prefix, root] = match;
      const relative = decodeURIComponent(
        requestUrl.pathname.slice(prefix.length + 2)
      );
      const resolved = path.resolve(root, relative);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type':
          contentTypes.get(path.extname(resolved)) ??
          'application/octet-stream',
      });
      response.end(readFileSync(resolved));
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve benchmark server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const measureInBrowser = async ({
  origin,
  samples,
  warmups,
  includeLegacy,
}) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const browserVersion = browser.version();
    const measurements = await page.evaluate(
      async ({
        baselineUrl,
        candidateUrl,
        contract,
        samples,
        warmups,
        includeLegacy,
      }) => {
        const imported = {
          baseline: await import(baselineUrl),
          candidate: await import(candidateUrl),
        };
        imported.baseline.setDeprecationWarnings?.(false);
        imported.candidate.setDeprecationWarnings?.(false);

        let namespaceCounter = 0;
        const nextNamespace = (label, scenario, sample) => ({
          name: `localspace-benchmark-${label}-${scenario}-${sample}-${namespaceCounter++}`,
          storeName: 'store',
        });
        const payload = 'x'.repeat(contract.main.payloadBytes);
        const items = Array.from(
          { length: contract.main.itemCount },
          (_, index) => ({ key: `key-${index}`, value: `${payload}-${index}` })
        );
        const keys = items.map((entry) => entry.key);

        const prepare = async (api, options) => {
          const instance = api.createInstance(options);
          await instance.setDriver([instance.INDEXEDDB]);
          return instance;
        };
        const cleanup = async (instance) => {
          await instance.dropInstance();
          if (typeof instance.close === 'function') await instance.close();
        };

        const measureMain = async (api, label, sample) => {
          const instance = await prepare(api, {
            ...nextNamespace(label, 'main', sample),
            maxBatchSize: contract.main.maxBatchSize,
          });
          const readyStarted = performance.now();
          await instance.ready();
          const readyMs = performance.now() - readyStarted;
          await instance.clear();

          const singleSetStarted = performance.now();
          for (const entry of items)
            await instance.setItem(entry.key, entry.value);
          const singleSetMs = performance.now() - singleSetStarted;

          let readCount = 0;
          const singleGetStarted = performance.now();
          for (const key of keys) {
            if ((await instance.getItem(key)) !== null) readCount += 1;
          }
          const singleGetMs = performance.now() - singleGetStarted;

          let iterateCount = 0;
          const iterateStarted = performance.now();
          await instance.iterate((_value, _key, iterationNumber) => {
            iterateCount = iterationNumber;
          });
          const iterateMs = performance.now() - iterateStarted;
          if (readCount !== items.length || iterateCount !== items.length) {
            throw new Error(
              `${label} single-item benchmark failed correctness checks.`
            );
          }

          await instance.clear();
          const batchSetStarted = performance.now();
          const setResult = await instance.setItems(items);
          const batchSetMs = performance.now() - batchSetStarted;
          const batchGetStarted = performance.now();
          const getResult = await instance.getItems(keys);
          const batchGetMs = performance.now() - batchGetStarted;
          const batchRemoveStarted = performance.now();
          await instance.removeItems(keys);
          const batchRemoveMs = performance.now() - batchRemoveStarted;
          if (
            setResult.length !== items.length ||
            getResult.length !== items.length
          ) {
            throw new Error(
              `${label} batch benchmark failed correctness checks.`
            );
          }

          const transactionItems = items.slice(
            0,
            contract.main.transactionCount
          );
          const transactionStarted = performance.now();
          const transactionReads = await instance.runTransaction(
            'readwrite',
            async (transaction) => {
              for (const entry of transactionItems) {
                await transaction.set(entry.key, entry.value);
              }
              let count = 0;
              for (const entry of transactionItems) {
                if ((await transaction.get(entry.key)) !== null) count += 1;
              }
              return count;
            }
          );
          const transactionMs = performance.now() - transactionStarted;
          if (transactionReads !== transactionItems.length) {
            throw new Error(
              `${label} transaction benchmark failed correctness checks.`
            );
          }

          await cleanup(instance);
          return {
            readyMs,
            single: { setMs: singleSetMs, getMs: singleGetMs, iterateMs },
            batch: {
              setMs: batchSetMs,
              getMs: batchGetMs,
              removeMs: batchRemoveMs,
            },
            transactionMs,
          };
        };

        const measureReady = async (api, label, sample, prewarm) => {
          const instance = await prepare(api, {
            ...nextNamespace(label, `prewarm-${prewarm}`, sample),
            prewarmTransactions: prewarm,
          });
          const started = performance.now();
          await instance.ready();
          const duration = performance.now() - started;
          await cleanup(instance);
          return duration;
        };

        const measureConcurrent = async (api, label, sample, maximum) => {
          const instance = await prepare(api, {
            ...nextNamespace(label, `concurrency-${maximum}`, sample),
            maxConcurrentTransactions: maximum,
          });
          await instance.ready();
          const count = contract.legacyFeatureProbes.concurrencyCount;
          const started = performance.now();
          await Promise.all(
            Array.from({ length: count }, (_, index) =>
              instance.setItem(`concurrent-${index}`, index)
            )
          );
          const duration = performance.now() - started;
          if ((await instance.length()) !== count) {
            throw new Error(
              `${label} concurrency benchmark failed correctness checks.`
            );
          }
          await cleanup(instance);
          return duration;
        };

        const measureIdleReopen = async (api, label, sample) => {
          const probe = contract.legacyFeatureProbes;
          const instance = await prepare(api, {
            ...nextNamespace(label, 'idle-reopen', sample),
            connectionIdleMs: probe.idleMs,
          });
          await instance.ready();
          await new Promise((resolve) => setTimeout(resolve, probe.idleWaitMs));
          const started = performance.now();
          await instance.setItem('after-idle', 'value');
          const duration = performance.now() - started;
          await cleanup(instance);
          return duration;
        };

        const measure = async (module, label, sample) => {
          const api = module.default;
          const main = await measureMain(api, label, sample);
          if (!includeLegacy) return { main };
          return {
            main,
            legacy: {
              prewarmOffReadyMs: await measureReady(api, label, sample, false),
              prewarmOnReadyMs: await measureReady(api, label, sample, true),
              unlimitedConcurrencyMs: await measureConcurrent(
                api,
                label,
                sample,
                0
              ),
              cappedConcurrencyMs: await measureConcurrent(
                api,
                label,
                sample,
                1
              ),
              idleReopenMs: await measureIdleReopen(api, label, sample),
            },
          };
        };

        const results = { baseline: [], candidate: [] };
        for (let sample = -warmups; sample < samples; sample++) {
          const order =
            sample % 2 === 0
              ? ['baseline', 'candidate']
              : ['candidate', 'baseline'];
          const current = {};
          for (const label of order) {
            current[label] = await measure(imported[label], label, sample);
          }
          if (sample >= 0) {
            results.baseline.push(current.baseline);
            results.candidate.push(current.candidate);
          }
        }
        return results;
      },
      {
        baselineUrl: `${origin}/baseline/dist/index.esm.js?baseline=2.1.0`,
        candidateUrl: `${origin}/candidate/dist/index.esm.js?candidate=worktree`,
        contract: baseline.contract,
        samples,
        warmups,
        includeLegacy,
      }
    );
    return { browserVersion, measurements };
  } finally {
    await browser.close();
  }
};

const formatBytes = (bytes) => {
  const units = ['B', 'KiB', 'MiB'];
  let value = bytes;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(2)} ${unit}`;
};

const printComparison = (result) => {
  console.log(
    `Baseline: ${baseline.package.specifier} (${baseline.source.gitCommit})`
  );
  console.log(
    `Candidate: ${result.candidate.gitCommit}${result.candidate.dirty ? ' (dirty)' : ''}`
  );
  console.log(
    `Environment: Node ${result.environment.node}, Chromium ${result.environment.chromium}, ${result.environment.platform}/${result.environment.arch}`
  );
  console.log(
    `Samples: ${result.contract.samples} (+${result.contract.warmups} warmup)`
  );
  console.log('Duration medians (candidate / baseline; lower is faster):');
  for (const [name, ratio] of Object.entries(result.ratios)) {
    const baselineMedian = result.performance.baseline[name].median;
    const candidateMedian = result.performance.candidate[name].median;
    console.log(
      `  ${name}: ${candidateMedian.toFixed(2)}ms / ${baselineMedian.toFixed(2)}ms = ${ratio.candidateToBaseline.toFixed(3)} (${ratio.percentChange >= 0 ? '+' : ''}${ratio.percentChange.toFixed(1)}%)`
    );
  }
  console.log('Package artifact:');
  console.log(
    `  packed: ${formatBytes(result.package.candidate.packedBytes)} / ${formatBytes(result.package.baseline.packedBytes)}`
  );
  console.log(
    `  unpacked: ${formatBytes(result.package.candidate.unpackedBytes)} / ${formatBytes(result.package.baseline.unpackedBytes)}`
  );
  console.log(
    `  files: ${result.package.candidate.entryCount} / ${result.package.baseline.entryCount}`
  );
};

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'localspace-2.1-baseline-')
);
let server;
try {
  if (!options.skipBuild) {
    console.log('Building candidate production bundles...');
    run('pnpm', ['run', 'build']);
  }
  const candidateBundle = path.join(repositoryRoot, 'dist', 'index.esm.js');
  if (!statSync(candidateBundle).isFile()) {
    throw new Error(
      'Candidate dist/index.esm.js is missing; run without --skip-build.'
    );
  }

  const packedDirectory = path.join(temporaryRoot, 'packed');
  const extractedDirectory = path.join(temporaryRoot, 'extracted');
  mkdirSync(packedDirectory, { recursive: true });
  mkdirSync(extractedDirectory, { recursive: true });
  console.log(`Fetching and verifying ${baseline.package.specifier}...`);
  const publishedPack = parsePackResult(
    run('npm', [
      'pack',
      baseline.package.specifier,
      '--json',
      '--pack-destination',
      packedDirectory,
    ]).stdout
  );
  assertPublishedBaseline(publishedPack);
  run('tar', [
    '-xzf',
    path.join(packedDirectory, publishedPack.filename),
    '-C',
    extractedDirectory,
  ]);
  const publishedRoot = realpathSync(path.join(extractedDirectory, 'package'));

  const candidatePack = parsePackResult(
    run('npm', ['pack', '--dry-run', '--json']).stdout
  );
  server = await startServer({
    baseline: publishedRoot,
    candidate: repositoryRoot,
  });
  console.log('Running interleaved IndexedDB measurements...');
  const browserResult = await measureInBrowser({
    origin: server.origin,
    samples: options.samples,
    warmups: options.warmups,
    includeLegacy: !options.skipLegacyProbes,
  });

  const baselineSummary = summarizeSamples(browserResult.measurements.baseline);
  const candidateSummary = summarizeSamples(
    browserResult.measurements.candidate
  );
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: {
      id: baseline.id,
      gitRef: baseline.source.gitRef,
      gitCommit: baseline.source.gitCommit,
      npm: baseline.package.specifier,
    },
    candidate: {
      gitCommit: run('git', ['rev-parse', 'HEAD']).stdout,
      dirty: run('git', ['status', '--porcelain']).stdout.length > 0,
      packageVersion: candidatePack.version,
    },
    environment: {
      node: process.version,
      playwright: JSON.parse(
        readFileSync(
          path.join(
            repositoryRoot,
            'node_modules',
            '@playwright',
            'test',
            'package.json'
          ),
          'utf8'
        )
      ).version,
      chromium: browserResult.browserVersion,
      platform: process.platform,
      arch: process.arch,
    },
    contract: {
      ...baseline.contract,
      samples: options.samples,
      warmups: options.warmups,
      legacyFeatureProbes: options.skipLegacyProbes
        ? null
        : baseline.contract.legacyFeatureProbes,
    },
    performance: {
      baseline: baselineSummary,
      candidate: candidateSummary,
      raw: browserResult.measurements,
    },
    ratios: createRatios(baselineSummary, candidateSummary),
    package: {
      baseline: summarizePack(publishedPack),
      candidate: summarizePack(candidatePack),
    },
  };

  printComparison(result);
  if (options.output) {
    const outputPath = path.resolve(repositoryRoot, options.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Full result written to ${outputPath}`);
  }
} finally {
  if (server) await server.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
