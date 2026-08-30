import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'package-spec': { type: 'string' },
    'output-directory': { type: 'string' },
    'expected-commit': { type: 'string' },
  },
  strict: true,
});

const packageSpecifier = values['package-spec'];
const outputDirectoryArgument = values['output-directory'];
const expectedCommit = values['expected-commit'];
assert.ok(packageSpecifier, '--package-spec is required.');
assert.ok(outputDirectoryArgument, '--output-directory is required.');
assert.ok(expectedCommit, '--expected-commit is required.');
assert.match(
  expectedCommit,
  /^[a-f0-9]{40}$/,
  '--expected-commit must be the exact 40-character release commit.'
);

const versionMatch = /^localspace@(3\.0\.0-rc\.(?:0|[1-9]\d*))$/.exec(
  packageSpecifier
);
assert.ok(
  versionMatch,
  'Detox requires an exact published specifier such as localspace@3.0.0-rc.1.'
);
const expectedVersion = versionMatch[1];

const outputDirectory = path.resolve(outputDirectoryArgument);
mkdirSync(outputDirectory, { recursive: true });
assert.deepEqual(
  readdirSync(outputDirectory),
  [],
  `RC output directory must be empty: ${outputDirectory}`
);

const cleanNpmEnvironment = { ...process.env };
for (const key of Object.keys(cleanNpmEnvironment)) {
  if (/^npm_/i.test(key) || key === 'NODE_AUTH_TOKEN') {
    delete cleanNpmEnvironment[key];
  }
}

const run = (command, arguments_) => {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env: cleanNpmEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${output ? `:\n${output}` : ''}`
    );
  }
  return result.stdout;
};

const packEntries = JSON.parse(
  run('npm', [
    'pack',
    packageSpecifier,
    '--json',
    '--pack-destination',
    outputDirectory,
  ])
);
assert.ok(Array.isArray(packEntries) && packEntries.length === 1);
const packEntry = packEntries[0];
assert.equal(packEntry.name, 'localspace');
assert.equal(packEntry.version, expectedVersion);
assert.match(packEntry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
assert.match(packEntry.shasum, /^[a-f0-9]{40}$/);
assert.equal(packEntry.filename, path.basename(packEntry.filename));

const tarballPath = realpathSync(
  path.join(outputDirectory, packEntry.filename)
);
assert.equal(
  path.dirname(tarballPath),
  realpathSync(outputDirectory),
  'npm pack wrote outside the requested output directory.'
);

const registryDistribution = JSON.parse(
  run('npm', ['view', packageSpecifier, 'dist', '--json'])
);
const registryGitCommit = JSON.parse(
  run('npm', ['view', packageSpecifier, 'gitHead', '--json'])
);
assert.equal(
  registryDistribution.integrity,
  packEntry.integrity,
  'Downloaded tarball integrity differs from npm registry metadata.'
);
assert.equal(
  registryDistribution.shasum,
  packEntry.shasum,
  'Downloaded tarball shasum differs from npm registry metadata.'
);
assert.equal(
  registryGitCommit,
  expectedCommit,
  'Published RC gitHead differs from the checked-out release commit.'
);
assert.equal(
  registryDistribution.attestations?.provenance?.predicateType,
  'https://slsa.dev/provenance/v1',
  'Published RC does not expose npm provenance metadata.'
);

const packedPackageJson = JSON.parse(
  run('tar', ['-xOf', tarballPath, 'package/package.json'])
);
assert.equal(packedPackageJson.name, 'localspace');
assert.equal(packedPackageJson.version, expectedVersion);
assert.ok(
  packedPackageJson.exports?.['./react-native'],
  'RC tarball does not export localspace/react-native.'
);

const packedFiles = new Set(packEntry.files.map((entry) => entry.path));
for (const requiredFile of [
  'dist/react-native.cjs',
  'dist/react-native.esm.js',
  'dist/react-native.d.ts',
  'dist/react-native.d.cts',
]) {
  assert.ok(
    packedFiles.has(requiredFile),
    `RC tarball is missing ${requiredFile}.`
  );
}

const metadataPath = path.join(outputDirectory, 'metadata.json');
const metadata = {
  packageSpecifier,
  name: packEntry.name,
  version: packEntry.version,
  integrity: packEntry.integrity,
  shasum: packEntry.shasum,
  gitCommit: registryGitCommit,
  tarballPath,
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `version=${metadata.version}`,
      `integrity=${metadata.integrity}`,
      `shasum=${metadata.shasum}`,
      `tarball_path=${metadata.tarballPath}`,
      `metadata_path=${metadataPath}`,
      '',
    ].join('\n')
  );
}

console.log(
  `Prepared ${packageSpecifier}: ${metadata.integrity} (${metadata.shasum}) at ${tarballPath}.`
);
