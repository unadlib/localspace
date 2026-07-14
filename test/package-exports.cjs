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
    const productionInstance = new cjs.LocalSpace({ size: 1 });
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
    new cjs.LocalSpace({ size: 1 });
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    console.warn = originalWarn;
  }
  assert.deepEqual(developmentWarnings, [
    '[localspace] Deprecation: the `size` option is ignored by built-in drivers and will be removed in 3.0.',
  ]);

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
    new esm.LocalSpace({ size: 1 });
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
