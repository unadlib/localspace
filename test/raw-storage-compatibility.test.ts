import { describe, expect, it } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
  type LocalSpaceInstance,
  type LocalSpacePlugin,
  type StorageValue,
} from '../src';
import {
  createPluginEnvelope,
  readPluginEnvelope,
  type PluginEnvelopeKind,
} from '../src/core/plugin-envelope';
import { getRawMemoryValue, setRawMemoryValue } from './utils/raw-memory';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createPair = async (
  driverKey: 'MEMORY' | 'INDEXEDDB' | 'LOCALSTORAGE',
  plugins: LocalSpacePlugin[] = []
): Promise<{
  options: { name: string; storeName: string };
  reader: LocalSpaceInstance;
  raw: LocalSpaceInstance;
}> => {
  const options = {
    name: uniqueName(`raw-storage-${driverKey.toLowerCase()}`),
    storeName: 'store',
  };
  const reader = localspace.createInstance({ ...options, plugins });
  const raw = localspace.createInstance(options);
  await reader.setDriver([reader[driverKey]]);
  await raw.setDriver([raw[driverKey]]);
  await reader.ready();
  await raw.ready();
  await raw.clear();
  return { options, reader, raw };
};

const versionLegacyTransform = (
  kind: PluginEnvelopeKind,
  value: unknown
): unknown => {
  if (readPluginEnvelope(value, kind).matched) {
    return value;
  }
  const legacy = value as Record<string, unknown>;
  switch (kind) {
    case 'encryption':
      return createPluginEnvelope(kind, {
        algorithm: legacy.algorithm,
        iv: legacy.iv,
        data: legacy.data,
      });
    case 'compression':
      return createPluginEnvelope(kind, {
        algorithm: legacy.algorithm,
        originalSize: legacy.originalSize,
        data: legacy.data,
      });
    case 'ttl':
      return createPluginEnvelope(kind, {
        data: legacy.data,
        expiresAt: legacy.expiresAt,
      });
  }
};

