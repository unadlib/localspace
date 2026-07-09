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

});
