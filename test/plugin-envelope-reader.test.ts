import { describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
  type LocalSpacePlugin,
  type PluginContext,
} from '../src';
import {
  PLUGIN_ENVELOPE_NAMESPACE,
  PLUGIN_ENVELOPE_PROPERTY,
  PLUGIN_ENVELOPE_VERSION,
  readPluginEnvelope,
  type PluginEnvelopeKind,
  type PluginEnvelopeV1,
} from '../src/core/plugin-envelope';
import { readStoredRecord } from '../src/core/stored-record';
import { getRawMemoryValue, setRawMemoryValue } from './utils/raw-memory';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const envelope = <T>(
  kind: PluginEnvelopeKind,
  payload: T
): PluginEnvelopeV1<T> => ({
  [PLUGIN_ENVELOPE_PROPERTY]: {
    namespace: PLUGIN_ENVELOPE_NAMESPACE,
    kind,
    version: PLUGIN_ENVELOPE_VERSION,
  },
  payload,
});

const createStorePair = async (prefix: string, plugin: LocalSpacePlugin) => {
  const name = uniqueName(prefix);
  const options = { name, storeName: 'store' };
  const store = localspace.createInstance({ ...options, plugins: [plugin] });
  await store.setDriver([store.MEMORY]);
  const raw = {
    getItem: async <T = unknown>(key: string): Promise<T | null> =>
      (await getRawMemoryValue(options, key)) as T | null,
    setItem: async <T>(key: string, value: T): Promise<T> => {
      await setRawMemoryValue(options, key, value);
      return value;
    },
  };
  return { store, raw };
};

const pluginReadContext = {
  operationState: Object.create(null) as Record<string, unknown>,
} as PluginContext;

