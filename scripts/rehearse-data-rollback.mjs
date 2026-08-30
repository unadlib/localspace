import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(path.resolve(scriptDirectory, '..'));
const contractPath = path.join(
  repositoryRoot,
  'test',
  'release-rollback-contract.json'
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

const parseArguments = (arguments_) => {
  const options = {
    output: undefined,
    requirePublished: false,
    skipCandidateBuild: false,
  };

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--output') {
      options.output = arguments_[++index];
      if (!options.output) throw new Error('--output requires a path.');
    } else if (argument === '--require-published') {
      options.requirePublished = true;
    } else if (argument === '--skip-candidate-build') {
      options.skipCandidateBuild = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
};

const options = parseArguments(process.argv.slice(2));

assert.equal(contract.schemaVersion, 1);
assert.match(contract.bridge.sourceCommit, /^[a-f0-9]{40}$/);
assert.equal(typeof contract.bridge.sourcePackageVersion, 'string');
assert.equal(typeof contract.bridge.requiredPublishedVersion, 'string');
assert.equal(typeof contract.candidateVersion, 'string');

const publicationConfigured =
  typeof contract.bridge.publishedVersion === 'string' &&
  typeof contract.bridge.publishedIntegrity === 'string';

if (options.requirePublished && !publicationConfigured) {
  throw new Error(
    `The release rollback gate requires published localspace@${contract.bridge.requiredPublishedVersion}, but test/release-rollback-contract.json still identifies only the local git bridge. Publish and pin the bridge version/integrity before publishing 3.0.`
  );
}

if (publicationConfigured) {
  assert.equal(
    contract.bridge.publishedVersion,
    contract.bridge.requiredPublishedVersion,
    'The pinned published bridge must match requiredPublishedVersion.'
  );
  assert.match(contract.bridge.publishedIntegrity, /^sha512-[A-Za-z0-9+/]+=*$/);
}

const commandName = (name) =>
  process.platform === 'win32' ? `${name}.cmd` : name;

const cleanNpmEnvironment = (overrides = {}) => {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (/^npm_/i.test(key)) delete environment[key];
  }
  return environment;
};

