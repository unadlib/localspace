import {
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import localspace, {
  LocalSpace,
  ttlPlugin,
  encryptionPlugin,
  compressionPlugin,
  LocalSpacePlugin,
} from '../src';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Plugin system', () => {
  it('applies custom plugins in registration order', async () => {
    const order: string[] = [];
    const augmentPlugin: LocalSpacePlugin = {
      name: 'augment',
      beforeSet: <T>(key: string, value: T): T => {
        order.push(`before-${key}`);
        return `a:${value}` as unknown as T;
      },
      afterGet: async <T>(key: string, value: T | null): Promise<T | null> => {
        order.push(`after-${key}`);
        return (
          typeof value === 'string' ? value.replace(/^a:/, '') : value
        ) as T | null;
      },
    };

    const suffixPlugin: LocalSpacePlugin = {
      name: 'suffix',
      beforeSet: <T>(_key: string, value: T): T => `${value}:b` as unknown as T,
      afterGet: <T>(_key: string, value: T | null): T | null =>
        (typeof value === 'string'
          ? value.replace(/:b$/, '')
          : value) as T | null,
    };

    const instance = new LocalSpace({
      name: 'plugin-order',
      storeName: 'plugin-order-store',
    });
    instance.use([augmentPlugin, suffixPlugin]);

    await instance.setItem('foo', 'value');
    const result = await instance.getItem('foo');

    expect(result).toBe('value');
    expect(order).toEqual(['before-foo', 'after-foo']);
  });

  it('expires values via ttl plugin', async () => {
    const store = localspace.createInstance({
      name: 'ttl-plugin',
      storeName: 'ttl-store',
      plugins: [ttlPlugin({ defaultTTL: 10 })],
    });

    await store.setItem('session', 'token');
    await sleep(25);
    const value = await store.getItem('session');

    expect(value).toBeNull();
  });

  it('cleans up expired ttl entries via scheduled sweep', async () => {
    const onExpire = vi.fn();
    const store = localspace.createInstance({
      name: 'ttl-cleanup-plugin',
      storeName: 'ttl-cleanup-store',
      plugins: [
        ttlPlugin({
          defaultTTL: 5,
          cleanupInterval: 10,
          onExpire,
        }),
      ],
    });

    await store.setItem('ephemeral', 'value');
    await sleep(40);

    expect(onExpire).toHaveBeenCalledWith('ephemeral', 'value');
    const remaining = await store.getItem('ephemeral');
    expect(remaining).toBeNull();
  });

  it('encrypts and decrypts values', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const secure = localspace.createInstance({
      name: 'secure-db',
      storeName: 'secure-store',
      plugins: [encryptionPlugin({ key })],
    });

    await secure.setItem('secret', { user: 'ada' });

    const rawReader = localspace.createInstance({
      name: 'secure-db',
      storeName: 'secure-store',
    });

    const raw = await rawReader.getItem('secret');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    const decrypted = await secure.getItem<{ user: string }>('secret');
    expect(decrypted?.user).toBe('ada');
  });

  it('derives encryption keys and detects tampered payloads', async () => {
    const secure = localspace.createInstance({
      name: 'secure-derived-db',
      storeName: 'secure-derived-store',
      plugins: [
        encryptionPlugin({
          keyDerivation: {
            passphrase: 'correct horse battery staple',
            salt: 'salty-salt',
            iterations: 1000,
            hash: 'SHA-256',
            length: 256,
          },
        }),
      ],
    });

    await secure.setItem('record', { id: 42 });

    const rawReader = localspace.createInstance({
      name: 'secure-derived-db',
      storeName: 'secure-derived-store',
    });
    const raw = await rawReader.getItem('record');
    expect(raw).not.toBeNull();
    expect(raw).toMatchObject({ __ls_encrypted: true });

    if (!raw || typeof raw !== 'object') {
      throw new Error('Encrypted payload missing');
    }

    type RawEncryptedPayload = {
      __ls_encrypted: true;
      algorithm: string;
      iv: string;
      data: string;
    };
    const encryptedPayload = raw as RawEncryptedPayload;
    const tampered: RawEncryptedPayload = {
      ...encryptedPayload,
      data: `tampered-${encryptedPayload.data}`,
    };
    await rawReader.setItem('record', tampered);

    await expect(secure.getItem('record')).rejects.toThrow(
      'Failed to decrypt payload'
    );
  });

  it('compresses large payloads transparently', async () => {
    const payload = 'x'.repeat(5000);
    const compressedStore = localspace.createInstance({
      name: 'compress-db',
      storeName: 'compress-store',
      plugins: [compressionPlugin({ threshold: 512 })],
    });

    await compressedStore.setItem('blob', payload);

    const rawReader = localspace.createInstance({
      name: 'compress-db',
      storeName: 'compress-store',
    });

    const raw = await rawReader.getItem('blob');
    expect(raw).toMatchObject({ __ls_compressed: true });

    const restored = await compressedStore.getItem<string>('blob');
    expect(restored).toBe(payload);
  });

  it('unwinds plugin transformations in reverse order', async () => {
    const order: string[] = [];
    const makePlugin = (name: string): LocalSpacePlugin => ({
      name,
      beforeSet: <T>(_key: string, value: T): T => {
        order.push(`before:${name}`);
        return (typeof value === 'string' ? `${name}|${value}` : value) as T;
      },
      afterSet: () => {
        order.push(`afterSet:${name}`);
      },
      afterGet: <T>(_key: string, value: T | null): T | null => {
        order.push(`afterGet:${name}`);
        if (typeof value === 'string' && value.startsWith(`${name}|`)) {
          return value.slice(name.length + 1) as T;
        }
        return value;
      },
    });

    const instance = new LocalSpace({
      name: 'plugin-unwind',
      storeName: 'plugin-unwind-store',
    });
    instance.use([makePlugin('alpha'), makePlugin('beta')]);

    await instance.setItem('topic', 'value');
    const result = await instance.getItem('topic');

    expect(result).toBe('value');
    expect(order).toEqual([
      'before:alpha',
      'before:beta',
      'afterSet:beta',
      'afterSet:alpha',
      'afterGet:beta',
      'afterGet:alpha',
    ]);
  });

  it('runs onDestroy hooks via instance.destroy()', async () => {
    const onDestroy = vi.fn();
    const plugin: LocalSpacePlugin = {
      name: 'cleanup',
      onDestroy,
    };
    const instance = new LocalSpace({
      name: 'plugin-destroy',
      storeName: 'plugin-destroy-store',
    });
    instance.use(plugin);

    await instance.setItem('foo', 'bar');
    await instance.destroy();
    await instance.destroy();

    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('combines encryption + compression + ttl correctly', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const store = localspace.createInstance({
      name: 'combo-db',
      storeName: 'combo-store',
      plugins: [
        ttlPlugin({ defaultTTL: 60000 }),
        encryptionPlugin({ key }),
        compressionPlugin({ threshold: 10 }),
      ],
    });

    const payload = { message: 'x'.repeat(100) };
    await store.setItem('combo', payload);

    // Raw reader sees encrypted payload (encryption wraps compressed+ttl payload)
    const rawReader = localspace.createInstance({
      name: 'combo-db',
      storeName: 'combo-store',
    });
    const raw = await rawReader.getItem('combo');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    // Same store can decompress, decrypt, and unwrap TTL
    const restored = await store.getItem<{ message: string }>('combo');
    expect(restored?.message).toBe('x'.repeat(100));
  });

  it('handles plugin errors via onError hook', async () => {
    const errorHandler = vi.fn();
    const failingPlugin: LocalSpacePlugin = {
      name: 'failing',
      onError: errorHandler,
      beforeSet: () => {
        throw new Error('intentional');
      },
    };

    const store = localspace.createInstance({
      name: 'error-db',
      storeName: 'error-store',
      plugins: [failingPlugin],
      pluginErrorPolicy: 'lenient',
    });

    await store.setItem('key', 'value');
    expect(errorHandler).toHaveBeenCalled();
    expect(errorHandler.mock.calls[0][0].message).toBe('intentional');
  });

  it('propagates plugin init errors by default (fail policy)', async () => {
    const failingInitPlugin: LocalSpacePlugin = {
      name: 'failing-init',
      onInit: () => {
        throw new Error('init failed');
      },
    };

    const store = localspace.createInstance({
      name: 'init-fail-db',
      storeName: 'init-fail-store',
      plugins: [failingInitPlugin],
    });

    await store.ready();
    // Plugin init is lazy - triggered on first storage operation
    await expect(store.setItem('key', 'value')).rejects.toThrow('init failed');
  });

  it('disables plugin and continues when pluginInitPolicy is disable-and-continue', async () => {
    const initCalls: string[] = [];
    const setCalls: string[] = [];

    const failingInitPlugin: LocalSpacePlugin = {
      name: 'failing-init',
      onInit: () => {
        initCalls.push('failing');
        throw new Error('init failed');
      },
      beforeSet: (_key, value) => {
        setCalls.push('failing');
        return value;
      },
    };

    const workingPlugin: LocalSpacePlugin = {
      name: 'working',
      onInit: () => {
        initCalls.push('working');
      },
      beforeSet: (_key, value) => {
        setCalls.push('working');
        return value;
      },
    };

    const store = localspace.createInstance({
      name: 'init-disable-db',
      storeName: 'init-disable-store',
      plugins: [failingInitPlugin, workingPlugin],
      pluginInitPolicy: 'disable-and-continue',
    });

    await store.ready();

    // First storage operation triggers plugin init
    await store.setItem('key', 'value');

    // Both plugins attempted init
    expect(initCalls).toContain('failing');
    expect(initCalls).toContain('working');

    // Only working plugin should run hooks (failing one is disabled)
    expect(setCalls).not.toContain('failing');
    expect(setCalls).toContain('working');
  });

  it('provides batch context to plugins', async () => {
    const contexts: Array<{ isBatch?: boolean; batchSize?: number }> = [];
    const observerPlugin: LocalSpacePlugin = {
      name: 'observer',
      beforeSet: (_key, value, context) => {
        contexts.push({
          isBatch: context.operationState.isBatch as boolean,
          batchSize: context.operationState.batchSize as number,
        });
        return value;
      },
    };

    const store = localspace.createInstance({
      name: 'batch-ctx-db',
      storeName: 'batch-ctx-store',
      plugins: [observerPlugin],
    });

    await store.setItem('single', 'value');
    await store.setItems([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);

    expect(contexts[0].isBatch).toBeFalsy();
    expect(contexts[1].isBatch).toBe(true);
    expect(contexts[1].batchSize).toBe(2);
    expect(contexts[2].isBatch).toBe(true);
    expect(contexts[2].batchSize).toBe(2);
  });

});

