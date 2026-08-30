const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');

function probeUnsetNodeEnv(moduleKind) {
  const loadLocalSpace =
    moduleKind === 'esm'
      ? "const { encryptionPlugin } = await import('localspace');"
      : "const { encryptionPlugin } = require('localspace');";
  const source = `
const warnings = [];
console.warn = (message) => warnings.push(String(message));
delete process.env.NODE_ENV;
${loadLocalSpace}
encryptionPlugin({
  key: '0123456789abcdef0123456789abcdef',
  algorithm: { name: 'AES-CBC', iv: new Uint8Array(16) },
});
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
    cjs.encryptionPlugin({
      key: '0123456789abcdef0123456789abcdef',
      algorithm: { name: 'AES-CBC', iv: new Uint8Array(16) },
    });
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
    cjs.encryptionPlugin({
      key: '0123456789abcdef0123456789abcdef',
      algorithm: { name: 'AES-CBC', iv: new Uint8Array(16) },
    });
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  const legacyEncryptionWarning =
    '[localspace] Deprecation: AES-CBC encryption is deprecated and read-only; migrate data to AES-GCM.';
  assert.deepEqual(developmentWarnings, [legacyEncryptionWarning]);
  assert.deepEqual(probeUnsetNodeEnv('cjs'), [legacyEncryptionWarning]);
  assert.deepEqual(probeUnsetNodeEnv('esm'), [legacyEncryptionWarning]);

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
    esm.encryptionPlugin({
      key: '0123456789abcdef0123456789abcdef',
      algorithm: {
        name: 'AES-CTR',
        counter: new Uint8Array(16),
        length: 64,
      },
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