const run = (command, arguments_, commandOptions = {}) => {
  const result = spawnSync(command, arguments_, {
    cwd: commandOptions.cwd ?? repositoryRoot,
    encoding:
      commandOptions.encoding === undefined ? 'utf8' : commandOptions.encoding,
    env: commandOptions.cleanNpmEnvironment
      ? cleanNpmEnvironment(commandOptions.env)
      : { ...process.env, ...(commandOptions.env ?? {}) },
    input: commandOptions.input,
    maxBuffer: 512 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .map(String)
      .join('\n');
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${output ? `:\n${output}` : ''}`
    );
  }
  return result;
};

const parsePackResult = (stdout) => {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(result && typeof result.filename === 'string');
  assert.equal(typeof result.integrity, 'string');
  assert.equal(typeof result.shasum, 'string');
  return result;
};

const sha512Integrity = (file) =>
  `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

const packWorkspace = (packageRoot, destination) =>
  parsePackResult(
    run(
      commandName('npm'),
      ['pack', '--json', '--pack-destination', destination],
      { cwd: packageRoot, cleanNpmEnvironment: true }
    ).stdout
  );

const packPublishedBridge = (destination) => {
  const specifier = `localspace@${contract.bridge.publishedVersion}`;
  const pack = parsePackResult(
    run(
      commandName('npm'),
      ['pack', specifier, '--json', '--pack-destination', destination],
      { cleanNpmEnvironment: true }
    ).stdout
  );
  assert.equal(pack.version, contract.bridge.publishedVersion);
  assert.equal(
    pack.integrity,
    contract.bridge.publishedIntegrity,
    'Published bridge registry integrity changed.'
  );
  return pack;
};

const extractPackage = (tarball, destination) => {
  mkdirSync(destination);
  run('tar', ['-xzf', tarball, '-C', destination]);
  const packageRoot = path.join(destination, 'package');
  assert.ok(existsSync(path.join(packageRoot, 'package.json')));
  return packageRoot;
};

const archiveBridgeSource = (destination) => {
  mkdirSync(destination);
  const archive = run(
    'git',
    ['archive', '--format=tar', contract.bridge.sourceCommit],
    { encoding: null }
  );
  run('tar', ['-xf', '-', '-C', destination], {
    input: archive.stdout,
    encoding: null,
  });

  const archivedPackage = JSON.parse(
    readFileSync(path.join(destination, 'package.json'), 'utf8')
  );
  assert.equal(archivedPackage.name, 'localspace');
  assert.equal(
    archivedPackage.version,
    contract.bridge.sourcePackageVersion,
    'Bridge source package version changed at the pinned commit.'
  );
};

const buildLocalBridge = (bridgeSource, packDirectory) => {
  archiveBridgeSource(bridgeSource);
  run(
    commandName('pnpm'),
    [
      '--filter',
      'localspace',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ],
    { cwd: bridgeSource, cleanNpmEnvironment: true }
  );
  run(commandName('pnpm'), ['run', 'build'], { cwd: bridgeSource });
  return packWorkspace(bridgeSource, packDirectory);
};

const readPackageVersion = (packageRoot) =>
  JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    .version;

const startOrigin = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>rollback</title>'
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const loadBundle = async (context, origin, bundle) => {
  const page = await context.newPage();
  await page.goto(origin);
  await page.addScriptTag({ path: bundle });
  const hasApi = await page.evaluate(
    () => typeof globalThis.Localspace?.LocalSpace === 'function'
  );
  assert.equal(hasApi, true, `UMD API was not exposed by ${bundle}.`);
  return page;
};

const bridgeWriteLegacy = async (page, fixture) =>
  page.evaluate(
    async ({ fixture: phaseFixture }) => {
      const api = globalThis.Localspace;
      const fail = (message) => {
        throw new Error(message);
      };
      const core = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.coreStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await core.ready();
      await core.setItems([
        {
          key: 'legacy-object',
          value: {
            source: '2.1-bridge',
            nested: [null, true, 42, 'legacy'],
          },
        },
        {
          key: 'legacy-marker-like',
          value: {
            __localspace__: {
              namespace: 'application.record',
              version: 1,
            },
            payload: {
              codec: 'localspace.storage-value',
              data: 'application-value',
            },
          },
        },
        { key: 'legacy-null', value: null },
      ]);
      await core.setItem('legacy-bytes', new Uint8Array([0, 1, 127, 255]));
      if ((await core.length()) !== 4) fail('Bridge legacy core write failed.');
      await core.close();

      const defaultNamespace = new api.LocalSpace({
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await defaultNamespace.ready();
      await defaultNamespace.setItem('legacy-default-namespace', {
        source: '2.1-bridge',
        namespace: 'localforage/keyvaluepairs',
      });
      await defaultNamespace.close();

      const plugins = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.pluginStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
        plugins: [
          api.ttlPlugin({ defaultTTL: 60 * 60 * 1000 }),
          api.compressionPlugin({ threshold: 0 }),
          api.encryptionPlugin({
            key: '0123456789abcdef0123456789abcdef',
          }),
        ],
      });
      await plugins.ready();
      const legacyPluginValue = {
        source: '2.1-bridge',
        message: 'legacy-plugin-value',
        compressible: 'bridge-compressible-'.repeat(256),
      };
      await plugins.setItem('legacy-plugin', legacyPluginValue);
      const readBack = await plugins.getItem('legacy-plugin');
      if (JSON.stringify(readBack) !== JSON.stringify(legacyPluginValue)) {
        fail('Bridge could not read its legacy plugin write.');
      }
      await plugins.close();
      return {
        coreEntries: 4,
        defaultNamespaceEntries: 1,
        pluginEntries: 1,
      };
    },
    { fixture }
  );

const candidateReadAndWrite = async (page, fixture) =>
  page.evaluate(
    async ({ fixture: phaseFixture }) => {
      const api = globalThis.Localspace;
      const fail = (message) => {
        throw new Error(message);
      };
      const canonical = (value) => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && Object.getPrototypeOf(value) === Object.prototype) {
          return Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])])
          );
        }
        return value;
      };
      const same = (actual, expected, message) => {
        if (
          JSON.stringify(canonical(actual)) !==
          JSON.stringify(canonical(expected))
        ) {
          fail(
            `${message} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
          );
        }
      };
      const core = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.coreStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await core.ready();
      same(
        await core.getItem('legacy-object'),
        {
          source: '2.1-bridge',
          nested: [null, true, 42, 'legacy'],
        },
        '3.0 could not read the bridge core value.'
      );
      same(
        await core.getItem('legacy-marker-like'),
        {
          __localspace__: {
            namespace: 'application.record',
            version: 1,
          },
          payload: {
            codec: 'localspace.storage-value',
            data: 'application-value',
          },
        },
        '3.0 mistook an unrelated legacy marker-like value for a core record.'
      );
      if ((await core.getItem('legacy-null')) !== null) {
        fail('3.0 could not read the bridge null value.');
      }
      const legacyBytes = await core.getItem('legacy-bytes');
      if (
        Object.prototype.toString.call(legacyBytes) !== '[object Uint8Array]' ||
        [...legacyBytes].join(',') !== '0,1,127,255'
      ) {
        fail('3.0 could not read the bridge typed array.');
      }

      const markerValue = {
        __localspace__: {
          namespace: 'localspace.record',
          version: 1,
        },
        payload: {
          codec: 'localspace.storage-value',
          data: '3.0-application-value',
        },
      };
      await core.setItems([
        {
          key: 'v3-object',
          value: {
            source: '3.0-candidate',
            nested: [null, false, 84, 'candidate'],
          },
        },
        { key: 'v3-marker', value: markerValue },
        { key: 'v3-null', value: null },
      ]);
      await core.setItem('v3-bytes', new Uint16Array([1, 256, 65535]));
      await core.close();

      const defaultNamespace = new api.LocalSpace({
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await defaultNamespace.ready();
      same(
        await defaultNamespace.getItem('legacy-default-namespace'),
        {
          source: '2.1-bridge',
          namespace: 'localforage/keyvaluepairs',
        },
        '3.0 did not reopen the bridge default namespace.'
      );
      await defaultNamespace.setItem('v3-default-namespace', {
        source: '3.0-candidate',
        namespace: 'localforage/keyvaluepairs',
      });
      await defaultNamespace.close();

      const plugins = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.pluginStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
        plugins: [
          api.ttlPlugin({ defaultTTL: 60 * 60 * 1000 }),
          api.compressionPlugin({ threshold: 0 }),
          api.encryptionPlugin({
            key: '0123456789abcdef0123456789abcdef',
          }),
        ],
      });
      await plugins.ready();
      const expectedLegacyPlugin = {
        source: '2.1-bridge',
        message: 'legacy-plugin-value',
        compressible: 'bridge-compressible-'.repeat(256),
      };
      same(
        await plugins.getItem('legacy-plugin'),
        expectedLegacyPlugin,
        '3.0 could not read the bridge TTL/compression/encryption pipeline.'
      );
      const candidatePluginValue = {
        source: '3.0-candidate',
        message: 'candidate-plugin-value',
        compressible: 'candidate-compressible-'.repeat(256),
      };
      await plugins.setItem('v3-plugin', candidatePluginValue);
      same(
        await plugins.getItem('v3-plugin'),
        candidatePluginValue,
        '3.0 could not read its plugin write.'
      );
      await plugins.close();

      const unknownRecord = {
        __localspace__: {
          namespace: 'localspace.record',
          version: 999,
        },
        payload: {
          codec: 'localspace.storage-value',
          data: 'must-not-be-rewritten',
        },
      };
      await new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(phaseFixture.databaseName);
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const transaction = database.transaction(
            phaseFixture.coreStoreName,
            'readwrite'
          );
          transaction
            .objectStore(phaseFixture.coreStoreName)
            .put(unknownRecord, 'unknown-version');
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        };
      });

      return {
        legacyCoreRead: 4,
        legacyDefaultNamespaceRead: 1,
        legacyPluginRead: 1,
        candidateCoreWritten: 4,
        candidateDefaultNamespaceWritten: 1,
        candidatePluginWritten: 1,
        unknownVersionInjected: true,
      };
    },
    { fixture }
  );

const bridgeReadCandidate = async (page, fixture) =>
  page.evaluate(
    async ({ fixture: phaseFixture }) => {
      const api = globalThis.Localspace;
      const fail = (message) => {
        throw new Error(message);
      };
      const canonical = (value) => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && Object.getPrototypeOf(value) === Object.prototype) {
          return Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])])
          );
        }
        return value;
      };
      const same = (actual, expected, message) => {
        if (
          JSON.stringify(canonical(actual)) !==
          JSON.stringify(canonical(expected))
        ) {
          fail(
            `${message} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
          );
        }
      };
      const readRaw = () =>
        new Promise((resolve, reject) => {
          const openRequest = indexedDB.open(phaseFixture.databaseName);
          openRequest.onerror = () => reject(openRequest.error);
          openRequest.onsuccess = () => {
            const database = openRequest.result;
            const request = database
              .transaction(phaseFixture.coreStoreName, 'readonly')
              .objectStore(phaseFixture.coreStoreName)
              .get('unknown-version');
            request.onsuccess = () => {
              const value = request.result;
              database.close();
              resolve(value);
            };
            request.onerror = () => reject(request.error);
          };
        });

      const core = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.coreStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await core.ready();
      same(
        await core.getItem('v3-object'),
        {
          source: '3.0-candidate',
          nested: [null, false, 84, 'candidate'],
        },
        'Bridge could not read the 3.0 core record.'
      );
      same(
        await core.getItem('v3-marker'),
        {
          __localspace__: {
            namespace: 'localspace.record',
            version: 1,
          },
          payload: {
            codec: 'localspace.storage-value',
            data: '3.0-application-value',
          },
        },
        'Bridge did not preserve the nested marker-shaped application value.'
      );
      if ((await core.getItem('v3-null')) !== null) {
        fail('Bridge could not read the 3.0 null record.');
      }
      const candidateBytes = await core.getItem('v3-bytes');
      if (
        Object.prototype.toString.call(candidateBytes) !==
          '[object Uint16Array]' ||
        [...candidateBytes].join(',') !== '1,256,65535'
      ) {
        fail('Bridge could not read the 3.0 typed-array record.');
      }

      const rawBefore = await readRaw();
      let unknownError;
      try {
        await core.getItem('unknown-version');
      } catch (error) {
        unknownError = {
          code: error?.code,
          recordVersion: error?.details?.recordVersion,
        };
      }
      if (
        unknownError?.code !== 'DESERIALIZATION_FAILED' ||
        unknownError.recordVersion !== 999
      ) {
        fail('Bridge did not reject the unknown core record version.');
      }
      const rawAfter = await readRaw();
      same(
        rawAfter,
        rawBefore,
        'Bridge mutated the unknown-version record after a failed read.'
      );
      await core.close();

      const defaultNamespace = new api.LocalSpace({
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
      });
      await defaultNamespace.ready();
      same(
        await defaultNamespace.getItem('v3-default-namespace'),
        {
          source: '3.0-candidate',
          namespace: 'localforage/keyvaluepairs',
        },
        'Bridge did not reopen the 3.0 default namespace.'
      );
      await defaultNamespace.close();

      const plugins = new api.LocalSpace({
        name: phaseFixture.databaseName,
        storeName: phaseFixture.pluginStoreName,
        driver: api.indexedDBDriver._driver,
        pluginErrorPolicy: 'strict',
        plugins: [
          api.ttlPlugin({ defaultTTL: 60 * 60 * 1000 }),
          api.compressionPlugin({ threshold: 0 }),
          api.encryptionPlugin({
            key: '0123456789abcdef0123456789abcdef',
          }),
        ],
      });
      await plugins.ready();
      const expectedCandidatePlugin = {
        source: '3.0-candidate',
        message: 'candidate-plugin-value',
        compressible: 'candidate-compressible-'.repeat(256),
      };
      same(
        await plugins.getItem('v3-plugin'),
        expectedCandidatePlugin,
        'Bridge could not read the 3.0 StoredRecord through frozen plugin envelopes.'
      );
      await plugins.close();

      return {
        candidateCoreRead: 4,
        candidateDefaultNamespaceRead: 1,
        candidatePluginRead: 1,
        unknownVersionRejected: true,
        unknownVersionPreserved: true,
      };
    },
    { fixture }
  );

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'localspace-release-rollback-')
);

