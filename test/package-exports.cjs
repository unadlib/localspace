const assert = require('node:assert/strict');

async function main() {
  const cjs = require('localspace');
  assert.equal(typeof cjs.LocalSpace, 'function');
  assert.equal(typeof cjs.default?.setItem, 'function');
  assert.equal(typeof cjs.ttlPlugin, 'function');

  const cjsReactNative = require('localspace/react-native');
  assert.equal(typeof cjsReactNative.createReactNativeInstance, 'function');
  assert.equal(
    typeof cjsReactNative.installReactNativeAsyncStorageDriver,
    'function'
  );

  const esm = await import('localspace');
  assert.equal(typeof esm.LocalSpace, 'function');
  assert.equal(typeof esm.default?.setItem, 'function');

  const esmReactNative = await import('localspace/react-native');
  assert.equal(typeof esmReactNative.createReactNativeInstance, 'function');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
