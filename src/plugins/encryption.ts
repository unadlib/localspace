import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types';
import { normalizeBatchEntries } from '../utils/helpers';
import { createLocalSpaceError, toLocalSpaceError } from '../errors';
import serializer from '../utils/serializer';

export interface EncryptionPluginOptions {
  /** Pre-shared CryptoKey or raw key material */
  key?: CryptoKey | ArrayBuffer | string;
  /** Derive a key using PBKDF2 */
  keyDerivation?: {
    passphrase: string | ArrayBuffer;
    salt: string | ArrayBuffer;
    iterations?: number;
    hash?: string;
    length?: number;
  };
  /** Web Crypto algorithm parameters */
  algorithm?: AesGcmParams;
  /** IV length in bytes (default 12) */
  ivLength?: number;
  /** Custom IV generator */
  ivGenerator?: () => Uint8Array;
  /** Provide a custom SubtleCrypto implementation (e.g., from node:crypto) */
  subtle?: SubtleCrypto;
  /** Custom secure random filler, useful for non-standard runtimes */
  randomSource?: (buffer: Uint8Array) => Uint8Array;
}

type EncryptedPayload = {
  __ls_encrypted: true;
  algorithm: string;
  iv: string;
  data: string;
};

const toArrayBuffer = (value: string | ArrayBuffer): ArrayBuffer => {
  if (typeof value !== 'string') {
    return value;
  }
  return new TextEncoder().encode(value).buffer;
};

const ensureCrypto = (_options: EncryptionPluginOptions): Crypto => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  if (
    typeof self !== 'undefined' &&
    (self as unknown as { crypto?: Crypto }).crypto
  ) {
    return (self as unknown as { crypto: Crypto }).crypto;
  }
  throw createLocalSpaceError(
    'UNSUPPORTED_OPERATION',
    'Secure crypto APIs are not available in this environment.'
  );
};

const resolveSubtle = (options: EncryptionPluginOptions): SubtleCrypto => {
  if (options.subtle) {
    return options.subtle;
  }
  const crypto = ensureCrypto(options);
  if (!crypto.subtle) {
    throw createLocalSpaceError(
      'UNSUPPORTED_OPERATION',
      'SubtleCrypto is not available in this runtime.'
    );
  }
  return crypto.subtle;
};

const fillRandom = (
  length: number,
  options: EncryptionPluginOptions
): Uint8Array => {
  if (options.ivGenerator) {
    const iv = options.ivGenerator();
    if (iv.length !== length) {
      throw createLocalSpaceError(
        'INVALID_ARGUMENT',
        `Custom IV generator must return ${length} bytes.`
      );
    }
    return iv;
  }
  if (options.randomSource) {
    return options.randomSource(new Uint8Array(length));
  }
  const crypto = ensureCrypto(options);
  if (typeof crypto.getRandomValues !== 'function') {
    throw createLocalSpaceError(
      'UNSUPPORTED_OPERATION',
      'A secure random source is required for IV generation.'
    );
  }
  return crypto.getRandomValues(new Uint8Array(length));
};

const importKey = async (
  options: EncryptionPluginOptions,
  subtle: SubtleCrypto
): Promise<CryptoKey> => {
  if (options.key instanceof CryptoKey) {
    return options.key;
  }

  if (options.key) {
    return subtle.importKey(
      'raw',
      toArrayBuffer(options.key),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  const derivation = options.keyDerivation;
  if (!derivation) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption plugin requires either `key` or `keyDerivation`.'
    );
  }

  const baseKey = await subtle.importKey(
    'raw',
    toArrayBuffer(derivation.passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(derivation.salt),
      iterations: derivation.iterations ?? 150000,
      hash: derivation.hash ?? 'SHA-256',
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: derivation.length ?? 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
};

const isEncryptedPayload = (value: unknown): value is EncryptedPayload => {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as EncryptedPayload).__ls_encrypted === true
  );
};

const ALLOWED_ALGORITHMS = ['AES-GCM', 'AES-CBC', 'AES-CTR'] as const;

