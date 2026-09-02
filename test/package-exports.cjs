const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');

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
  assert.equal(typeof cjs.encryptionPlugin, 'function');
  assert.equal(typeof cjs.legacyEncryptionMigrationPlugin, 'function');
  assert.equal('syncPlugin' in cjs, false);
  assert.equal('quotaPlugin' in cjs, false);
  assert.equal('setDeprecationWarnings' in cjs, false);
  assert.throws(
    () => require('localspace/src/localspace'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
  assert.throws(
    () =>
      cjs.encryptionPlugin({
        key: '0123456789abcdef0123456789abcdef',
        algorithm: { name: 'AES-CBC', iv: new Uint8Array(16) },
      }),
    (error) =>
      error?.code === 'INVALID_CONFIG' &&
      error.message.includes('supports only AES-GCM')
  );
  const legacyMigrationPlugin = cjs.legacyEncryptionMigrationPlugin({
    key: '0123456789abcdef0123456789abcdef',
    algorithm: { name: 'AES-CBC' },
  });
  assert.equal(legacyMigrationPlugin.name, 'encryption');

  const cjsReactNative = require('localspace/react-native');
  assert.equal(typeof cjsReactNative.createReactNativeInstance, 'function');
  assert.equal(
    typeof cjsReactNative.installReactNativeAsyncStorageDriver,
    'function'
  );
  assert.equal('setDeprecationWarnings' in cjsReactNative, false);

  const originalRuntimeStorage = global.__LOCALSPACE_ASYNC_STORAGE__;
  const runtimeStorage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  const configuredStorage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    getAllKeys: async () => [],
  };
  const context = {
    _defaultConfig: { storeName: 'keyvaluepairs' },
    _dbInfo: null,
  };
  try {
    global.__LOCALSPACE_ASYNC_STORAGE__ = runtimeStorage;
    await assert.rejects(
      cjsReactNative.reactNativeAsyncStorageDriver._initStorage.call(context, {
        name: 'runtime-global-must-be-ignored',
        storeName: 'store',
      }),
      (error) =>
        error?.code === 'DRIVER_UNAVAILABLE' &&
        error?.details?.reason === 'adapter-not-configured'
    );
    await cjsReactNative.reactNativeAsyncStorageDriver._initStorage.call(
      context,
      {
        name: 'explicit-adapter',
        storeName: 'store',
        reactNativeAsyncStorage: configuredStorage,
      }
    );
    assert.equal(context._dbInfo.asyncStorage, configuredStorage);
  } finally {
    if (originalRuntimeStorage === undefined) {
      delete global.__LOCALSPACE_ASYNC_STORAGE__;
    } else {
      global.__LOCALSPACE_ASYNC_STORAGE__ = originalRuntimeStorage;
    }
  }

  const esm = await import('localspace');
  assert.equal(typeof esm.LocalSpace, 'function');
  assert.equal(typeof esm.default?.setItem, 'function');
  assert.equal(typeof esm.default?.capabilities, 'function');
  assert.equal(typeof esm.registerDriver, 'function');
  assert.equal(typeof esm.legacyEncryptionMigrationPlugin, 'function');
  assert.equal('syncPlugin' in esm, false);
  assert.equal('quotaPlugin' in esm, false);
  assert.equal('setDeprecationWarnings' in esm, false);
  await assert.rejects(
    import('localspace/src/localspace'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );

  const esmReactNative = await import('localspace/react-native');
  assert.equal(typeof esmReactNative.createReactNativeInstance, 'function');
  assert.equal('setDeprecationWarnings' in esmReactNative, false);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
