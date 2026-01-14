import { describe, it, expect } from 'vitest';
import localspace from '../src/index';
import { LocalSpaceError } from '../src/errors';
import compressionPlugin from '../src/plugins/compression';

describe('Compression plugin decompression failures', () => {
  it('should surface decompression errors as LocalSpaceError', async () => {
    const codec = {
      compress: (data: string) => data,
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

    await store.setItem('key', { a: 1 });

    await expect(store.getItem('key')).rejects.toBeInstanceOf(LocalSpaceError);
    await expect(store.getItem('key')).rejects.toThrow(
      /Failed to decompress payload/
    );
  });
});
