import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(path.resolve(scriptDirectory, '..'));
const packageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
);

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_) {
  if (argument !== '--require-oidc' && argument !== '--require-unpublished') {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const run = (command, commandArguments, options = {}) => {
  const environment = { ...process.env };
  if (options.cleanNpmEnvironment) {
    for (const key of Object.keys(environment)) {
      if (/^npm_/i.test(key)) delete environment[key];
    }
  }
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${commandArguments.join(' ')} failed${output ? `:\n${output}` : ''}`
    );
  }
  return result;
};

assert.equal(packageJson.name, 'localspace');
assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.match(packageJson.packageManager, /^pnpm@\d+\.\d+\.\d+$/);

const releaseTag = process.env.RELEASE_TAG;
assert.equal(
  releaseTag,
  `v${packageJson.version}`,
  'The GitHub release tag must exactly match package.json version.'
);

const headCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
const tagCommit = run('git', ['rev-list', '-n', '1', releaseTag]).stdout.trim();
assert.equal(
  headCommit,
  tagCommit,
  `Release tag ${releaseTag} does not point at the checked-out commit.`
);

const trackedStatus = run('git', [
  'status',
  '--porcelain',
  '--untracked-files=no',
]).stdout.trim();
assert.equal(trackedStatus, '', 'Tracked release files must be clean.');

const [nodeMajor] = process.versions.node.split('.').map(Number);
assert.equal(nodeMajor, 24, 'LocalSpace 2.1.1 publishing requires Node.js 24.');

const npmVersion = run('npm', ['--version'], {
  cleanNpmEnvironment: true,
}).stdout.trim();
const [npmMajor, npmMinor] = npmVersion.split('.').map(Number);
assert.ok(
  npmMajor > 11 || (npmMajor === 11 && npmMinor >= 5),
  `npm ${npmVersion} is too old for trusted publishing; require >=11.5.1.`
);

if (arguments_.has('--require-oidc')) {
  assert.ok(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    'GitHub OIDC request URL is unavailable. Check id-token: write permission.'
  );
  assert.ok(
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'GitHub OIDC request token is unavailable. Check id-token: write permission.'
  );
  assert.equal(
    process.env.NODE_AUTH_TOKEN,
    undefined,
    'NODE_AUTH_TOKEN must not shadow npm trusted publishing.'
  );
}

if (arguments_.has('--require-unpublished')) {
  const specifier = `${packageJson.name}@${packageJson.version}`;
  const registryLookup = run('npm', ['view', specifier, 'version', '--json'], {
    allowFailure: true,
    cleanNpmEnvironment: true,
  });
  if (registryLookup.status === 0) {
    throw new Error(`${specifier} is already published; refusing to overwrite.`);
  }
  const registryOutput = [registryLookup.stdout, registryLookup.stderr]
    .filter(Boolean)
    .join('\n');
  assert.match(
    registryOutput,
    /E404|404 Not Found/i,
    `Unable to prove ${specifier} is unpublished:\n${registryOutput}`
  );
}

console.log(
  `Verified release identity: ${releaseTag} -> ${headCommit}, Node ${process.versions.node}, npm ${npmVersion}.`
);
