import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeTwoCallbacks,
  extend,
  includes,
  normalizeKey,
  isArray,
  getCallback,
  createBlob,
  executeCallback,
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

  describe('getCallback', () => {
    it('returns callback when last argument is a function', () => {
      const cb = () => {};
      const args = ['arg1', 'arg2', cb];
      const result = getCallback(args);
      expect(result).toBe(cb);
    });

    it('returns undefined when last argument is not a function', () => {
      const args = ['arg1', 'arg2', 'arg3'];
      const result = getCallback(args);
      expect(result).toBeUndefined();
    });

    it('returns undefined when args array is empty', () => {
      const args: any[] = [];
      const result = getCallback(args);
      expect(result).toBeUndefined();
    });
  });

  describe('createBlob', () => {
    it('creates a Blob with specified parts and type', () => {
      const blob = createBlob(['test content'], { type: 'text/plain' });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('text/plain');
    });

    it('creates a Blob without type specification', () => {
      const blob = createBlob(['test']);
      expect(blob).toBeInstanceOf(Blob);
    });

    it('handles multiple parts', () => {
      const blob = createBlob(['part1', 'part2'], { type: 'text/plain' });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('handles empty parts array', () => {
      const blob = createBlob([]);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(0);
    });

    it('should handle fallback for legacy browsers', () => {
      // Save original Blob constructor
      const OriginalBlob = globalThis.Blob;

      // Mock Blob constructor to throw TypeError on first call
      let callCount = 0;
      const mockBlobBuilder = function(this: any) {
        this.parts = [];
        this.append = function(part: BlobPart) {
          this.parts.push(part);
        };
        this.getBlob = function(type?: string) {
          // Use original Blob for the actual blob creation
          return new OriginalBlob(this.parts, { type });
        };
      };

      globalThis.Blob = vi.fn().mockImplementation(function(parts: BlobPart[], options?: BlobPropertyBag) {
        callCount++;
        if (callCount === 1) {
          const error = new Error('TypeError') as any;
          error.name = 'TypeError';
          throw error;
        }
        return new OriginalBlob(parts, options);
      }) as any;

      (globalThis as any).BlobBuilder = mockBlobBuilder;

      try {
        const blob = createBlob(['test'], { type: 'text/plain' });
        expect(blob).toBeInstanceOf(OriginalBlob);
      } finally {
        // Restore original Blob
        globalThis.Blob = OriginalBlob;
        delete (globalThis as any).BlobBuilder;
      }
    });

    it('should throw error when no Blob support available', () => {
      // Save original Blob constructor
      const OriginalBlob = globalThis.Blob;

      // Mock Blob constructor to always throw
      globalThis.Blob = vi.fn().mockImplementation(() => {
        const error = new Error('TypeError') as any;
        error.name = 'TypeError';
        throw error;
      }) as any;

      // Ensure no fallback builders exist
      const builders = ['BlobBuilder', 'MSBlobBuilder', 'MozBlobBuilder', 'WebKitBlobBuilder'];
      const savedBuilders: any = {};
      builders.forEach(builder => {
        savedBuilders[builder] = (globalThis as any)[builder];
        delete (globalThis as any)[builder];
      });

      try {
        expect(() => createBlob(['test'])).toThrow('Blob constructor not supported');
      } finally {
        // Restore everything
        globalThis.Blob = OriginalBlob;
        builders.forEach(builder => {
          if (savedBuilders[builder]) {
            (globalThis as any)[builder] = savedBuilders[builder];
          }
        });
      }
    });

    it('should rethrow non-TypeError errors', () => {
      // Save original Blob constructor
      const OriginalBlob = globalThis.Blob;

      // Mock Blob constructor to throw a different error
      globalThis.Blob = vi.fn().mockImplementation(() => {
        throw new Error('Different error');
      }) as any;

      try {
        expect(() => createBlob(['test'])).toThrow('Different error');
      } finally {
        // Restore original Blob
        globalThis.Blob = OriginalBlob;
      }
    });
  });

  describe('executeCallback', () => {
    it('invokes callback on promise success', async () => {
      const callback = vi.fn();
      await executeCallback(Promise.resolve('value'), callback);
      expect(callback).toHaveBeenCalledWith(null, 'value');
    });

    it('invokes callback with error on promise rejection', async () => {
      const callback = vi.fn();
      const error = new Error('test error');
      await executeCallback(Promise.reject(error), callback).catch(() => {});
      expect(callback).toHaveBeenCalledWith(error);
    });

    it('returns promise even when callback is provided', async () => {
      const callback = vi.fn();
      const promise = executeCallback(Promise.resolve('value'), callback);
      expect(promise).toBeInstanceOf(Promise);
      await promise;
    });

    it('works without callback', async () => {
      const promise = executeCallback(Promise.resolve('value'));
      const result = await promise;
      expect(result).toBe('value');
    });
  });

  describe('executeTwoCallbacks - error handling', () => {
    it('calls errorCallback when provided separately', async () => {
      const errorCallback = vi.fn();
      const error = new Error('test error');
      await executeTwoCallbacks(Promise.reject(error), undefined, errorCallback).catch(() => {});
      expect(errorCallback).toHaveBeenCalledWith(error);
    });

    it('normalizes non-Error objects to Error', async () => {
      const callback = vi.fn();
      await executeTwoCallbacks(Promise.reject('string error'), callback).catch(() => {});
      expect(callback).toHaveBeenCalled();
      const callArg = callback.mock.calls[0][0];
      expect(callArg).toBeInstanceOf(Error);
      expect(callArg.message).toBe('string error');
    });

    it('works without any callbacks', async () => {
      const promise = executeTwoCallbacks(Promise.resolve('value'));
      const result = await promise;
      expect(result).toBe('value');
    });
  });
});
