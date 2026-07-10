import { afterEach, describe, expect, it, vi } from 'vitest';

describe('normalizeKey warning throttling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('warns once per non-string typeof', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { normalizeKey } = await import('../src/utils/helpers');

    expect(normalizeKey(1)).toBe('1');
    expect(normalizeKey(2)).toBe('2');
    expect(normalizeKey(true)).toBe('true');
    expect(normalizeKey(false)).toBe('false');
    expect(normalizeKey('already-string')).toBe('already-string');

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('got number'),
      expect.stringContaining('got boolean'),
    ]);
  });
});
