import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'localspace-detox-rc-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Detox RC package tools', () => {
  it.each([
    'localspace@next',
    'localspace@3.0.0',
    'localspace@^3.0.0-rc.1',
    'localspace@3.0.0-rc.01',
    'other-package@3.0.0-rc.1',
  ])('rejects non-exact RC input %s before registry access', (specifier) => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/prepare-detox-rc.mjs',
        '--package-spec',
        specifier,
        '--output-directory',
        temporaryDirectory(),
        '--expected-commit',
        '0'.repeat(40),
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exact published specifier');
  });

  it('rejects a fixture that still resolves workspace:*', () => {
    const repository = temporaryDirectory();
    const fixture = path.join(repository, 'integration', 'fixture');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { localspace: 'workspace:*' },
      })
    );
    const metadataPath = path.join(repository, 'metadata.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({
        name: 'localspace',
        version: '3.0.0-rc.1',
        integrity: `sha512-${'A'.repeat(86)}==`,
        shasum: '0'.repeat(40),
        gitCommit: '0'.repeat(40),
      })
    );

    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-detox-rc-install.mjs',
        '--fixture',
        fixture,
        '--metadata',
        metadataPath,
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('replace workspace:*');
  });
});
