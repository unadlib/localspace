import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(process.cwd(), '.github/workflows/npm-publish.yml'),
  'utf8'
);

describe('2.1.1 release workflow contract', () => {
  it('uses npm trusted publishing from an exact, unpublished release commit', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toMatch(
      /uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0/
    );
    expect(workflow).toContain(
      'verify-release-identity.mjs --require-oidc --require-unpublished'
    );
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).not.toContain('registry-url:');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });
});
