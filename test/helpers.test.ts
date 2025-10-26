import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeTwoCallbacks,
  extend,
  includes,
  normalizeKey,
  isArray,
} from '../src/utils/helpers';

describe('executeTwoCallbacks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes node-style callback on success', async () => {
    const callback = vi.fn();
    await executeTwoCallbacks(Promise.resolve('value'), callback);

    expect(callback).toHaveBeenCalledWith(null, 'value');
  });

  it('invokes node-style callback with error when promise rejects', async () => {
    const callback = vi.fn();
    const error = new Error('boom');
    const rejectingPromise = Promise.resolve().then(() => {
      throw error;
    });
    await executeTwoCallbacks(rejectingPromise, callback).catch(() => undefined);

    expect(callback).toHaveBeenCalledWith(error);
  });

  it('supports legacy success/error callbacks in compatibility mode', async () => {
    const success = vi.fn();
    const failure = vi.fn();
    await executeTwoCallbacks(
      Promise.resolve('ok'),
      success,
      failure,
      { compatibilityMode: true }
    );
    expect(success).toHaveBeenCalledWith('ok');
    expect(failure).not.toHaveBeenCalled();

    const rejection = new Error('fail');
    const handlers: { onCatch?: (error: Error) => void } = {};
    const fakePromise = {
      then: vi.fn().mockReturnThis(),
      catch: vi.fn().mockImplementation((handler: (error: Error) => void) => {
        handlers.onCatch = handler;
        return fakePromise;
      }),
    } as unknown as Promise<never>;

    executeTwoCallbacks(fakePromise, success, failure, { compatibilityMode: true });
    handlers.onCatch?.(rejection);
    expect(failure).toHaveBeenCalledWith(rejection);
  });
});

describe('helper utilities', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extend performs shallow copy and clones arrays', () => {
    const target = { foo: 1, arr: [1, 2] };
    const source = { bar: 2, arr: ['a', 'b'] };
    const result = extend(target, source);

    expect(result).toEqual({ foo: 1, bar: 2, arr: ['a', 'b'] });
    expect(result.arr).not.toBe(source.arr);
  });

  it('normalizeKey converts non-string and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = normalizeKey(123);
    expect(normalized).toBe('123');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('includes returns true when value exists', () => {
    expect(includes([1, 2, 3], 2)).toBe(true);
  });

  it('isArray detects arrays', () => {
    expect(isArray([])).toBe(true);
    expect(isArray('not array' as unknown as string[])).toBe(false);
  });
});
