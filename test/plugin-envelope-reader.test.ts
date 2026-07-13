import { describe, expect, it } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
  type LocalSpacePlugin,
} from '../src';
import {
  PLUGIN_ENVELOPE_NAMESPACE,
  PLUGIN_ENVELOPE_PROPERTY,
  PLUGIN_ENVELOPE_VERSION,
  readPluginEnvelope,
  type PluginEnvelopeKind,
  type PluginEnvelopeV1,
} from '../src/core/plugin-envelope';

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
  const raw = localspace.createInstance(options);
  await store.setDriver([store.MEMORY]);
  await raw.setDriver([raw.MEMORY]);
  return { store, raw };
};

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

  it('keeps writing legacy TTL payloads and reads the versioned form', async () => {
    const { store, raw } = await createStorePair(
      'ttl-envelope-reader',
      ttlPlugin({ defaultTTL: 60_000 })
    );
    await store.setItem('legacy', { source: '2.x' });
    await expect(raw.getItem('legacy')).resolves.toMatchObject({
      __ls_ttl: true,
      data: { source: '2.x' },
    });

    await raw.setItem(
      'future',
      envelope('ttl', {
        data: { source: '3.0' },
        expiresAt: Date.now() + 60_000,
      })
    );
    await expect(store.getItem('future')).resolves.toEqual({ source: '3.0' });
  });

  it('keeps writing legacy compression payloads and reads the versioned form', async () => {
    const { store, raw } = await createStorePair(
      'compression-envelope-reader',
      compressionPlugin({ threshold: 0 })
    );
    const original = { source: '3.0', text: 'x'.repeat(200) };
    await store.setItem('legacy', original);
    const legacy = await raw.getItem<Record<string, unknown>>('legacy');
    expect(legacy).toMatchObject({ __ls_compressed: true });

    const { __ls_compressed: _marker, ...payload } = legacy!;
    await raw.setItem('future', envelope('compression', payload));
    await expect(store.getItem('future')).resolves.toEqual(original);
  });

  it('keeps writing legacy encryption payloads and reads the versioned form', async () => {
    const { store, raw } = await createStorePair(
      'encryption-envelope-reader',
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' })
    );
    const original = { source: '3.0', secret: true };
    await store.setItem('legacy', original);
    const legacy = await raw.getItem<Record<string, unknown>>('legacy');
    expect(legacy).toMatchObject({
      __ls_encrypted: true,
      algorithm: 'AES-GCM',
    });

    const { __ls_encrypted: _marker, ...payload } = legacy!;
    await raw.setItem('future', envelope('encryption', payload));
    await expect(store.getItem('future')).resolves.toEqual(original);
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
