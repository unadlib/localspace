import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extend,
  includes,
  normalizeKey,
  isArray,
  createBlob,
} from '../src/utils/helpers';

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

    it('does not invoke legacy BlobBuilder fallbacks', () => {
      const OriginalBlob = globalThis.Blob;
      const legacyBuilder = vi.fn();
      globalThis.Blob = vi.fn().mockImplementation(() => {
        const error = new Error('TypeError');
        error.name = 'TypeError';
        throw error;
      }) as typeof Blob;
      (globalThis as Record<string, unknown>).BlobBuilder = legacyBuilder;

      try {
        expect(() => createBlob(['test'])).toThrowError(
          expect.objectContaining({ code: 'BLOB_UNSUPPORTED' })
        );
        expect(legacyBuilder).not.toHaveBeenCalled();
      } finally {
        globalThis.Blob = OriginalBlob;
        delete (globalThis as Record<string, unknown>).BlobBuilder;
      }
    });

    it('normalizes a missing modern Blob implementation', () => {
      const OriginalBlob = globalThis.Blob;
      globalThis.Blob = vi.fn().mockImplementation(() => {
        const error = new Error('TypeError');
        error.name = 'TypeError';
        throw error;
      }) as typeof Blob;

      try {
        expect(() => createBlob(['test'])).toThrowError(
          expect.objectContaining({
            code: 'BLOB_UNSUPPORTED',
            message: 'Blob constructor not supported',
          })
        );
      } finally {
        globalThis.Blob = OriginalBlob;
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
});
