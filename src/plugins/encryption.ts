import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import serializer from '../utils/serializer.js';
import { warnDeprecation } from '../utils/deprecations.js';
import {
  hasOwnPayloadField,
  readPluginEnvelope,
} from '../core/plugin-envelope.js';

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
  /**
   * Web Crypto algorithm parameters. AES-CBC and AES-CTR are deprecated and
   * rejected; use authenticated AES-GCM.
   */
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

type EncryptedPayloadBody = {
  algorithm: string;
  iv: string;
  data: string;
};

type EncryptedPayload = EncryptedPayloadBody & {
  __ls_encrypted: true;
};

const AES_GCM = 'AES-GCM';
const AES_KEY_LENGTHS = new Set([16, 24, 32]);
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const toArrayBuffer = (value: string | ArrayBuffer): ArrayBuffer => {
  if (typeof value !== 'string') {
    return value;
  }
  return new TextEncoder().encode(value).buffer;
};

const isCryptoKey = (value: unknown): value is CryptoKey => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
    return true;
  }

  const candidate = value as Partial<CryptoKey>;
  return (
    typeof candidate.type === 'string' &&
    !!candidate.algorithm &&
    Array.isArray(candidate.usages)
  );
};

const validateRawKey = (value: string | ArrayBuffer): void => {
  const byteLength = toArrayBuffer(value).byteLength;
  if (!AES_KEY_LENGTHS.has(byteLength)) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'AES-GCM key material must be 16, 24, or 32 bytes.',
      { keyByteLength: byteLength }
    );
  }
};