let browser;
let origin;
try {
  const packDirectory = path.join(temporaryRoot, 'packs');
  const bridgeSource = path.join(temporaryRoot, 'bridge-source');
  const bridgeExtracted = path.join(temporaryRoot, 'bridge-package');
  const candidateExtracted = path.join(temporaryRoot, 'candidate-package');
  mkdirSync(packDirectory);

  const packagedInputStatus = run('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    'LICENSE',
    'README.md',
    'package.json',
    'src',
  ]).stdout.trim();
  assert.equal(
    packagedInputStatus,
    '',
    `Candidate package inputs must match HEAD:\n${packagedInputStatus}`
  );

  if (!options.skipCandidateBuild) {
    run(commandName('pnpm'), ['run', 'build']);
  }

  const bridgePack = publicationConfigured
    ? packPublishedBridge(packDirectory)
    : buildLocalBridge(bridgeSource, packDirectory);
  const candidatePack = packWorkspace(repositoryRoot, packDirectory);

  assert.equal(candidatePack.version, contract.candidateVersion);
  if (!publicationConfigured) {
    assert.equal(bridgePack.version, contract.bridge.sourcePackageVersion);
  }

  const bridgeTarball = path.join(packDirectory, bridgePack.filename);
  const candidateTarball = path.join(packDirectory, candidatePack.filename);
  assert.equal(sha512Integrity(bridgeTarball), bridgePack.integrity);
  assert.equal(sha512Integrity(candidateTarball), candidatePack.integrity);

  const bridgePackageRoot = extractPackage(bridgeTarball, bridgeExtracted);
  const candidatePackageRoot = extractPackage(
    candidateTarball,
    candidateExtracted
  );
  assert.equal(readPackageVersion(bridgePackageRoot), bridgePack.version);
  assert.equal(
    readPackageVersion(candidatePackageRoot),
    contract.candidateVersion
  );

  const bridgeBundle = path.join(bridgePackageRoot, 'dist', 'index.umd.js');
  const candidateBundle = path.join(
    candidatePackageRoot,
    'dist',
    'index.umd.js'
  );
  assert.ok(existsSync(bridgeBundle));
  assert.ok(existsSync(candidateBundle));

  origin = await startOrigin();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const bridgeWriterPage = await loadBundle(
    context,
    origin.origin,
    bridgeBundle
  );
  const bridgeWrite = await bridgeWriteLegacy(
    bridgeWriterPage,
    contract.fixture
  );
  await bridgeWriterPage.close();

  const candidatePage = await loadBundle(
    context,
    origin.origin,
    candidateBundle
  );
  const candidateRun = await candidateReadAndWrite(
    candidatePage,
    contract.fixture
  );
  await candidatePage.close();

  const bridgeReaderPage = await loadBundle(
    context,
    origin.origin,
    bridgeBundle
  );
  const bridgeRead = await bridgeReadCandidate(
    bridgeReaderPage,
    contract.fixture
  );
  await bridgeReaderPage.close();
  await context.close();

  const candidateCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const browserVersion = browser.version();
  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    rollbackAuthority: publicationConfigured
      ? 'published-registry-bridge'
      : 'local-git-bridge-only',
    bridge: {
      ...(publicationConfigured
        ? { publishedVersion: contract.bridge.publishedVersion }
        : { sourceCommit: contract.bridge.sourceCommit }),
      packageVersion: bridgePack.version,
      integrity: bridgePack.integrity,
      shasum: bridgePack.shasum,
    },
    candidate: {
      gitCommit: candidateCommit,
      packageVersion: candidatePack.version,
      integrity: candidatePack.integrity,
      shasum: candidatePack.shasum,
    },
    browser: {
      engine: 'chromium',
      version: browserVersion,
      origin: 'ephemeral-loopback',
    },
    fixture: contract.fixture,
    phases: {
      bridgeWrite,
      candidateRun,
      bridgeRead,
    },
    publicationGateSatisfied: publicationConfigured,
  };

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.output) {
    writeFileSync(path.resolve(options.output), serialized);
  }
  process.stdout.write(serialized);
} finally {
  await browser?.close().catch(() => undefined);
  await origin?.close().catch(() => undefined);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