describe('raw StorageValue persistence', () => {
  it.each(['MEMORY', 'INDEXEDDB', 'LOCALSTORAGE'] as const)(
    'round-trips ordinary JSON without a core record through %s',
    async (driverKey) => {
      const { reader, raw } = await createPair(driverKey);
      const logical = { nested: ['value', 42], enabled: true };

      await expect(reader.setItem('logical', logical)).resolves.toEqual(
        logical
      );
      await expect(reader.getItem('logical')).resolves.toEqual(logical);
      await expect(raw.getItem('logical')).resolves.toEqual(logical);
    }
  );

  it('stores ordinary memory values in their logical shape', async () => {
    const { options, reader } = await createPair('MEMORY');
    const value = { id: 1, name: 'Ada', tags: ['storage'] };

    await reader.setItem('value', value);

    await expect(getRawMemoryValue(options, 'value')).resolves.toEqual(value);
  });

  it('keeps batch and transaction values raw', async () => {
    const { options, reader } = await createPair('MEMORY');

    await reader.setItems([{ key: 'batch', value: { source: 'batch' } }]);
    await reader.runTransaction('readwrite', async (scope) => {
      await scope.set('transaction', { source: 'transaction' });
    });

    await expect(getRawMemoryValue(options, 'batch')).resolves.toEqual({
      source: 'batch',
    });
    await expect(getRawMemoryValue(options, 'transaction')).resolves.toEqual({
      source: 'transaction',
    });
  });

  it('does not reinterpret the abandoned core-record namespace', async () => {
    const { options, reader } = await createPair('MEMORY');
    const applicationValue = {
      __localspace__: { namespace: 'localspace.record', version: 1 },
      payload: {
        codec: 'localspace.storage-value',
        data: { type: 'object', entries: [['answer', 42]] },
      },
    };
    await setRawMemoryValue(options, 'legacy-shape', applicationValue);

    await expect(reader.getItem('legacy-shape')).resolves.toEqual(
      applicationValue
    );
  });

  it.each(['ttl', 'compression', 'encryption'] as const)(
    'reserves the top-level %s plugin envelope namespace for transforms',
    async (kind) => {
      const { reader } = await createPair('MEMORY');
      const value = createPluginEnvelope(kind, { data: 'application' });

      await expect(
        reader.setItem('collision', value as unknown as StorageValue)
      ).rejects.toMatchObject({
        code: 'SERIALIZATION_FAILED',
        details: expect.objectContaining({
          valuePath: '$',
          valueReason: expect.stringContaining('reserved'),
        }),
      });
    }
  );

  it('rejects a reserved envelope produced by a logical plugin', async () => {
    const { reader } = await createPair('MEMORY', [
      {
        name: 'reserved-output',
        beforeSet: () =>
          createPluginEnvelope('ttl', {
            data: 'plugin-output',
            expiresAt: Date.now() + 60_000,
          }) as never,
      },
    ]);

    await expect(reader.setItem('collision', 'input')).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: expect.objectContaining({
        plugin: 'reserved-output',
        valueSource: 'plugin-output',
        valueReason: expect.stringContaining('reserved'),
      }),
    });
  });

  it('allows plugin-shaped data below the logical root', async () => {
    const { reader } = await createPair('MEMORY');
    const value = {
      metadata: createPluginEnvelope('ttl', {
        data: 'application',
        expiresAt: 1,
      }),
    } as unknown as StorageValue;

    await expect(reader.setItem('nested-marker', value)).resolves.toEqual(
      value
    );
    await expect(reader.getItem('nested-marker')).resolves.toEqual(value);
  });

  it('applies the same envelope reservation to batch and transaction writes', async () => {
    const { reader } = await createPair('MEMORY');
    const value = createPluginEnvelope('ttl', {
      data: 'application',
      expiresAt: Date.now() + 60_000,
    }) as unknown as StorageValue;

    await expect(
      reader.setItems([{ key: 'batch', value }])
    ).rejects.toMatchObject({ code: 'SERIALIZATION_FAILED' });
    await expect(
      reader.runTransaction('readwrite', (scope) =>
        scope.set('transaction', value)
      )
    ).rejects.toMatchObject({ code: 'SERIALIZATION_FAILED' });
  });

  it('stores a raw logical value inside a TTL envelope', async () => {
    const { reader, raw } = await createPair('MEMORY', [
      ttlPlugin({ defaultTTL: 60_000 }),
    ]);
    const logical = { source: 'ttl', nested: [1, 2] };

    await reader.setItem('ttl', logical);
    const physical = await raw.getItem('ttl');
    const parsed = readPluginEnvelope<{ data: unknown }>(physical, 'ttl');

    expect(parsed).toMatchObject({ matched: true });
    if (parsed.matched) {
      expect(parsed.payload.data).toEqual(logical);
    }
    await expect(reader.getItem('ttl')).resolves.toEqual(logical);
  });

  it.each([
    ['ttl' as const, ttlPlugin({ defaultTTL: 60_000 })],
    ['compression' as const, compressionPlugin({ threshold: 0 })],
    [
      'encryption' as const,
      encryptionPlugin({
        key: '0123456789abcdef0123456789abcdef',
        ivGenerator: () => new Uint8Array(12),
      }),
    ],
  ])(
    'reads logical data from the frozen %s plugin envelope',
    async (kind, plugin) => {
      const { options, reader, raw } = await createPair('MEMORY', [plugin]);
      const logical = {
        message:
          kind === 'compression'
            ? `future-${kind}-${'x'.repeat(1_000)}`
            : `future-${kind}`,
      };

      await reader.setItem('legacy-transform', logical);
      const legacyTransform = await raw.getItem('legacy-transform');
      await setRawMemoryValue(
        options,
        'future-transform',
        versionLegacyTransform(kind, legacyTransform)
      );

      await expect(reader.getItem('future-transform')).resolves.toEqual(
        logical
      );
    }
  );
});
