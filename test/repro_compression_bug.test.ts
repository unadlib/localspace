import { describe, it, expect, vi } from 'vitest';
import localspace from '../src/index';
import compressionPlugin from '../src/plugins/compression';

describe('Compression Plugin Bug Reproduction', () => {
  it('should propagate compression errors explicitly', async () => {
    const errorCodec = {
      compress: () => {
        throw new Error('Compression failed intentionally');
      },
      decompress: (data: any) => data,
    };

    const store = localspace.createInstance({
      name: 'bug-repro',
      storeName: 'test',
      plugins: [
        compressionPlugin({
          threshold: 0, // Force compression for all items
          codec: errorCodec,
        }),
      ],
    });

    const value = 'test-value-that-should-be-compressed';
    
    // FIXED: This should now reject with a LocalSpaceError
    await expect(store.setItem('key', value)).rejects.toThrow(
      'Failed to compress payload'
    );

    // Use verify cleanup if needed, but here we just check failure.
  });
});
