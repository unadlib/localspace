import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(path.resolve(scriptDirectory, '..'));
const contract = JSON.parse(
  readFileSync(
    path.join(repositoryRoot, 'test', 'package-contract.json'),
    'utf8'
  )
);
const skipBuild = process.argv.slice(2).includes('--skip-build');

for (const argument of process.argv.slice(2)) {
  if (argument !== '--skip-build') {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const commandName = (name) =>
  process.platform === 'win32' ? `${name}.cmd` : name;

const run = (command, arguments_, options = {}) => {
  const environment = { ...process.env, ...(options.env ?? {}) };
  if (options.cleanNpmEnvironment) {
    for (const key of Object.keys(environment)) {
      if (/^npm_/i.test(key)) delete environment[key];
    }
  }
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${output ? `:\n${output}` : ''}`
    );
  }
  return result;
};

const parsePackResult = (stdout) => {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(result && Array.isArray(result.files), 'Invalid npm pack result.');
  return result;
};

const verifyPackContract = (pack) => {
  const actualFiles = pack.files.map((file) => file.path).sort();
  const expectedFiles = [...contract.files].sort();
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    'Tarball file allowlist changed.'
  );
  assert.equal(pack.entryCount, contract.budgets.entryCount);
  assert.ok(
    pack.size <= contract.budgets.packedBytes,
    `Packed size ${pack.size} exceeds ${contract.budgets.packedBytes}.`
  );
  assert.ok(
    pack.unpackedSize <= contract.budgets.unpackedBytes,
    `Unpacked size ${pack.unpackedSize} exceeds ${contract.budgets.unpackedBytes}.`
  );

  const sizes = new Map(pack.files.map((file) => [file.path, file.size]));
  for (const file of [
    'dist/index.cjs',
    'dist/index.esm.js',
    'dist/index.umd.js',
  ]) {
    assert.ok(sizes.get(file) <= contract.budgets.mainBundleBytes);
  }
  for (const file of ['dist/react-native.cjs', 'dist/react-native.esm.js']) {
    assert.ok(sizes.get(file) <= contract.budgets.reactNativeBundleBytes);
  }
  for (const file of [
    'dist/index.cjs.map',
    'dist/index.esm.js.map',
    'dist/index.umd.js.map',
  ]) {
    assert.ok(sizes.get(file) <= contract.budgets.mainSourceMapBytes);
  }
  for (const file of [
    'dist/react-native.cjs.map',
    'dist/react-native.esm.js.map',
  ]) {
    assert.ok(sizes.get(file) <= contract.budgets.reactNativeSourceMapBytes);
  }
};

const verifyInstalledArtifact = (packageRoot) => {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  );
  assert.equal('source' in packageJson, false);
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.equal(packageJson.exports['.'].require.default, './dist/index.cjs');
  assert.equal(
    packageJson.exports['./react-native'].default.default,
    './dist/react-native.esm.js'
  );
  assert.equal(existsSync(path.join(packageRoot, 'src')), false);
  assert.equal(
    existsSync(path.join(packageRoot, 'dist', 'localspace.js')),
    false
  );

  const sourceMaps = contract.files.filter((file) => file.endsWith('.map'));
  for (const relativePath of sourceMaps) {
    const sourceMap = JSON.parse(
      readFileSync(path.join(packageRoot, relativePath), 'utf8')
    );
    assert.equal(sourceMap.version, 3);
    assert.equal(sourceMap.sources.length, sourceMap.sourcesContent.length);
    assert.ok(
      sourceMap.sourcesContent.every(
        (source) => typeof source === 'string' && source.length > 0
      )
    );
    assert.ok(sourceMap.sources.some((source) => source.startsWith('../src/')));
    assert.ok(sourceMap.sources.every((source) => !path.isAbsolute(source)));
  }

  for (const relativePath of contract.files.filter(
    (file) => file.endsWith('.d.ts') || file.endsWith('.d.cts')
  )) {
    const declaration = readFileSync(
      path.join(packageRoot, relativePath),
      'utf8'
    );
    assert.equal(declaration.includes('sourceMappingURL='), false);
  }
};

const runRuntimeProbes = (consumerRoot) => {
  const commonJsProbe = `
(async () => {
  const assert = require('node:assert/strict');
  const packageJson = require('localspace/package.json');
  const api = require('localspace');
  assert.equal(packageJson.name, 'localspace');
  assert.equal(typeof api.LocalSpace, 'function');
  assert.equal(typeof api.default.setItem, 'function');
  assert.throws(
    () => require('localspace/src/localspace'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );

  const store = new api.LocalSpace({
    name: 'tarball-cjs',
    storeName: 'store',
    driver: api.memoryDriver._driver,
    pluginErrorPolicy: 'strict',
    plugins: [api.compressionPlugin({ threshold: 1 })],
  });
  await store.ready();
  const value = 'bundled-compression-'.repeat(32);
  await store.setItem('key', value);
  assert.equal(await store.getItem('key'), value);
  await store.close();

  const reactNative = require('localspace/react-native');
  const values = new Map();
  const adapter = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
  const base = new api.LocalSpace({ driver: api.memoryDriver._driver });
  await base.ready();
  const mobile = await reactNative.createReactNativeInstance(base, {
    name: 'tarball-rn',
    storeName: 'store',
    reactNativeAsyncStorage: adapter,
  });
  await mobile.setItem('mobile', 'ok');
  assert.equal(await mobile.getItem('mobile'), 'ok');
  await mobile.close();
  await base.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`;
  run(process.execPath, ['--eval', commonJsProbe], { cwd: consumerRoot });

  const moduleProbe = `
import assert from 'node:assert/strict';
const api = await import('localspace');
const reactNative = await import('localspace/react-native');
assert.equal(typeof api.LocalSpace, 'function');
assert.equal(typeof api.default.setItem, 'function');
assert.equal(typeof reactNative.createReactNativeInstance, 'function');
await assert.rejects(
  import('localspace/src/localspace'),
  (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
);`;
  run(process.execPath, ['--input-type=module', '--eval', moduleProbe], {
    cwd: consumerRoot,
  });
};

const runTypeProbes = (consumerRoot) => {
  const typeRoot = path.join(consumerRoot, 'types');
  mkdirSync(typeRoot);
  for (const file of ['consumer.mts', 'consumer.cts', 'tsconfig.json']) {
    copyFileSync(
      path.join(repositoryRoot, 'test', 'package-types', file),
      path.join(typeRoot, file)
    );
  }
  const typescriptCli = path.join(
    repositoryRoot,
    'node_modules',
    'typescript',
    'bin',
    'tsc'
  );
  run(
    process.execPath,
    [typescriptCli, '-p', path.join(typeRoot, 'tsconfig.json')],
    {
      cwd: consumerRoot,
    }
  );
};

const verifySourceMapStack = (consumerRoot) => {
  const probe = run(
    process.execPath,
    [
      '--enable-source-maps',
      '--eval',
      "const { LocalSpace } = require('localspace'); new LocalSpace({ size: 1 });",
    ],
    { cwd: consumerRoot, allowFailure: true }
  );
  assert.notEqual(
    probe.status,
    0,
    'Source-map stack probe unexpectedly passed.'
  );
  assert.match(
    probe.stderr,
    /node_modules[\\/]localspace[\\/]src[\\/]core[\\/]config\.ts:\d+:\d+/
  );
};

if (!skipBuild) {
  run(commandName('pnpm'), ['run', 'build']);
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'localspace-package-contract-')
);
try {
  const packDirectory = path.join(temporaryRoot, 'pack');
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  mkdirSync(packDirectory);
  mkdirSync(consumerRoot);

  const pack = parsePackResult(
    run(
      commandName('npm'),
      ['pack', '--json', '--pack-destination', packDirectory],
      { cwd: repositoryRoot, cleanNpmEnvironment: true }
    ).stdout
  );
  verifyPackContract(pack);

  writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
  );
  const tarball = path.join(packDirectory, pack.filename);
  run(
    commandName('npm'),
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    { cwd: consumerRoot, cleanNpmEnvironment: true }
  );

  const packageRoot = realpathSync(
    path.join(consumerRoot, 'node_modules', 'localspace')
  );
  verifyInstalledArtifact(packageRoot);
  runRuntimeProbes(consumerRoot);
  runTypeProbes(consumerRoot);
  verifySourceMapStack(consumerRoot);

  console.log(
    `Verified isolated tarball: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes.`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
