import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    metadata: { type: 'string' },
  },
  strict: true,
});

assert.ok(values.fixture, '--fixture is required.');
assert.ok(values.metadata, '--metadata is required.');

const fixtureDirectory = realpathSync(path.resolve(values.fixture));
const metadataPath = realpathSync(path.resolve(values.metadata));
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
assert.match(metadata.version, /^3\.0\.0-rc\.(?:0|[1-9]\d*)$/);
assert.match(metadata.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
assert.match(metadata.shasum, /^[a-f0-9]{40}$/);
assert.match(metadata.gitCommit, /^[a-f0-9]{40}$/);
assert.equal(metadata.name, 'localspace');
const fixturePackageJsonPath = path.join(fixtureDirectory, 'package.json');
const fixturePackageJson = JSON.parse(
  readFileSync(fixturePackageJsonPath, 'utf8')
);

const dependencySpecifier = fixturePackageJson.dependencies?.localspace;
assert.match(
  dependencySpecifier,
  /^file:/,
  'Detox fixture must replace workspace:* with the prepared RC tarball.'
);
const dependencyPath = dependencySpecifier.slice('file:'.length);
const dependencyTarballPath = realpathSync(
  path.isAbsolute(dependencyPath)
    ? dependencyPath
    : path.resolve(fixtureDirectory, dependencyPath)
);
assert.equal(
  dependencyTarballPath,
  realpathSync(metadata.tarballPath),
  'Detox fixture does not reference the integrity-checked RC tarball.'
);

const fixtureRequire = createRequire(fixturePackageJsonPath);
const installedPackageJsonPath = realpathSync(
  fixtureRequire.resolve('localspace/package.json')
);
const installedPackageRoot = path.dirname(installedPackageJsonPath);
const repositoryRoot = realpathSync(path.resolve(fixtureDirectory, '../..'));
assert.notEqual(
  installedPackageRoot,
  repositoryRoot,
  'Detox resolved the workspace package instead of the RC tarball.'
);

const installedPackageJson = JSON.parse(
  readFileSync(installedPackageJsonPath, 'utf8')
);
assert.equal(installedPackageJson.name, 'localspace');
assert.equal(installedPackageJson.version, metadata.version);
assert.ok(installedPackageJson.exports?.['./react-native']);
for (const requiredFile of [
  'dist/react-native.cjs',
  'dist/react-native.esm.js',
  'dist/react-native.d.ts',
  'dist/react-native.d.cts',
]) {
  assert.ok(
    existsSync(path.join(installedPackageRoot, requiredFile)),
    `Installed RC is missing ${requiredFile}.`
  );
}

console.log(
  `Verified installed localspace@${metadata.version} from ${dependencyTarballPath}; integrity ${metadata.integrity}.`
);
