import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, { encryptionPlugin, serializer } from '../src';
import { LocalSpaceError } from '../src/errors';

const VALID_KEY = '0123456789abcdef0123456789abcdef';

const createMemoryStores = async (
  name: string,
  plugin: ReturnType<typeof encryptionPlugin>
) => {
  const secure = localspace.createInstance({
    name,
    storeName: 'secure',
    plugins: [plugin],
  });
  const raw = localspace.createInstance({ name, storeName: 'secure' });

  await Promise.all([
    secure.setDriver([secure.MEMORY]),
    raw.setDriver([raw.MEMORY]),
  ]);

  return { secure, raw };
};

const createLegacyPayload = async (
  algorithm: AlgorithmIdentifier,
  key: CryptoKey,
  value: unknown,
  payloadIv: Uint8Array
) => {
  const serialized = await serializer.serialize(value);
  const encrypted = await crypto.subtle.encrypt(
    algorithm,
    key,
    new TextEncoder().encode(serialized)
  );
  const ivBuffer = payloadIv.buffer.slice(
    payloadIv.byteOffset,
    payloadIv.byteOffset + payloadIv.byteLength
  ) as ArrayBuffer;

  return {
    __ls_encrypted: true as const,
    algorithm: algorithm.name,
    iv: serializer.bufferToString(ivBuffer),
    data: serializer.bufferToString(encrypted),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encryption plugin fail-closed behavior', () => {
  it('rejects an invalid raw key without writing the plaintext value', async () => {
    const { secure, raw } = await createMemoryStores(
      'encryption-invalid-key',
      encryptionPlugin({ key: 'short' })
    );

    const error = await secure
      .setItem('secret', 'plaintext')
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect((error as LocalSpaceError).code).toBe('INVALID_CONFIG');
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });

  it('rejects unserializable values without falling back to the original value', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { secure, raw } = await createMemoryStores(
      'encryption-serialization-error',
      encryptionPlugin({ key: VALID_KEY })
    );
    const circular: { secret: string; self?: unknown } = {
      secret: 'plaintext',
    };
    circular.self = circular;

    const error = await secure
      .setItem('secret', circular)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect((error as LocalSpaceError).code).toBe('SERIALIZATION_FAILED');
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });

  it('rejects undefined before the driver can persist it', async () => {
    const { secure, raw } = await createMemoryStores(
      'encryption-undefined',
      encryptionPlugin({ key: VALID_KEY })
    );

    const error = await secure
      .setItem('secret', undefined)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect((error as LocalSpaceError).code).toBe('SERIALIZATION_FAILED');
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });

  it('wraps random source failures and leaves storage unchanged', async () => {
    const { secure, raw } = await createMemoryStores(
      'encryption-random-source-error',
      encryptionPlugin({
        key: VALID_KEY,
        randomSource: () => {
          throw new Error('random source failed');
        },
      })
    );

    const error = await secure
      .setItem('secret', 'plaintext')
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect((error as LocalSpaceError).code).toBe('OPERATION_FAILED');
    expect((error as LocalSpaceError).cause).toMatchObject({
      message: 'random source failed',
    });
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });

  it('rejects a batch before any entry reaches the driver', async () => {
    const { secure, raw } = await createMemoryStores(
      'encryption-invalid-batch-key',
      encryptionPlugin({ key: 'short' })
    );

    await expect(
      secure.setItems([
        { key: 'first', value: 'plaintext-1' },
        { key: 'second', value: 'plaintext-2' },
      ])
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(raw.getItems(['first', 'second'])).resolves.toEqual([
      { key: 'first', value: null },
      { key: 'second', value: null },
    ]);
  });

  it('propagates decryption failures under the default lenient policy', async () => {
    const { secure, raw } = await createMemoryStores(
      'encryption-decryption-error',
      encryptionPlugin({ key: VALID_KEY })
    );
    await secure.setItem('secret', 'plaintext');

    const payload = await raw.getItem<Record<string, unknown>>('secret');
    await raw.setItem('secret', { ...payload, data: 'AAAA' });

    const error = await secure.getItem('secret').catch((cause) => cause);
    expect(error).toBeInstanceOf(LocalSpaceError);
    expect((error as LocalSpaceError).code).toBe('OPERATION_FAILED');
    expect((error as LocalSpaceError).message).toContain('decrypt');
  });

  it('uses decrypt-only AES-GCM CryptoKeys for reads but rejects writes', async () => {
    const keyMaterial = new TextEncoder().encode(VALID_KEY);
    const encryptOnlyKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    const decryptOnlyKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const { secure, raw } = await createMemoryStores(
      'encryption-decrypt-only-key',
      encryptionPlugin({ key: decryptOnlyKey })
    );
    const firstIv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
    const secondIv = Uint8Array.from({ length: 12 }, (_, index) => index + 21);
    await raw.setItems([
      {
        key: 'first',
        value: await createLegacyPayload(
          { name: 'AES-GCM', iv: firstIv },
          encryptOnlyKey,
          { secret: 'first' },
          firstIv
        ),
      },
      {
        key: 'second',
        value: await createLegacyPayload(
          { name: 'AES-GCM', iv: secondIv },
          encryptOnlyKey,
          { secret: 'second' },
          secondIv
        ),
      },
    ]);

    await expect(
      secure.setItem('new-single', 'plaintext')
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: {
        keyUsages: ['decrypt'],
        requiredKeyUsages: ['encrypt'],
      },
    });
    await expect(
      secure.setItems([{ key: 'new-batch', value: 'plaintext' }])
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { requiredKeyUsages: ['encrypt'] },
    });

    await expect(secure.getItem('first')).resolves.toEqual({
      secret: 'first',
    });
    await expect(
      secure.getItems<{ secret: string }>(['second', 'first'])
    ).resolves.toEqual([
      { key: 'second', value: { secret: 'second' } },
      { key: 'first', value: { secret: 'first' } },
    ]);
    await expect(raw.getItems(['new-single', 'new-batch'])).resolves.toEqual([
      { key: 'new-single', value: null },
      { key: 'new-batch', value: null },
    ]);
  });

  it('reads AES-CBC legacy payloads but rejects new writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fixtureKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(VALID_KEY),
      { name: 'AES-CBC' },
      false,
      ['encrypt']
    );
    const iv = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const { secure, raw } = await createMemoryStores(
      'encryption-legacy-cbc-reader',
      encryptionPlugin({
        key: VALID_KEY,
        algorithm: { name: 'AES-CBC', iv },
      })
    );
    await raw.setItem(
      'legacy',
      await createLegacyPayload(
        { name: 'AES-CBC', iv },
        fixtureKey,
        {
          secret: 'legacy-cbc',
        },
        iv
      )
    );

    await expect(secure.getItem('legacy')).resolves.toEqual({
      secret: 'legacy-cbc',
    });
    await expect(secure.setItem('new', 'plaintext')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    await expect(raw.getItem('new')).resolves.toBeNull();
  });

  it('reads AES-CTR legacy payloads with the original counter', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = (await crypto.subtle.generateKey(
      { name: 'AES-CTR', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )) as CryptoKey;
    const counter = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const payloadIv = new Uint8Array(12);
    const algorithm: AesCtrParams = {
      name: 'AES-CTR',
      counter,
      length: 64,
    };
    const { secure, raw } = await createMemoryStores(
      'encryption-legacy-ctr-reader',
      encryptionPlugin({ key, algorithm })
    );
    await raw.setItem(
      'legacy',
      await createLegacyPayload(algorithm, key, 'legacy-ctr', payloadIv)
    );

    await expect(secure.getItem('legacy')).resolves.toBe('legacy-ctr');
    await expect(
      secure.setItems([{ key: 'new', value: 'plaintext' }])
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(raw.getItem('new')).resolves.toBeNull();
  });

  it('rejects a CryptoKey whose algorithm does not match the plugin', async () => {
    const cbcKey = await crypto.subtle.generateKey(
      { name: 'AES-CBC', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const { secure, raw } = await createMemoryStores(
      'encryption-mismatched-crypto-key',
      encryptionPlugin({ key: cbcKey })
    );

    await expect(secure.setItem('secret', 'plaintext')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });
});