describe('Plugin batch operations', () => {
  it('ttl plugin wraps batch setItems and unwraps getItems', async () => {
    const store = localspace.createInstance({
      name: 'ttl-batch-db',
      storeName: 'ttl-batch-store',
      plugins: [ttlPlugin({ defaultTTL: 60000 })],
    });

    await store.setItems([
      { key: 'a', value: 'val-a' },
      { key: 'b', value: 'val-b' },
    ]);

    // Raw reader should see TTL payloads
    const rawReader = localspace.createInstance({
      name: 'ttl-batch-db',
      storeName: 'ttl-batch-store',
    });
    const rawA = await rawReader.getItem('a');
    expect(rawA).toMatchObject({ __ls_ttl: true, data: 'val-a' });

    // Batch get with TTL plugin should unwrap
    const result = await store.getItems(['a', 'b']);
    expect(result).toEqual([
      { key: 'a', value: 'val-a' },
      { key: 'b', value: 'val-b' },
    ]);
  });

  it('ttl plugin expires batch items', async () => {
    const onExpire = vi.fn();
    const store = localspace.createInstance({
      name: 'ttl-batch-expire-db',
      storeName: 'ttl-batch-expire-store',
      plugins: [ttlPlugin({ defaultTTL: 10, onExpire })],
    });

    await store.setItems([
      { key: 'x', value: 'expiring-x' },
      { key: 'y', value: 'expiring-y' },
    ]);

    await sleep(25);

    const result = await store.getItems(['x', 'y']);
    expect(result).toEqual([
      { key: 'x', value: null },
      { key: 'y', value: null },
    ]);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });

  it('encryption plugin encrypts batch setItems and decrypts getItems', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const store = localspace.createInstance({
      name: 'enc-batch-db',
      storeName: 'enc-batch-store',
      plugins: [encryptionPlugin({ key })],
    });

    await store.setItems([
      { key: 'secret1', value: { data: 'hidden1' } },
      { key: 'secret2', value: { data: 'hidden2' } },
    ]);

    // Raw reader should see encrypted payloads
    const rawReader = localspace.createInstance({
      name: 'enc-batch-db',
      storeName: 'enc-batch-store',
    });
    const raw1 = await rawReader.getItem('secret1');
    expect(raw1).toMatchObject({ __ls_encrypted: true });

    // Batch get with encryption plugin should decrypt
    const result = await store.getItems<{ data: string }>([
      'secret1',
      'secret2',
    ]);
    expect(result[0].value?.data).toBe('hidden1');
    expect(result[1].value?.data).toBe('hidden2');
  });

  it('compression plugin compresses batch setItems and decompresses getItems', async () => {
    const largePayload1 = 'a'.repeat(2000);
    const largePayload2 = 'b'.repeat(2000);
    const store = localspace.createInstance({
      name: 'compress-batch-db',
      storeName: 'compress-batch-store',
      plugins: [compressionPlugin({ threshold: 512 })],
    });

    await store.setItems([
      { key: 'large1', value: largePayload1 },
      { key: 'large2', value: largePayload2 },
    ]);

    // Raw reader should see compressed payloads
    const rawReader = localspace.createInstance({
      name: 'compress-batch-db',
      storeName: 'compress-batch-store',
    });
    const raw1 = await rawReader.getItem('large1');
    expect(raw1).toMatchObject({ __ls_compressed: true });

    // Batch get with compression plugin should decompress
    const result = await store.getItems<string>(['large1', 'large2']);
    expect(result[0].value).toBe(largePayload1);
    expect(result[1].value).toBe(largePayload2);
  });

  it('combined plugins work correctly with batch operations', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const store = localspace.createInstance({
      name: 'combo-batch-db',
      storeName: 'combo-batch-store',
      plugins: [
        ttlPlugin({ defaultTTL: 60000 }),
        compressionPlugin({ threshold: 10 }),
        encryptionPlugin({ key }),
      ],
    });

    const items = [
      { key: 'item1', value: { msg: 'x'.repeat(100) } },
      { key: 'item2', value: { msg: 'y'.repeat(100) } },
    ];

    await store.setItems(items);

    // Raw reader should see encrypted (outermost layer)
    const rawReader = localspace.createInstance({
      name: 'combo-batch-db',
      storeName: 'combo-batch-store',
    });
    const raw = await rawReader.getItem('item1');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    // Batch get through plugins should unwrap all layers
    const result = await store.getItems<{ msg: string }>(['item1', 'item2']);
    expect(result[0].value?.msg).toBe('x'.repeat(100));
    expect(result[1].value?.msg).toBe('y'.repeat(100));
  });
});

