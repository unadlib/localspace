import { describe, expect, it } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
  type LocalSpacePlugin,
} from '../src';
import {
  PLUGIN_ENVELOPE_NAMESPACE,
  PLUGIN_ENVELOPE_VERSION,
  type PluginEnvelopeKind,
} from '../src/core/plugin-envelope';
import fixtureData from './fixtures/plugin-envelopes.json';

type StoredFixture = {
  expected: unknown;
  stored: unknown;
};

type PluginEnvelopeFixtures = {
  fixtureSchemaVersion: number;
  contract: {
    namespace: string;
    formatVersion: number;
    legacyWriter: string;
    futureWriter: string;
    requiredReaders: string[];
  };
  keys: {
    encryption: string;
    wrongEncryption: string;
  };
  legacy: Record<PluginEnvelopeKind, StoredFixture>;
  future: Record<PluginEnvelopeKind, StoredFixture>;
  markerCollisions: Record<string, unknown>;
  failures: {
    unknownVersion: Record<PluginEnvelopeKind, unknown>;
    corrupted: Record<PluginEnvelopeKind, unknown>;
  };
};

const fixtures = fixtureData as PluginEnvelopeFixtures;

const kinds: PluginEnvelopeKind[] = ['encryption', 'compression', 'ttl'];

const createPlugin = (
  kind: PluginEnvelopeKind,
  encryptionKey = fixtures.keys.encryption
): LocalSpacePlugin => {
  switch (kind) {
    case 'encryption':
      return encryptionPlugin({ key: encryptionKey });
    case 'compression':
      return compressionPlugin();
    case 'ttl':
      return ttlPlugin();
  }
};

const createStorePair = async (
  label: string,
  kind: PluginEnvelopeKind,
  encryptionKey?: string
) => {
  const name = `${label}-${kind}-${Math.random().toString(36).slice(2)}`;
  const options = { name, storeName: 'store' };
  const store = localspace.createInstance({
    ...options,
    plugins: [createPlugin(kind, encryptionKey)],
  });
  const raw = localspace.createInstance(options);
  await store.setDriver([store.MEMORY]);
  await raw.setDriver([raw.MEMORY]);
  return { store, raw };
};

describe('static cross-version plugin fixtures', () => {
  it('pins the shared 2.1/3.x envelope contract', () => {
    expect(fixtures.fixtureSchemaVersion).toBe(1);
    expect(fixtures.contract).toMatchObject({
      namespace: PLUGIN_ENVELOPE_NAMESPACE,
      formatVersion: PLUGIN_ENVELOPE_VERSION,
      legacyWriter: '2.0.x',
      futureWriter: '3.0.0-fixture',
      requiredReaders: ['2.1.x', '3.x'],
    });
  });

  it('reads static payloads written by 2.0.x', async () => {
    for (const kind of kinds) {
      const fixture = fixtures.legacy[kind];
      const { store, raw } = await createStorePair('legacy-fixture', kind);
      await raw.setItem('fixture', fixture.stored);

      await expect(store.getItem('fixture'), kind).resolves.toEqual(
        fixture.expected
      );
    }
  });

  it('reads static payloads representing the 3.0 writer', async () => {
    for (const kind of kinds) {
      const fixture = fixtures.future[kind];
      const { store, raw } = await createStorePair('future-fixture', kind);
      await raw.setItem('fixture', fixture.stored);

      await expect(store.getItem('fixture'), kind).resolves.toEqual(
        fixture.expected
      );
    }
  });

  it('preserves static marker-collision user objects', async () => {
    for (const kind of kinds) {
      const collision = fixtures.markerCollisions[kind];
      const { store, raw } = await createStorePair('collision-fixture', kind);
      await raw.setItem('fixture', collision);

      await expect(store.getItem('fixture'), kind).resolves.toEqual(collision);
    }

    const { store, raw } = await createStorePair(
      'namespace-lookalike-fixture',
      'ttl'
    );
    const lookalike = fixtures.markerCollisions.reservedLookalike;
    await raw.setItem('fixture', lookalike);
    await expect(store.getItem('fixture')).resolves.toEqual(lookalike);
  });

  it('rejects every static unknown-version fixture', async () => {
    for (const kind of kinds) {
      const { store, raw } = await createStorePair(
        'unknown-version-fixture',
        kind
      );
      await raw.setItem('fixture', fixtures.failures.unknownVersion[kind]);

      await expect(store.getItem('fixture'), kind).rejects.toMatchObject({
        code: 'DESERIALIZATION_FAILED',
        details: { payloadKind: kind, payloadVersion: 99 },
      });
    }
  });

  it('rejects every static corrupted legacy payload', async () => {
    for (const kind of kinds) {
      const { store, raw } = await createStorePair('corrupted-fixture', kind);
      await raw.setItem('fixture', fixtures.failures.corrupted[kind]);

      await expect(store.getItem('fixture'), kind).rejects.toMatchObject({
        code: 'DESERIALIZATION_FAILED',
      });
    }
  });

  it('fails deterministically with the wrong encryption key', async () => {
    const { store, raw } = await createStorePair(
      'wrong-key-fixture',
      'encryption',
      fixtures.keys.wrongEncryption
    );
    const stored = fixtures.legacy.encryption.stored;
    await raw.setItem('fixture', stored);

    await expect(store.getItem('fixture')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'Failed to decrypt payload',
    });
    await expect(raw.getItem('fixture')).resolves.toEqual(stored);
  });
});
