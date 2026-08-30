import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(process.cwd(), '.github/workflows/nodejs.yml'),
  'utf8'
);
const detoxWorkflow = readFileSync(
  path.resolve(process.cwd(), '.github/workflows/detox-mobile.yml'),
  'utf8'
);

const extractJob = (name: string): string => {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Workflow job ${name} was not found.`);
  }

  const remaining = workflow.slice(start + startMarker.length);
  const nextJob = remaining.search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
};

describe('release workflow contracts', () => {
  it('fetches the pinned bridge history before the browser rollback rehearsal', () => {
    const browsersJob = extractJob('browsers');

    expect(browsersJob).toContain('scripts/rehearse-data-rollback.mjs');
    expect(browsersJob).toMatch(
      /uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0/
    );
  });

  it('runs manual iOS Detox against an exact integrity-checked RC tarball', () => {
    expect(detoxWorkflow).toMatch(
      /package_spec:\n\s+description:.*localspace@3\.0\.0-rc\.1\n\s+required: true/
    );
    expect(detoxWorkflow).toContain('scripts/prepare-detox-rc.mjs');
    expect(detoxWorkflow).toContain('${{ inputs.package_spec }}');
    expect(detoxWorkflow).toContain('--expected-commit "$GITHUB_SHA"');
    expect(detoxWorkflow).toContain(
      'pnpm --filter localspace-detox-fixture add --save-exact "$RC_TARBALL"'
    );
    expect(detoxWorkflow).toContain('scripts/verify-detox-rc-install.mjs');
    expect(detoxWorkflow).not.toContain('pnpm run build\n');
    expect(detoxWorkflow).not.toContain('app_exists');
  });
});
