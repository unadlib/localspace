import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalSpace,
  setDeprecationWarnings,
  type LocalSpacePlugin,
} from '../src';
import {
  resetDeprecationWarningsForTests,
  warnDeprecation,
} from '../src/utils/deprecations';

const warnings = () =>
  vi.mocked(console.warn).mock.calls.map(([message]) => String(message));

beforeEach(() => {
  resetDeprecationWarningsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetDeprecationWarningsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('migration deprecation warnings', () => {
  it('does not warn for the serializable Memory transaction contract', async () => {
    const instance = new LocalSpace({
      name: `weak-memory-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.runTransaction('readonly', async (tx) => tx.keys());

    expect(warnings()).toEqual([]);
  });

  it('accepts matching batch and single hooks without a migration warning', () => {
    const plugin: LocalSpacePlugin = {
      name: 'ttl',
      beforeSet: (_key, value) => value,
      beforeSetItems: (entries) => entries,
    };

    new LocalSpace({ plugins: [plugin] });
    new LocalSpace({ plugins: [plugin] });

    expect(warnings()).toEqual([]);
  });

  it('can disable all deprecation warnings', async () => {
    setDeprecationWarnings(false);
    warnDeprecation('weak-memory-transaction', 'must stay silent');

    expect(warnings()).toEqual([]);
  });

  it('does not emit deprecation warnings in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    warnDeprecation('weak-memory-transaction', 'must stay silent');

    expect(warnings()).toEqual([]);
  });

  it('emits deprecation warnings in Node when NODE_ENV is unset', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      warnDeprecation('weak-memory-transaction', 'must remain visible');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    expect(warnings()).toEqual([
      '[localspace] Deprecation: must remain visible',
    ]);
  });
});
