import { describe, expect, it, vi } from 'vitest';
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
import {
  createStoredRecord,
  decodeStoredRecordValue,
  readStoredRecord,
  STORED_RECORD_CODEC,
  STORED_RECORD_NAMESPACE,
  STORED_RECORD_VERSION,
  type StoredRecordV1,
} from '../src/core/stored-record';
import {
  getRawMemoryValue,
  setRawMemoryItems,
  setRawMemoryValue,
} from './utils/raw-memory';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createPair = async (
  driverKey: 'MEMORY' | 'INDEXEDDB' | 'LOCALSTORAGE',
  plugins: LocalSpacePlugin[] = []
): Promise<{ reader: LocalSpaceInstance; raw: LocalSpaceInstance }> => {
  const options = {
    name: uniqueName(`stored-record-${driverKey.toLowerCase()}`),
    storeName: 'store',
  };
  const reader = localspace.createInstance({ ...options, plugins });
  const raw = localspace.createInstance(options);
  await reader.setDriver([reader[driverKey]]);
  await raw.setDriver([raw[driverKey]]);
  await reader.ready();
  await raw.ready();
  await raw.clear();
  return { reader, raw };
};

const byteValues = (value: ArrayBufferView | ArrayBuffer): number[] => {
  if (value instanceof ArrayBuffer) {
    return [...new Uint8Array(value)];
  }
  return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
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

describe('StoredRecord v1 contract', () => {
  it('pins the namespace, version, and canonical codec', () => {
    const record = createStoredRecord({ answer: 42 });

    expect(record).toMatchObject({
      __localspace__: {
        namespace: STORED_RECORD_NAMESPACE,
        version: STORED_RECORD_VERSION,
      },
      payload: { codec: STORED_RECORD_CODEC },
    });
    expect(readStoredRecord(record)).toEqual({
      matched: true,
      value: { answer: 42 },
    });
  });

  it('round-trips every StorageValue family and canonicalizes object keys/-0', () => {
    const nullPrototype = Object.create(null) as Record<string, StorageValue>;
    nullPrototype.z = 'last';
    nullPrototype.a = -0;

    const binaries: ArrayBufferView[] = [
      new Int8Array([-1, 2]),
      new Uint8Array([1, 2]),
      new Uint8ClampedArray([0, 255]),
      new Int16Array([-2, 3]),
      new Uint16Array([2, 3]),
      new Int32Array([-4, 5]),
      new Uint32Array([4, 5]),
      new Float32Array([1.5, -2.25]),
      new Float64Array([Math.PI]),
    ];
    if (typeof BigInt64Array !== 'undefined') {
      binaries.push(new BigInt64Array([-1n, 2n]));
    }
    if (typeof BigUint64Array !== 'undefined') {
      binaries.push(new BigUint64Array([1n, 2n]));
    }

    const sourceBuffer = new Uint8Array([9, 1, 2, 8]);
    const value: StorageValue = {
      z: [null, false, 'value'],
      a: nullPrototype,
      buffer: sourceBuffer.buffer,
      view: sourceBuffer.subarray(1, 3),
      binaries: binaries as StorageValue[],
    };
    const record = createStoredRecord(value);
    const result = readStoredRecord(record);

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    const decoded = result.value as Record<string, StorageValue>;
    expect(Object.keys(decoded)).toEqual([
      'a',
      'binaries',
      'buffer',
      'view',
      'z',
    ]);
    expect(Object.getPrototypeOf(decoded.a as object)).toBeNull();
    expect((decoded.a as Record<string, StorageValue>).a).toBe(0);
    expect(Object.is((decoded.a as Record<string, StorageValue>).a, -0)).toBe(
      false
    );
    expect(byteValues(decoded.buffer as ArrayBuffer)).toEqual([9, 1, 2, 8]);
    expect(byteValues(decoded.view as Uint8Array)).toEqual([1, 2]);

    const decodedBinaries = decoded.binaries as StorageBinaryLike[];
    expect(decodedBinaries.map((entry) => entry.constructor.name)).toEqual(
      binaries.map((entry) => entry.constructor.name)
    );
    expect(decodedBinaries.map(byteValues)).toEqual(binaries.map(byteValues));
  });

  it('produces the same record for equivalent object insertion orders', () => {
    expect(createStoredRecord({ z: 1, a: 2 })).toEqual(
      createStoredRecord({ a: 2, z: 1 })
    );
  });

  it('encodes an exact valid record-shaped user object without recursion', () => {
    const collision = createStoredRecord('application value');
    const outer = createStoredRecord(collision as unknown as StorageValue);

    expect(decodeStoredRecordValue(outer)).toEqual(collision);
    expect(decodeStoredRecordValue(outer)).not.toBe('application value');
  });

  it('leaves unrelated marker lookalikes untouched', () => {
    const lookalike = {
      __localspace__: { namespace: 'application.data', version: 1 },
      payload: { codec: STORED_RECORD_CODEC, data: 'value' },
    };
    expect(readStoredRecord(lookalike)).toEqual({ matched: false });
    expect(decodeStoredRecordValue(lookalike)).toBe(lookalike);
  });

  it('rejects unknown versions and malformed canonical payloads', () => {
    const unknownVersion = createStoredRecord('value') as unknown as {
      __localspace__: { namespace: string; version: number };
    };
    unknownVersion.__localspace__.version = 99;
    expect(() => readStoredRecord(unknownVersion)).toThrowError(
      expect.objectContaining({
        code: 'DESERIALIZATION_FAILED',
        details: expect.objectContaining({
          recordVersion: 99,
          supportedRecordVersions: [1],
        }),
      })
    );

    const malformed: StoredRecordV1 = {
      __localspace__: {
        namespace: STORED_RECORD_NAMESPACE,
        version: STORED_RECORD_VERSION,
      },
      payload: {
        codec: STORED_RECORD_CODEC,
        data: {
          type: 'object',
          prototype: 'object',
          entries: [
            ['z', 1],
            ['a', 2],
          ],
        },
      },
    };
    const before = JSON.stringify(malformed);
    expect(() => readStoredRecord(malformed)).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );
    expect(JSON.stringify(malformed)).toBe(before);
  });

  it('does not invoke accessors in a recognized malformed record', () => {
    const getter = vi.fn(() => 'secret');
    const malformed = createStoredRecord('safe') as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(malformed.payload, 'data', {
      enumerable: true,
      get: getter,
    });

    expect(() => readStoredRecord(malformed)).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );
    expect(getter).not.toHaveBeenCalled();
  });
});