describe('Plugin edge cases and combinations', () => {
  it('encryption + compression: order matters for security', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    // Correct order: compress first, then encrypt
    const correctStore = localspace.createInstance({
      name: 'order-correct-db',
      storeName: 'order-correct-store',
      plugins: [
        compressionPlugin({ threshold: 10 }),
        encryptionPlugin({ key }),
      ],
    });

    const payload = 'a'.repeat(500);
    await correctStore.setItem('data', payload);

    // Raw should show encrypted (encryption is outermost)
    const rawReader = localspace.createInstance({
      name: 'order-correct-db',
      storeName: 'order-correct-store',
    });
    const raw = await rawReader.getItem('data');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    // Should decrypt and decompress correctly
    const result = await correctStore.getItem<string>('data');
    expect(result).toBe(payload);
  });

  it('built-in data plugins work together', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    // Create separate plugin instances for each store to avoid shared state
    const createPlugins = () => [
      ttlPlugin({ defaultTTL: 60000 }),
      compressionPlugin({ threshold: 10 }),
      encryptionPlugin({ key }),
    ];

    const primary = localspace.createInstance({
      name: 'data-plugins-db',
      storeName: 'data-plugins-store',
      plugins: createPlugins(),
    });

    const secondary = localspace.createInstance({
      name: 'data-plugins-db',
      storeName: 'data-plugins-store',
      plugins: createPlugins(),
    });

    const payload = { data: 'x'.repeat(200) };
    await primary.setItem('complex', payload);

    // Verify through a second instance sharing the same database.
    const result = await secondary.getItem<{ data: string }>('complex');
    expect(result?.data).toBe('x'.repeat(200));

    // Batch operations - test with same instance first
    await primary.setItems([
      { key: 'b1', value: { n: 1 } },
      { key: 'b2', value: { n: 2 } },
    ]);

    // Verify batch operations work on same instance
    const primaryBatch = await primary.getItems<{ n: number }>(['b1', 'b2']);
    expect(primaryBatch[0].value?.n).toBe(1);
    expect(primaryBatch[1].value?.n).toBe(2);

    // Verify batch operations work through the shared database.
    const batchResult = await secondary.getItems<{ n: number }>(['b1', 'b2']);
    expect(batchResult[0].value?.n).toBe(1);
    expect(batchResult[1].value?.n).toBe(2);
  });

  it('handles mixed batch with some items below compression threshold', async () => {
    const store = localspace.createInstance({
      name: 'mixed-compress-db',
      storeName: 'mixed-compress-store',
      plugins: [compressionPlugin({ threshold: 100 })],
    });

    await store.setItems([
      { key: 'small', value: 'tiny' }, // below threshold
      { key: 'large', value: 'x'.repeat(200) }, // above threshold
    ]);

    const rawReader = localspace.createInstance({
      name: 'mixed-compress-db',
      storeName: 'mixed-compress-store',
    });

    const rawSmall = await rawReader.getItem('small');
    const rawLarge = await rawReader.getItem('large');

    expect(rawSmall).toBe('tiny'); // not compressed
    expect(rawLarge).toMatchObject({ __ls_compressed: true }); // compressed

    // Both should read correctly
    const result = await store.getItems<string>(['small', 'large']);
    expect(result[0].value).toBe('tiny');
    expect(result[1].value).toBe('x'.repeat(200));
  });

  it('handles empty batch operations gracefully', async () => {
    const store = localspace.createInstance({
      name: 'empty-batch-db',
      storeName: 'empty-batch-store',
      plugins: [
        ttlPlugin({ defaultTTL: 60000 }),
        compressionPlugin({ threshold: 100 }),
      ],
    });

    // Empty setItems
    await store.setItems([]);

    // Empty getItems
    const result = await store.getItems([]);
    expect(result).toEqual([]);

    // Empty removeItems
    await store.removeItems([]);
  });

  it('per-key TTL works with batch operations', async () => {
    const store = localspace.createInstance({
      name: 'per-key-ttl-db',
      storeName: 'per-key-ttl-store',
      plugins: [
        ttlPlugin({
          defaultTTL: 60000,
          keyTTL: {
            'short-lived': 10,
          },
        }),
      ],
    });

    await store.setItems([
      { key: 'short-lived', value: 'expires-fast' },
      { key: 'long-lived', value: 'stays-around' },
    ]);

    await sleep(25);

    const result = await store.getItems(['short-lived', 'long-lived']);
    expect(result[0].value).toBeNull(); // expired
    expect(result[1].value).toBe('stays-around'); // still valid
  });

  it('encryption errors are propagated correctly in batch', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const store = localspace.createInstance({
      name: 'enc-error-batch-db',
      storeName: 'enc-error-batch-store',
      plugins: [encryptionPlugin({ key })],
    });

    await store.setItems([{ key: 'valid', value: 'secret' }]);

    // Tamper with the encrypted data
    const rawReader = localspace.createInstance({
      name: 'enc-error-batch-db',
      storeName: 'enc-error-batch-store',
    });
    const raw = await rawReader.getItem('valid');
    if (raw && typeof raw === 'object') {
      await rawReader.setItem('valid', {
        ...raw,
        data: 'tampered-data',
      });
    }

    // Batch get should fail on decryption
    await expect(store.getItems(['valid'])).rejects.toThrow(
      'Failed to decrypt'
    );
  });
});
