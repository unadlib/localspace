import { describe, it, expect, vi } from 'vitest';
import localspace from '../src/index';
import { LocalSpaceError } from '../src/errors';
import compressionPlugin from '../src/plugins/compression';

describe('Compression plugin decompression failures', () => {
  it('should surface decompression errors as LocalSpaceError', async () => {
    const warn = vi.spyOn(console, 'warn');
    const codec = {
      compress: (_data: Uint8Array) => new Uint8Array([1]),
      decompress: () => {
        throw new Error('decompress boom');
      },
    };

    const store = localspace.createInstance({
      name: 'compression-decompress-test',
      storeName: 'store',
      plugins: [
        compressionPlugin({
          threshold: 0, // force compression for all values
          codec,
        }),
      ],
    });

    await store.setDriver([store.INDEXEDDB]);
    await store.ready();

    await store.setItem('key', { text: 'x'.repeat(2_000) });

    await expect(store.getItem('key')).rejects.toBeInstanceOf(LocalSpaceError);
    await expect(store.getItem('key')).rejects.toThrow(
      /Failed to decompress payload/
    );
    // Decompression failures propagate under the default lenient policy, so
    // compression no longer warns about that combination.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