type StorageBinaryLike = ArrayBuffer | ArrayBufferView;

describe('3.0 StoredRecord writer and legacy reader', () => {
  it.each(['MEMORY', 'INDEXEDDB', 'LOCALSTORAGE'] as const)(
    'wraps every %s write and decodes exactly one record',
    async (driverKey) => {
      const { reader } = await createPair(driverKey);
      const logical = { nested: ['value', 42] };
      const recordShapedUserValue = createStoredRecord(
        'application value'
      ) as unknown as StorageValue;

      await expect(reader.setItem('logical', logical)).resolves.toEqual(
        logical
      );
      await expect(reader.getItem('logical')).resolves.toEqual(logical);
      await reader.setItem('record-shaped-user-value', recordShapedUserValue);
      await expect(reader.getItem('record-shaped-user-value')).resolves.toEqual(
        recordShapedUserValue
      );
    }
  );

  it('wraps batch and transaction writes without consuming record-shaped application values', async () => {
    const { reader } = await createPair('MEMORY');
    const config = {
      name: reader.config('name'),
      storeName: reader.config('storeName'),
    };
    const recordShapedUserValue = createStoredRecord(
      'application value'
    ) as unknown as StorageValue;

    await expect(
      reader.setItems([{ key: 'batch', value: recordShapedUserValue }])
    ).resolves.toEqual([{ key: 'batch', value: recordShapedUserValue }]);
    await expect(reader.getItems(['batch'])).resolves.toEqual([
      { key: 'batch', value: recordShapedUserValue },
    ]);
    expect(readStoredRecord(await getRawMemoryValue(config, 'batch'))).toEqual({
      matched: true,
      value: recordShapedUserValue,
    });

    await reader.runTransaction('readwrite', async (scope) => {
      await expect(
        scope.set('transaction', recordShapedUserValue)
      ).resolves.toEqual(recordShapedUserValue);
      await expect(scope.get('transaction')).resolves.toEqual(
        recordShapedUserValue
      );
    });
    await expect(reader.getItem('transaction')).resolves.toEqual(
      recordShapedUserValue
    );
    expect(
      readStoredRecord(await getRawMemoryValue(config, 'transaction'))
    ).toEqual({ matched: true, value: recordShapedUserValue });
  });

  it.each([
    [
      'ttl' as const,
      ttlPlugin({ defaultTTL: 60_000 }),
      createPluginEnvelope('ttl', {
        data: 'application data',
        expiresAt: 1,
      }),
    ],
    [
      'compression' as const,
      compressionPlugin({ threshold: 0 }),
      createPluginEnvelope('compression', {
        algorithm: 'lz-string',
        data: 'AAAA',
        originalSize: 1,
      }),
    ],
    [
      'encryption' as const,
      encryptionPlugin({
        key: '0123456789abcdef0123456789abcdef',
        ivGenerator: () => new Uint8Array(12),
      }),
      createPluginEnvelope('encryption', {
        algorithm: 'AES-GCM',
        iv: 'AAAAAAAAAAAAAAAA',
        data: 'AAAA',
      }),
    ],
  ])(
    'preserves an exact valid %s envelope-shaped application value',
    async (_kind, plugin, envelope) => {
      const { reader } = await createPair('MEMORY', [plugin]);
      const value = envelope as unknown as StorageValue;

      await expect(reader.setItem('collision', value)).resolves.toEqual(value);
      await expect(reader.getItem('collision')).resolves.toEqual(value);
    }
  );

  it('retains physical 2.1-compatible records in batch, iteration, and transaction reads', async () => {
    const { reader } = await createPair('MEMORY');
    const config = {
      name: reader.config('name'),
      storeName: reader.config('storeName'),
    };
    await setRawMemoryItems(config, [
      { key: 'a', value: createStoredRecord({ value: 1 }) },
      { key: 'b', value: createStoredRecord({ value: 2 }) },
    ]);

    await expect(reader.getItems(['a', 'b'])).resolves.toEqual([
      { key: 'a', value: { value: 1 } },
      { key: 'b', value: { value: 2 } },
    ]);

    const iterated: unknown[] = [];
    await reader.iterate((value) => {
      iterated.push(value);
    });
    expect(iterated).toEqual([{ value: 1 }, { value: 2 }]);

    await reader.runTransaction('readonly', async (scope) => {
      await expect(scope.get('a')).resolves.toEqual({ value: 1 });
      const values: unknown[] = [];
      await scope.iterate((value) => {
        values.push(value);
      });
      expect(values).toEqual([{ value: 1 }, { value: 2 }]);
    });
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
    'reads a core record wrapped in the frozen %s envelope',
    async (kind, plugin) => {
      const { reader, raw } = await createPair('MEMORY', [plugin]);
      const config = {
        name: reader.config('name'),
        storeName: reader.config('storeName'),
      };
      const logical = {
        message:
          kind === 'compression'
            ? `future-${kind}-${'x'.repeat(1_000)}`
            : `future-${kind}`,
      };

      await reader.setItem('legacy-transform', logical);
      const legacyTransform = await raw.getItem('legacy-transform');
      await setRawMemoryValue(
        config,
        'future-transform',
        versionLegacyTransform(kind, legacyTransform)
      );

      await expect(reader.getItem('future-transform')).resolves.toEqual(
        logical
      );
    }
  );
});
