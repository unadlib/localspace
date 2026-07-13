import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, { encryptionPlugin } from '../src';
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

  it('rejects algorithms that cannot satisfy the AES-GCM contract', () => {
    expect(() =>
      encryptionPlugin({
        key: VALID_KEY,
        algorithm: { name: 'AES-CBC' } as AesGcmParams,
      })
    ).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
      })
    );
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