const validateCryptoKey = (key: CryptoKey): CryptoKey => {
  const algorithmName = key.algorithm?.name;
  if (key.type !== 'secret' || algorithmName !== AES_GCM) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Encryption key must be a secret ${AES_GCM} CryptoKey.`,
      { keyType: key.type, keyAlgorithm: algorithmName }
    );
  }

  const usages = new Set(key.usages);
  if (!usages.has('encrypt') || !usages.has('decrypt')) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption CryptoKey must allow both encrypt and decrypt usage.',
      { keyUsages: [...key.usages] }
    );
  }

  return key;
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
  if (isCryptoKey(options.key)) {
    return validateCryptoKey(options.key);
  }

  if (options.key !== undefined) {
    validateRawKey(options.key);
    const imported = await subtle.importKey(
      'raw',
      toArrayBuffer(options.key),
      { name: AES_GCM },
      false,
      ['encrypt', 'decrypt']
    );
    return validateCryptoKey(imported);
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

  const derived = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(derivation.salt),
      iterations: derivation.iterations ?? 150000,
      hash: derivation.hash ?? 'SHA-256',
    },
    baseKey,
    {
      name: AES_GCM,
      length: derivation.length ?? 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
  return validateCryptoKey(derived);
};

const validateEncryptedPayload = (value: unknown): EncryptedPayloadBody => {
  const payload = value as Partial<EncryptedPayloadBody>;
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.algorithm !== AES_GCM ||
    typeof payload.iv !== 'string' ||
    payload.iv.length === 0 ||
    !BASE64_PATTERN.test(payload.iv) ||
    typeof payload.data !== 'string' ||
    payload.data.length === 0 ||
    !BASE64_PATTERN.test(payload.data)
  ) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      'Failed to decrypt payload: invalid or unsupported encrypted payload.',
      { payloadAlgorithm: payload.algorithm }
    );
  }

  return payload as EncryptedPayloadBody;
};

const parseEncryptedPayload = (value: unknown): EncryptedPayloadBody | null => {
  const envelope = readPluginEnvelope<unknown>(value, 'encryption');
  if (envelope.matched) {
    return validateEncryptedPayload(envelope.payload);
  }

  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<EncryptedPayload>).__ls_encrypted !== true
  ) {
    return null;
  }

  const hasLegacyPayloadFields = ['algorithm', 'iv', 'data'].some((field) =>
    hasOwnPayloadField(value, field)
  );
  if (!hasLegacyPayloadFields) {
    return null;
  }

  return validateEncryptedPayload(value);
};

export const encryptionPlugin = (
  options: EncryptionPluginOptions
): LocalSpacePlugin => {
  const ivLength = options.ivLength ?? 12;
  const algorithmName = options.algorithm?.name ?? AES_GCM;

  if (algorithmName === 'AES-CBC' || algorithmName === 'AES-CTR') {
    warnDeprecation(
      'legacy-encryption-algorithm',
      `${algorithmName} encryption is deprecated and unsupported; migrate to AES-GCM.`
    );
  }
  if (algorithmName !== AES_GCM) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Unsupported encryption algorithm: ${algorithmName}. Only ${AES_GCM} is supported.`,
      { algorithm: algorithmName }
    );
  }

  const subtle = resolveSubtle(options);
  let keyPromise: Promise<CryptoKey> | null = null;

  const ensureKey = (): Promise<CryptoKey> => {
    if (!keyPromise) {
      keyPromise = importKey(options, subtle).catch((error) => {
        throw toLocalSpaceError(
          error,
          'INVALID_CONFIG',
          'Failed to initialize encryption key'
        );
      });
    }
    return keyPromise;
  };

  if (!Number.isInteger(ivLength) || ivLength <= 0) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption IV length must be a positive integer.',
      { ivLength }
    );
  }

  if (options.key === undefined && !options.keyDerivation) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption plugin requires either `key` or `keyDerivation`.'
    );
  }

  if (options.key === undefined && options.keyDerivation) {
    const { iterations = 150000, length = 256 } = options.keyDerivation;
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'PBKDF2 iterations must be a positive integer.',
        { iterations }
      );
    }
    if (![128, 192, 256].includes(length)) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Derived AES-GCM key length must be 128, 192, or 256 bits.',
        { keyLength: length }
      );
    }
  }

  const encryptionAlgorithm = (iv: Uint8Array): AesGcmParams => ({
    ...(options.algorithm ?? { name: AES_GCM }),
    name: AES_GCM,
    iv: iv as BufferSource,
  });

  const serializeValue = async (
    value: unknown,
    itemKey?: string
  ): Promise<Uint8Array> => {
    try {
      const serialized = await serializer.serialize(value);
      if (typeof serialized !== 'string') {
        throw createLocalSpaceError(
          'SERIALIZATION_FAILED',
          'Encryption plugin cannot serialize this value.',
          itemKey ? { key: itemKey } : undefined
        );
      }
      return new TextEncoder().encode(serialized);
    } catch (error) {
      throw toLocalSpaceError(
        error,
        'SERIALIZATION_FAILED',
        itemKey
          ? `Failed to serialize encrypted payload for key "${itemKey}"`
          : 'Failed to serialize encrypted payload',
        itemKey ? { key: itemKey } : undefined
      );
    }
  };

  const encryptValue = async (
    value: unknown,
    itemKey?: string
  ): Promise<EncryptedPayload> => {
    try {
      const cryptoKey = await ensureKey();
      const payloadBytes = await serializeValue(value, itemKey);
      const iv = fillRandom(ivLength, options);
      if (!(iv instanceof Uint8Array) || iv.byteLength !== ivLength) {
        throw createLocalSpaceError(
          'INVALID_CONFIG',
          `Random source must return ${ivLength} bytes.`
        );
      }
      const encrypted = await subtle.encrypt(
        encryptionAlgorithm(iv),
        cryptoKey,
        payloadBytes as BufferSource
      );

      return {
        __ls_encrypted: true,
        algorithm: AES_GCM,
        iv: serializer.bufferToString(
          iv.buffer.slice(
            iv.byteOffset,
            iv.byteOffset + iv.byteLength
          ) as ArrayBuffer
        ),
        data: serializer.bufferToString(encrypted),
      };
    } catch (error) {
      throw toLocalSpaceError(
        error,
        'OPERATION_FAILED',
        itemKey
          ? `Failed to encrypt payload for key "${itemKey}"`
          : 'Failed to encrypt payload',
        itemKey ? { key: itemKey } : undefined
      );
    }
  };

  const decryptValue = async <T>(
    payload: EncryptedPayloadBody,
    itemKey?: string
  ): Promise<T> => {
    try {
      const cryptoKey = await ensureKey();
      const ivBuffer = serializer.stringToBuffer(payload.iv);
      const dataBuffer = serializer.stringToBuffer(payload.data);
      const plainBuffer = await subtle.decrypt(
        encryptionAlgorithm(new Uint8Array(ivBuffer)),
        cryptoKey,
        new Uint8Array(dataBuffer)
      );
      const decoded = new TextDecoder().decode(plainBuffer);
      return serializer.deserialize(decoded) as T;
    } catch (error) {
      throw toLocalSpaceError(
        error,
        'OPERATION_FAILED',
        itemKey
          ? `Failed to decrypt payload for key "${itemKey}"`
          : 'Failed to decrypt payload',
        itemKey ? { key: itemKey } : undefined
      );
    }
  };

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
      return (await encryptValue(value)) as unknown as T;
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
      const payload = parseEncryptedPayload(value);
      if (!payload) {
        return value;
      }
      return decryptValue<T>(payload);
    },
    beforeSetItems: async <T>(
      entries: BatchItems<T>,
      _context: PluginContext
    ): Promise<BatchItems<T>> => {
      const normalized = normalizeBatchEntries(entries);
      const encrypted = await Promise.all(
        normalized.map(async ({ key: itemKey, value }) => {
          return {
            key: itemKey,
            value: (await encryptValue(value, itemKey)) as unknown as T,
          };
        })
      );

      return encrypted;
    },
    afterGetItems: async <T>(
      entries: BatchResponse<T>,
      _context: PluginContext
    ): Promise<BatchResponse<T>> => {
      const decrypted = await Promise.all(
        entries.map(async ({ key: itemKey, value }) => {
          const payload = parseEncryptedPayload(value);
          if (!payload) {
            return { key: itemKey, value };
          }
          return {
            key: itemKey,
            value: await decryptValue<T>(payload, itemKey),
          };
        })
      );

      return decrypted;
    },
  };
};

export default encryptionPlugin;