export const encryptionPlugin = (
  options: EncryptionPluginOptions
): LocalSpacePlugin => {
  const subtle = resolveSubtle(options);
  let keyPromise: Promise<CryptoKey> | null = null;

  const ensureKey = () => {
    if (!keyPromise) {
      keyPromise = importKey(options, subtle);
    }
    return keyPromise;
  };

  const ivLength = options.ivLength ?? 12;
  const algorithmName = options.algorithm?.name ?? 'AES-GCM';

  if (
    !ALLOWED_ALGORITHMS.includes(
      algorithmName as (typeof ALLOWED_ALGORITHMS)[number]
    )
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Unsupported encryption algorithm: ${algorithmName}. Allowed: ${ALLOWED_ALGORITHMS.join(', ')}`
    );
  }

  return {
    name: 'encryption',
    priority: 0,
    beforeSet: async <T>(
      _key: string,
      value: T,
      context: PluginContext
    ): Promise<T> => {
      // Skip if already processed by batch hook
      if (context.operationState.isBatch) {
        return value;
      }
      const key = await ensureKey();
      const serialized = await serializer.serialize(value);
      const payloadBytes = new TextEncoder().encode(serialized);
      const iv = fillRandom(ivLength, options);

      let encrypted: ArrayBuffer;
      try {
        encrypted = await subtle.encrypt(
          {
            ...(options.algorithm ?? { name: algorithmName }),
            iv: iv as BufferSource,
          },
          key,
          payloadBytes
        );
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to encrypt payload'
        );
      }

      return {
        __ls_encrypted: true,
        algorithm: algorithmName,
        iv: serializer.bufferToString(
          iv.buffer.slice(
            iv.byteOffset,
            iv.byteOffset + iv.byteLength
          ) as ArrayBuffer
        ),
        data: serializer.bufferToString(encrypted),
      } as unknown as T;
    },
    afterGet: async <T>(
      _key: string,
      value: T | null,
      context: PluginContext
    ): Promise<T | null> => {
      // Skip if already processed by batch hook
      if (context.operationState.isBatch) {
        return value;
      }
      if (!isEncryptedPayload(value)) {
        return value;
      }

      const key = await ensureKey();
      const ivBuffer = serializer.stringToBuffer(value.iv);
      const dataBuffer = serializer.stringToBuffer(value.data);

      try {
        const plainBuffer = await subtle.decrypt(
          {
            ...(options.algorithm ?? { name: algorithmName }),
            iv: new Uint8Array(ivBuffer),
          },
          key,
          new Uint8Array(dataBuffer)
        );
        const decoded = new TextDecoder().decode(plainBuffer);
        return serializer.deserialize(decoded) as T;
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to decrypt payload'
        );
      }
    },
    beforeSetItems: async <T>(
      entries: BatchItems<T>,
      _context: PluginContext
    ): Promise<BatchItems<T>> => {
      const normalized = normalizeBatchEntries(entries);
      const cryptoKey = await ensureKey();

      const encrypted = await Promise.all(
        normalized.map(async ({ key: itemKey, value }) => {
          const serialized = await serializer.serialize(value);
          const payloadBytes = new TextEncoder().encode(serialized);
          const iv = fillRandom(ivLength, options);

          let encryptedData: ArrayBuffer;
          try {
            encryptedData = await subtle.encrypt(
              {
                ...(options.algorithm ?? { name: algorithmName }),
                iv: iv as BufferSource,
              },
              cryptoKey,
              payloadBytes
            );
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'OPERATION_FAILED',
              `Failed to encrypt payload for key "${itemKey}"`
            );
          }

          return {
            key: itemKey,
            value: {
              __ls_encrypted: true,
              algorithm: algorithmName,
              iv: serializer.bufferToString(
                iv.buffer.slice(
                  iv.byteOffset,
                  iv.byteOffset + iv.byteLength
                ) as ArrayBuffer
              ),
              data: serializer.bufferToString(encryptedData),
            } as unknown as T,
          };
        })
      );

      return encrypted;
    },
    afterGetItems: async <T>(
      entries: BatchResponse<T>,
      _context: PluginContext
    ): Promise<BatchResponse<T>> => {
      const cryptoKey = await ensureKey();

      const decrypted = await Promise.all(
        entries.map(async ({ key: itemKey, value }) => {
          if (!isEncryptedPayload(value)) {
            return { key: itemKey, value };
          }

          const ivBuffer = serializer.stringToBuffer(value.iv);
          const dataBuffer = serializer.stringToBuffer(value.data);

          try {
            const plainBuffer = await subtle.decrypt(
              {
                ...(options.algorithm ?? { name: algorithmName }),
                iv: new Uint8Array(ivBuffer),
              },
              cryptoKey,
              new Uint8Array(dataBuffer)
            );
            const decoded = new TextDecoder().decode(plainBuffer);
            return {
              key: itemKey,
              value: serializer.deserialize(decoded) as T,
            };
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'OPERATION_FAILED',
              `Failed to decrypt payload for key "${itemKey}"`
            );
          }
        })
      );

      return decrypted;
    },
  };
};

export default encryptionPlugin;