describe('versioned plugin envelope reader', () => {
  it('recognizes only the reserved namespace and expected kind', () => {
    const valid = envelope('ttl', { data: 'value', expiresAt: 123 });
    expect(readPluginEnvelope(valid, 'ttl')).toEqual({
      matched: true,
      payload: { data: 'value', expiresAt: 123 },
    });
    expect(readPluginEnvelope(valid, 'compression')).toEqual({
      matched: false,
    });
    expect(
      readPluginEnvelope(
        {
          __localspace__: {
            namespace: 'application.data',
            kind: 'ttl',
            version: 1,
          },
          payload: 'user value',
        },
        'ttl'
      )
    ).toEqual({ matched: false });
  });

  it('rejects unknown versions and missing payloads explicitly', () => {
    expect(() =>
      readPluginEnvelope(
        {
          __localspace__: {
            namespace: PLUGIN_ENVELOPE_NAMESPACE,
            kind: 'ttl',
            version: 99,
          },
          payload: {},
        },
        'ttl'
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'DESERIALIZATION_FAILED',
        details: {
          payloadKind: 'ttl',
          payloadVersion: 99,
          supportedPayloadVersions: [1],
        },
      })
    );
    expect(() =>
      readPluginEnvelope(
        {
          __localspace__: {
            namespace: PLUGIN_ENVELOPE_NAMESPACE,
            kind: 'compression',
            version: 1,
          },
        },
        'compression'
      )
    ).toThrowError(expect.objectContaining({ code: 'DESERIALIZATION_FAILED' }));
  });

  it('rejects extended envelope shapes without invoking accessors', () => {
    const extraOuter = {
      ...envelope('ttl', { data: 'value', expiresAt: 123 }),
      applicationField: true,
    };
    expect(() => readPluginEnvelope(extraOuter, 'ttl')).toThrowError(
      expect.objectContaining({
        code: 'DESERIALIZATION_FAILED',
        details: expect.objectContaining({
          payloadKind: 'ttl',
          reason: 'invalid envelope shape',
        }),
      })
    );

    const extraHeader = envelope('ttl', { data: 'value', expiresAt: 123 }) as
      PluginEnvelopeV1<unknown> & {
        __localspace__: PluginEnvelopeV1<unknown>['__localspace__'] & {
          applicationField: boolean;
        };
      };
    extraHeader.__localspace__.applicationField = true;
    expect(() => readPluginEnvelope(extraHeader, 'ttl')).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );

    const payloadGetter = vi.fn(() => ({ data: 'secret', expiresAt: 123 }));
    const accessorEnvelope = {
      __localspace__: {
        namespace: PLUGIN_ENVELOPE_NAMESPACE,
        kind: 'ttl',
        version: PLUGIN_ENVELOPE_VERSION,
      },
    } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, 'payload', {
      enumerable: true,
      get: payloadGetter,
    });

    expect(() => readPluginEnvelope(accessorEnvelope, 'ttl')).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );
    expect(payloadGetter).not.toHaveBeenCalled();
  });

  it.each([
    [
      'versioned TTL',
      ttlPlugin(),
      envelope('ttl', {
        data: 'value',
        expiresAt: Date.now() + 60_000,
        applicationField: true,
      }),
    ],
    [
      'legacy TTL',
      ttlPlugin(),
      {
        __ls_ttl: true,
        data: 'value',
        expiresAt: Date.now() + 60_000,
        applicationField: true,
      },
    ],
    [
      'versioned compression',
      compressionPlugin(),
      envelope('compression', {
        algorithm: 'lz-string',
        data: 'AAAA',
        originalSize: 1,
        applicationField: true,
      }),
    ],
    [
      'legacy compression',
      compressionPlugin(),
      {
        __ls_compressed: true,
        algorithm: 'lz-string',
        data: 'AAAA',
        originalSize: 1,
        applicationField: true,
      },
    ],
    [
      'versioned encryption',
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
      envelope('encryption', {
        algorithm: 'AES-GCM',
        iv: 'AAAAAAAAAAAAAAAA',
        data: 'AAAA',
        applicationField: true,
      }),
    ],
    [
      'legacy encryption',
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
      {
        __ls_encrypted: true,
        algorithm: 'AES-GCM',
        iv: 'AAAAAAAAAAAAAAAA',
        data: 'AAAA',
        applicationField: true,
      },
    ],
  ])('rejects an extended %s payload without mutating it', async (
    label,
    plugin,
    malformed
  ) => {
    const { store, raw } = await createStorePair(
      `extended-${String(label).replaceAll(' ', '-')}`,
      plugin
    );
    await raw.setItem('malformed', malformed);

    await expect(store.getItem('malformed')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
    });
    await expect(raw.getItem('malformed')).resolves.toEqual(malformed);
  });

  it('does not invoke accessors while validating a recognized payload', async () => {
    const expiresAtGetter = vi.fn(() => Date.now() + 60_000);
    const payload = { data: 'secret' } as Record<string, unknown>;
    Object.defineProperty(payload, 'expiresAt', {
      enumerable: true,
      get: expiresAtGetter,
    });

    await expect(
      ttlPlugin().afterGet!(
        'accessor',
        envelope('ttl', payload) as never,
        pluginReadContext
      )
    ).rejects.toMatchObject({ code: 'DESERIALIZATION_FAILED' });
    expect(expiresAtGetter).not.toHaveBeenCalled();
  });

  it('writes versioned TTL payloads and retains the legacy reader', async () => {
    const { store, raw } = await createStorePair(
      'ttl-envelope-reader',
      ttlPlugin({ defaultTTL: 60_000 })
    );
    await store.setItem('versioned', { source: '3.0' });
    const physical = await raw.getItem<
      PluginEnvelopeV1<{
        data: unknown;
        expiresAt: number;
      }>
    >('versioned');
    expect(physical).toMatchObject({
      __localspace__: {
        namespace: 'localspace.plugin',
        kind: 'ttl',
        version: 1,
      },
    });
    expect(readStoredRecord(physical?.payload.data)).toEqual({
      matched: true,
      value: { source: '3.0' },
    });

    await raw.setItem('legacy', {
      __ls_ttl: true,
      data: { source: '2.x' },
      expiresAt: Date.now() + 60_000,
    });
    await expect(store.getItem('legacy')).resolves.toEqual({ source: '2.x' });
  });

  it('preserves legacy TTL representations for undefined and infinite expiry', async () => {
    const plugin = ttlPlugin({ defaultTTL: Number.POSITIVE_INFINITY });
    const { store, raw } = await createStorePair(
      'ttl-legacy-representations',
      plugin
    );

    await store.setItem('infinite', 'value');
    await expect(store.getItem('infinite')).resolves.toBe('value');
    expect(readStoredRecord(await raw.getItem('infinite'))).toEqual({
      matched: true,
      value: 'value',
    });

    await expect(
      plugin.afterGet!(
        'undefined',
        { __ls_ttl: true, expiresAt: Date.now() + 60_000 } as never,
        pluginReadContext
      )
    ).resolves.toBeNull();
    await expect(
      plugin.afterGet!(
        'infinite',
        {
          __ls_ttl: true,
          data: 'value',
          expiresAt: Number.POSITIVE_INFINITY,
        } as never,
        pluginReadContext
      )
    ).resolves.toBe('value');
  });

  it('rejects undefined before TTL or JSON-backed storage can transform it', async () => {
    const store = localspace.createInstance({
      name: uniqueName('ttl-undefined-localstorage'),
      storeName: 'store',
      plugins: [ttlPlugin({ defaultTTL: 60_000 })],
    });
    await store.setDriver([store.LOCALSTORAGE]);

    await expect(
      store.setItem('undefined', undefined as never)
    ).rejects.toMatchObject({ code: 'SERIALIZATION_FAILED' });
    await expect(store.keys()).resolves.toEqual([]);
  });

  it('keeps versioned TTL payload validation strict', async () => {
    const { store, raw } = await createStorePair(
      'ttl-versioned-validation',
      ttlPlugin()
    );

    await raw.setItem(
      'missing-data',
      envelope('ttl', { expiresAt: Date.now() + 60_000 })
    );
    await expect(store.getItem('missing-data')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
    });

    const plugin = ttlPlugin();
    await expect(
      plugin.afterGet!(
        'infinite-expiry',
        envelope('ttl', {
          data: 'value',
          expiresAt: Number.POSITIVE_INFINITY,
        }) as never,
        pluginReadContext
      )
    ).rejects.toMatchObject({ code: 'DESERIALIZATION_FAILED' });
  });

  it('writes versioned compression envelopes and retains the legacy reader', async () => {
    const { store, raw } = await createStorePair(
      'compression-envelope-reader',
      compressionPlugin({ threshold: 0 })
    );
    const original = { source: '3.0', text: 'x'.repeat(200) };
    await store.setItem('versioned', original);
    const versioned = await raw.getItem('versioned');
    const parsed = readPluginEnvelope<Record<string, unknown>>(
      versioned,
      'compression'
    );
    expect(parsed.matched).toBe(true);
    if (!parsed.matched) {
      throw new Error('Versioned compression payload missing');
    }
    await expect(store.getItem('versioned')).resolves.toEqual(original);

    await raw.setItem('legacy', {
      __ls_compressed: true,
      ...parsed.payload,
    });
    await expect(store.getItem('legacy')).resolves.toEqual(original);
  });

  it('reads legacy empty compression labels but rejects them in versioned envelopes', async () => {
    const { store, raw } = await createStorePair(
      'compression-empty-algorithm',
      compressionPlugin({ threshold: 0 })
    );
    const original = { source: '2.x', text: 'x'.repeat(200) };

    await store.setItem('seed', original);
    const seed = readPluginEnvelope<Record<string, unknown>>(
      await raw.getItem('seed'),
      'compression'
    );
    if (!seed.matched) {
      throw new Error('Versioned compression payload missing');
    }
    const legacy = {
      __ls_compressed: true,
      algorithm: '',
      data: seed.payload.data,
      originalSize: seed.payload.originalSize,
    };
    await raw.setItem('legacy', legacy);
    await expect(store.getItem('legacy')).resolves.toEqual(original);

    const { __ls_compressed: _marker, ...payload } = legacy!;
    await raw.setItem('versioned', envelope('compression', payload));
    await expect(store.getItem('versioned')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
    });
  });

  it('writes versioned encryption envelopes and retains the legacy GCM reader', async () => {
    const { store, raw } = await createStorePair(
      'encryption-envelope-reader',
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' })
    );
    const original = { source: '3.0', secret: true };
    await store.setItem('versioned', original);
    const versioned = readPluginEnvelope<Record<string, unknown>>(
      await raw.getItem('versioned'),
      'encryption'
    );
    expect(versioned.matched).toBe(true);
    if (!versioned.matched) {
      throw new Error('Versioned encryption payload missing');
    }
    expect(versioned.payload).toMatchObject({ algorithm: 'AES-GCM' });
    await expect(store.getItem('versioned')).resolves.toEqual(original);

    await raw.setItem('legacy', {
      __ls_encrypted: true,
      ...versioned.payload,
    });
    await expect(store.getItem('legacy')).resolves.toEqual(original);
  });

  it('does not mistake marker-only user objects for legacy payloads', async () => {
    const cases: Array<{
      prefix: string;
      plugin: LocalSpacePlugin;
      value: Record<string, unknown>;
    }> = [
      {
        prefix: 'ttl-marker-collision',
        plugin: ttlPlugin(),
        value: { __ls_ttl: true, applicationValue: 'ttl' },
      },
      {
        prefix: 'compression-marker-collision',
        plugin: compressionPlugin({ threshold: Number.MAX_SAFE_INTEGER }),
        value: { __ls_compressed: true, applicationValue: 'compression' },
      },
      {
        prefix: 'encryption-marker-collision',
        plugin: encryptionPlugin({
          key: '0123456789abcdef0123456789abcdef',
        }),
        value: { __ls_encrypted: true, applicationValue: 'encryption' },
      },
    ];

    for (const testCase of cases) {
      const { store, raw } = await createStorePair(
        testCase.prefix,
        testCase.plugin
      );
      await raw.setItem('user-object', testCase.value);
      await expect(store.getItem('user-object')).resolves.toEqual(
        testCase.value
      );
    }
  });

  it('propagates an unknown version through the matching plugin', async () => {
    const { store, raw } = await createStorePair(
      'unknown-envelope-version',
      ttlPlugin()
    );
    await raw.setItem('unknown', {
      __localspace__: {
        namespace: PLUGIN_ENVELOPE_NAMESPACE,
        kind: 'ttl',
        version: 2,
      },
      payload: { data: 'value', expiresAt: Date.now() + 60_000 },
    });

    await expect(store.getItem('unknown')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
      details: { payloadKind: 'ttl', payloadVersion: 2 },
    });
  });
});
