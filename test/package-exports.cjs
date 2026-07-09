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

  const cjsReactNative = require('localspace/react-native');
  assert.equal(typeof cjsReactNative.createReactNativeInstance, 'function');
  assert.equal(
    typeof cjsReactNative.installReactNativeAsyncStorageDriver,
    'function'
  );

  const esm = await import('localspace');
  assert.equal(typeof esm.LocalSpace, 'function');
  assert.equal(typeof esm.default?.setItem, 'function');
  assert.equal('syncPlugin' in esm, false);
  assert.equal('quotaPlugin' in esm, false);

  const esmReactNative = await import('localspace/react-native');
  assert.equal(typeof esmReactNative.createReactNativeInstance, 'function');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
