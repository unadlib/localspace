import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(process.cwd(), '.github/workflows/nodejs.yml'),
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
});
