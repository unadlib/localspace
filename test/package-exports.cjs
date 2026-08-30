const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');

function probeUnsetNodeEnv(moduleKind) {
  const loadLocalSpace =
    moduleKind === 'esm'
      ? "const { LocalSpace } = await import('localspace');"
      : "const { LocalSpace } = require('localspace');";
  const source = `
const warnings = [];
console.warn = (message) => warnings.push(String(message));
delete process.env.NODE_ENV;
${loadLocalSpace}
new LocalSpace({ plugins: [{
  name: 'combined-probe',
  beforeSet: (_key, value) => value,
  beforeSetItems: (entries) => entries,
}] });
process.stdout.write(JSON.stringify(warnings));`;
  const env = { ...process.env };
  delete env.NODE_ENV;
  const args =
    moduleKind === 'esm'
      ? ['--input-type=module', '--eval', source]
      : ['--eval', source];
  const result = spawnSync(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function main() {
  assert.equal(packageJson.exports['.'].require.types, './dist/index.d.cts');
  assert.equal(
    packageJson.exports['./react-native'].require.types,
    './dist/react-native.d.cts'
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, '../dist/index.d.cts')),
    true
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, '../dist/react-native.d.cts')),
    true
  );

  const cjs = require('localspace');
  assert.equal(typeof cjs.LocalSpace, 'function');
  assert.equal(typeof cjs.default?.setItem, 'function');
  assert.equal(typeof cjs.ttlPlugin, 'function');
  assert.equal('syncPlugin' in cjs, false);
  assert.equal('quotaPlugin' in cjs, false);
  assert.equal(typeof cjs.setDeprecationWarnings, 'function');
  assert.throws(
    () => require('localspace/src/localspace'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
  const originalWarn = console.warn;
  const originalNodeEnv = process.env.NODE_ENV;
  const productionWarnings = [];
  console.warn = (message) => productionWarnings.push(String(message));
  try {
    process.env.NODE_ENV = 'production';
    const productionInstance = new cjs.LocalSpace({
      plugins: [
        {
          name: 'production-combined',
          beforeSet: (_key, value) => value,
          beforeSetItems: (entries) => entries,
        },
      ],
    });
    productionInstance.config();
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  assert.deepEqual(productionWarnings, []);

  const developmentWarnings = [];
  console.warn = (message) => developmentWarnings.push(String(message));
  try {
    process.env.NODE_ENV = 'development';
    new cjs.LocalSpace({
      plugins: [
        {
          name: 'development-combined',
          beforeSet: (_key, value) => value,
          beforeSetItems: (entries) => entries,
        },
      ],
    });
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  assert.deepEqual(developmentWarnings, [
    '[localspace] Deprecation: plugin "development-combined" defines matching batch and single hooks; define one form per phase before 3.0.',
  ]);

  const unsetNodeEnvWarning =
    '[localspace] Deprecation: plugin "combined-probe" defines matching batch and single hooks; define one form per phase before 3.0.';
  assert.deepEqual(probeUnsetNodeEnv('cjs'), [unsetNodeEnvWarning]);
  assert.deepEqual(probeUnsetNodeEnv('esm'), [unsetNodeEnvWarning]);

  const cjsReactNative = require('localspace/react-native');
  assert.equal(typeof cjsReactNative.createReactNativeInstance, 'function');
  assert.equal(
    typeof cjsReactNative.installReactNativeAsyncStorageDriver,
    'function'
  );
  assert.equal(typeof cjsReactNative.setDeprecationWarnings, 'function');

  const sharedWarnings = [];
  const originalRuntimeStorage = global.__LOCALSPACE_ASYNC_STORAGE__;
  const runtimeStorage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  console.warn = (message) => sharedWarnings.push(String(message));
  try {
    process.env.NODE_ENV = 'development';
    global.__LOCALSPACE_ASYNC_STORAGE__ = runtimeStorage;
    const context = {
      _defaultConfig: { storeName: 'keyvaluepairs' },
      _dbInfo: null,
    };

    cjs.setDeprecationWarnings(false);
    await cjsReactNative.reactNativeAsyncStorageDriver._initStorage.call(
      context,
      { name: 'shared-warning-disabled', storeName: 'store' }
    );

    cjs.setDeprecationWarnings(true);
    await cjsReactNative.reactNativeAsyncStorageDriver._initStorage.call(
      context,
      { name: 'shared-warning-enabled', storeName: 'store' }
    );
    await cjsReactNative.reactNativeAsyncStorageDriver._initStorage.call(
      context,
      { name: 'shared-warning-once', storeName: 'store' }
    );
  } finally {
    cjs.setDeprecationWarnings(true);
    if (originalRuntimeStorage === undefined) {
      delete global.__LOCALSPACE_ASYNC_STORAGE__;
    } else {
      global.__LOCALSPACE_ASYNC_STORAGE__ = originalRuntimeStorage;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  assert.deepEqual(sharedWarnings, [
    '[localspace] Deprecation: automatic React Native AsyncStorage detection is deprecated; inject `reactNativeAsyncStorage` explicitly.',
  ]);

  const esm = await import('localspace');
  assert.equal(typeof esm.LocalSpace, 'function');
  assert.equal(typeof esm.default?.setItem, 'function');
  assert.equal(typeof esm.default?.capabilities, 'function');
  assert.equal(typeof esm.registerDriver, 'function');
  assert.equal('syncPlugin' in esm, false);
  assert.equal('quotaPlugin' in esm, false);
  assert.equal(typeof esm.setDeprecationWarnings, 'function');
  await assert.rejects(
    import('localspace/src/localspace'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );

  const duplicateWarnings = [];
  console.warn = (message) => duplicateWarnings.push(String(message));
  try {
    process.env.NODE_ENV = 'development';
    new esm.LocalSpace({
      plugins: [
        {
          name: 'esm-combined',
          beforeSet: (_key, value) => value,
          beforeSetItems: (entries) => entries,
        },
      ],
    });
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  assert.deepEqual(duplicateWarnings, []);

  const esmReactNative = await import('localspace/react-native');
  assert.equal(typeof esmReactNative.createReactNativeInstance, 'function');
  assert.equal(typeof esmReactNative.setDeprecationWarnings, 'function');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
