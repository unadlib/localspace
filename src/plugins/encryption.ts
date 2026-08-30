import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import serializer from '../utils/serializer.js';
import {
  createPluginEnvelope,
  hasExactPayloadFields,
  hasOwnPayloadField,
  readOwnPayloadField,
  readPluginEnvelope,
  type PluginEnvelopeV1,
} from '../core/plugin-envelope.js';
import { markBuiltInStorageTransformPlugin } from '../core/plugin-capabilities.js';

type EncryptionKeySource =
  | {
      /** Pre-shared CryptoKey (usage checked per operation) or raw key material */
      key: CryptoKey | ArrayBuffer | string;
      keyDerivation?: never;
    }
  | {
      key?: never;
      /** Derive a key using PBKDF2 */
      keyDerivation: {
        passphrase: string | ArrayBuffer;
        salt: string | ArrayBuffer;
        iterations?: number;
        hash?: string;
        length?: number;
      };
    };

interface EncryptionKeyOptions {
  key?: CryptoKey | ArrayBuffer | string;
  keyDerivation?: {
    passphrase: string | ArrayBuffer;
    salt: string | ArrayBuffer;
    iterations?: number;
    hash?: string;
    length?: number;
  };
  /** Provide a custom SubtleCrypto implementation (e.g., from node:crypto) */
  subtle?: SubtleCrypto;
}

export type EncryptionAlgorithm = Omit<AesGcmParams, 'name' | 'iv'> & {
  name: 'AES-GCM';
};

export type EncryptionPluginOptions = EncryptionKeySource & {
  /** Provide a custom SubtleCrypto implementation (e.g., from node:crypto) */
  subtle?: SubtleCrypto;
  /** AES-GCM parameters. The writer always supplies a fresh IV. */
  algorithm?: EncryptionAlgorithm;
  /** IV length in bytes (default 12) */
  ivLength?: number;
  /** Custom IV generator */
  ivGenerator?: () => Uint8Array;
  /** Custom secure random filler, useful for non-standard runtimes */
  randomSource?: (buffer: Uint8Array) => Uint8Array;
};

export type LegacyEncryptionMigrationAlgorithm =
  | { name: 'AES-CBC' }
  | {
      name: 'AES-CTR';
      /** The exact counter used by the legacy writer. */
      counter: BufferSource;
      /** The exact counter length used by the legacy writer. */
      length: number;
    };

export type LegacyEncryptionMigrationOptions = EncryptionKeySource & {
  /** Provide a custom SubtleCrypto implementation (e.g., from node:crypto) */
  subtle?: SubtleCrypto;
  /** Legacy read algorithm. This API never encrypts new values. */
  algorithm: LegacyEncryptionMigrationAlgorithm;
};

type EncryptedPayloadBody = {
  algorithm: string;
  iv: string;
  data: string;
};

type VersionedEncryptedPayload = PluginEnvelopeV1<EncryptedPayloadBody>;

const AES_GCM = 'AES-GCM';
const AES_CBC = 'AES-CBC';
const AES_CTR = 'AES-CTR';
const SUPPORTED_AES_ALGORITHMS = new Set([AES_GCM, AES_CBC, AES_CTR]);
const AES_KEY_LENGTHS = new Set([16, 24, 32]);
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isCanonicalBase64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length % 4 === 0 &&
  BASE64_PATTERN.test(value) &&
  serializer.bufferToString(serializer.stringToBuffer(value)) === value;

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
      'AES key material must be 16, 24, or 32 bytes.',
      { keyByteLength: byteLength }
    );
  }
};

const validateCryptoKey = (
  key: CryptoKey,
  expectedAlgorithmName: string,
  requiredUsages: KeyUsage[]
): CryptoKey => {
  const keyAlgorithmName = key.algorithm?.name;
  if (key.type !== 'secret' || keyAlgorithmName !== expectedAlgorithmName) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Encryption key must be a secret ${expectedAlgorithmName} CryptoKey.`,
      { keyType: key.type, keyAlgorithm: keyAlgorithmName }
    );
  }

  const usages = new Set(key.usages);
  if (requiredUsages.some((usage) => !usages.has(usage))) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Encryption CryptoKey must allow ${requiredUsages.join(' and ')} usage.`,
      { keyUsages: [...key.usages], requiredKeyUsages: requiredUsages }
    );
  }

  return key;
};

const ensureCrypto = (): Crypto => {
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

const resolveSubtle = (options: EncryptionKeyOptions): SubtleCrypto => {
  if (options.subtle) {
    return options.subtle;
  }
  const crypto = ensureCrypto();
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
  let generated: unknown;
  if (options.ivGenerator) {
    generated = options.ivGenerator();
  } else if (options.randomSource) {
    generated = options.randomSource(new Uint8Array(length));
  } else {
    const crypto = ensureCrypto();
    if (typeof crypto.getRandomValues !== 'function') {
      throw createLocalSpaceError(
        'UNSUPPORTED_OPERATION',
        'A secure random source is required for IV generation.'
      );
    }
    generated = crypto.getRandomValues(new Uint8Array(length));
  }

  if (Object.prototype.toString.call(generated) !== '[object Uint8Array]') {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption IV source must return Uint8Array.'
    );
  }
  const source = generated as Uint8Array;
  if (source.byteLength !== length) {
    throw createLocalSpaceError(
      'INVALID_ARGUMENT',
      `Encryption IV source must return ${length} bytes.`,
      { expectedIvLength: length, actualIvLength: source.byteLength }
    );
  }
  const copy = new Uint8Array(length);
  copy.set(source);
  return copy;
};

const importKey = async (
  options: EncryptionKeyOptions,
  subtle: SubtleCrypto,
  algorithmName: string,
  importedUsages: KeyUsage[]
): Promise<CryptoKey> => {
  if (isCryptoKey(options.key)) {
    return validateCryptoKey(options.key, algorithmName, []);
  }

  if (options.key !== undefined) {
    validateRawKey(options.key);
    const imported = await subtle.importKey(
      'raw',
      toArrayBuffer(options.key),
      { name: algorithmName },
      false,
      importedUsages
    );
    return validateCryptoKey(imported, algorithmName, importedUsages);
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
      name: algorithmName,
      length: derivation.length ?? 256,
    },
    false,
    importedUsages
  );
  return validateCryptoKey(derived, algorithmName, importedUsages);
};

const validateEncryptedPayload = (
  value: unknown,
  expectedFields: readonly string[]
): EncryptedPayloadBody => {
  const algorithm =
    value && typeof value === 'object'
      ? readOwnPayloadField(value, 'algorithm')
      : undefined;
  const iv =
    value && typeof value === 'object'
      ? readOwnPayloadField(value, 'iv')
      : undefined;
  const data =
    value && typeof value === 'object'
      ? readOwnPayloadField(value, 'data')
      : undefined;
  if (
    !hasExactPayloadFields(value, expectedFields) ||
    typeof algorithm !== 'string' ||
    !SUPPORTED_AES_ALGORITHMS.has(algorithm) ||
    !isCanonicalBase64(iv) ||
    !isCanonicalBase64(data)
  ) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      'Failed to decrypt payload: invalid or unsupported encrypted payload.',
      { payloadAlgorithm: algorithm }
    );
  }

  return { algorithm, iv, data };
};

const parseEncryptedPayload = (value: unknown): EncryptedPayloadBody | null => {
  const envelope = readPluginEnvelope<unknown>(value, 'encryption');
  if (envelope.matched) {
    return validateEncryptedPayload(envelope.payload, [
      'algorithm',
      'iv',
      'data',
    ]);
  }

  if (
    !value ||
    typeof value !== 'object' ||
    readOwnPayloadField(value, '__ls_encrypted') !== true
  ) {
    return null;
  }

  const hasLegacyPayloadFields = ['algorithm', 'iv', 'data'].some((field) =>
    hasOwnPayloadField(value, field)
  );
  if (!hasLegacyPayloadFields) {
    return null;
  }

  return validateEncryptedPayload(value, [
    '__ls_encrypted',
    'algorithm',
    'iv',
    'data',
  ]);
};

type EncryptionPluginMode = 'gcm' | 'legacy-migration';

const validateKeyOptions = (options: EncryptionKeyOptions): void => {
  if (options.key !== undefined && options.keyDerivation !== undefined) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption configuration must provide exactly one of `key` or `keyDerivation`.',
      {
        configKey: 'key',
        conflictingConfigKey: 'keyDerivation',
        reason: 'ambiguous-key-source',
      }
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
        'Derived AES key length must be 128, 192, or 256 bits.',
        { keyLength: length }
      );
    }
  }
};

const copyCounter = (value: unknown): Uint8Array<ArrayBuffer> => {
  let source: Uint8Array;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    source = new Uint8Array(
      view.buffer as ArrayBuffer,
      view.byteOffset,
      view.byteLength
    );
  } else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    source = new Uint8Array(value as ArrayBuffer);
  } else {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'AES-CTR migration counter must be a BufferSource.'
    );
  }

  if (source.byteLength !== 16) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'AES-CTR migration counter must contain exactly 16 bytes.',
      { counterByteLength: source.byteLength }
    );
  }
  const copy = new Uint8Array(new ArrayBuffer(16));
  copy.set(source);
  return copy;
};

const createEncryptionPlugin = (
  options: EncryptionPluginOptions | LegacyEncryptionMigrationOptions,
  mode: EncryptionPluginMode
): LocalSpacePlugin => {
  const rawAlgorithm = (options as { algorithm?: unknown }).algorithm;
  const configuredAlgorithm =
    rawAlgorithm && typeof rawAlgorithm === 'object'
      ? (rawAlgorithm as { name?: unknown })
      : undefined;
  const configuredAlgorithmName = configuredAlgorithm?.name;
  const algorithmName =
    mode === 'gcm'
      ? (configuredAlgorithmName ?? AES_GCM)
      : configuredAlgorithmName;

  if (
    mode === 'gcm' &&
    (algorithmName !== AES_GCM ||
      (rawAlgorithm !== undefined && !configuredAlgorithm))
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'encryptionPlugin supports only AES-GCM; use legacyEncryptionMigrationPlugin for AES-CBC or AES-CTR reads.',
      { algorithm: algorithmName }
    );
  }
  if (
    mode === 'legacy-migration' &&
    algorithmName !== AES_CBC &&
    algorithmName !== AES_CTR
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'legacyEncryptionMigrationPlugin requires AES-CBC or AES-CTR.',
      { algorithm: algorithmName }
    );
  }

  const normalOptions =
    mode === 'gcm' ? (options as EncryptionPluginOptions) : null;
  const legacyOptions =
    mode === 'legacy-migration'
      ? (options as LegacyEncryptionMigrationOptions)
      : null;
  const ivLength = normalOptions?.ivLength ?? 12;
  if (mode === 'gcm' && (!Number.isInteger(ivLength) || ivLength <= 0)) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Encryption IV length must be a positive integer.',
      { ivLength }
    );
  }

  let legacyCtrAlgorithm: AesCtrParams | null = null;
  if (algorithmName === AES_CTR) {
    const algorithm = legacyOptions?.algorithm;
    if (
      !algorithm ||
      algorithm.name !== AES_CTR ||
      !Number.isInteger(algorithm.length) ||
      algorithm.length < 1 ||
      algorithm.length > 128
    ) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'AES-CTR legacy reads require the original 16-byte counter and a length from 1 through 128.',
        { algorithm: AES_CTR }
      );
    }
    legacyCtrAlgorithm = {
      name: AES_CTR,
      counter: copyCounter(algorithm.counter),
      length: algorithm.length,
    };
  }

  validateKeyOptions(options);
  const subtle = resolveSubtle(options);
  const importedUsages: KeyUsage[] =
    mode === 'gcm' ? ['encrypt', 'decrypt'] : ['decrypt'];
  let keyPromise: Promise<CryptoKey> | null = null;

  const ensureKey = async (requiredUsage: 'encrypt' | 'decrypt') => {
    if (!keyPromise) {
      keyPromise = importKey(
        options,
        subtle,
        algorithmName as string,
        importedUsages
      ).catch((error) => {
        throw toLocalSpaceError(
          error,
          'INVALID_CONFIG',
          'Failed to initialize encryption key'
        );
      });
    }
    const key = await keyPromise;
    return validateCryptoKey(key, algorithmName as string, [requiredUsage]);
  };

  const encryptionAlgorithm = (iv: Uint8Array): AesGcmParams => ({
    ...(normalOptions?.algorithm ?? {
      name: AES_GCM,
      iv: iv as BufferSource,
    }),
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
  ): Promise<VersionedEncryptedPayload> => {
    try {
      if (mode !== 'gcm' || !normalOptions) {
        throw createLocalSpaceError(
          'UNSUPPORTED_OPERATION',
          'The legacy encryption migration plugin is read-only; write migrated values through encryptionPlugin with AES-GCM.',
          { algorithm: algorithmName, operation: 'encrypt' }
        );
      }
      const cryptoKey = await ensureKey('encrypt');
      const payloadBytes = await serializeValue(value, itemKey);
      const iv = fillRandom(ivLength, normalOptions);
      const encrypted = await subtle.encrypt(
        encryptionAlgorithm(iv),
        cryptoKey,
        payloadBytes as BufferSource
      );

      return createPluginEnvelope('encryption', {
        algorithm: AES_GCM,
        iv: serializer.bufferToString(iv.slice().buffer as ArrayBuffer),
        data: serializer.bufferToString(encrypted),
      });
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
      if (payload.algorithm !== algorithmName) {
        throw createLocalSpaceError(
          'INVALID_CONFIG',
          `Encrypted payload uses ${payload.algorithm}; configure a matching migration reader.`,
          {
            configuredAlgorithm: algorithmName,
            payloadAlgorithm: payload.algorithm,
          }
        );
      }
      const cryptoKey = await ensureKey('decrypt');
      const iv = new Uint8Array(serializer.stringToBuffer(payload.iv));
      const data = new Uint8Array(serializer.stringToBuffer(payload.data));
      let decryptAlgorithm: AlgorithmIdentifier;
      if (algorithmName === AES_CBC) {
        if (iv.byteLength !== 16) {
          throw createLocalSpaceError(
            'DESERIALIZATION_FAILED',
            'AES-CBC legacy payload IV must contain exactly 16 bytes.',
            { algorithm: AES_CBC, ivByteLength: iv.byteLength }
          );
        }
        decryptAlgorithm = { name: AES_CBC, iv } as AesCbcParams;
      } else if (algorithmName === AES_CTR) {
        decryptAlgorithm = legacyCtrAlgorithm!;
      } else {
        decryptAlgorithm = encryptionAlgorithm(iv);
      }
      const plainBuffer = await subtle.decrypt(
        decryptAlgorithm,
        cryptoKey,
        data
      );
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        plainBuffer
      );
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
    // Keep the same plugin identity so a migration reader cannot be combined
    // accidentally with the normal encryption transform on one instance.
    name: 'encryption',
    priority: 0,
    beforeSet: async <T>(_key: string, value: T): Promise<T> =>
      (await encryptValue(value)) as unknown as T,
    afterGet: async <T>(
      _key: string,
      value: T | null,
      _context: PluginContext
    ): Promise<T | null> => {
      const payload = parseEncryptedPayload(value);
      return payload ? decryptValue<T>(payload) : value;
    },
    beforeSetItems: async <T>(
      entries: BatchItems<T>,
      _context: PluginContext
    ): Promise<BatchItems<T>> =>
      Promise.all(
        normalizeBatchEntries(entries).map(async ({ key: itemKey, value }) => ({
          key: itemKey,
          value: (await encryptValue(value, itemKey)) as unknown as T,
        }))
      ),
    afterGetItems: async <T>(
      entries: BatchResponse<T>,
      _context: PluginContext
    ): Promise<BatchResponse<T>> =>
      Promise.all(
        entries.map(async ({ key: itemKey, value }) => {
          const payload = parseEncryptedPayload(value);
          return payload
            ? { key: itemKey, value: await decryptValue<T>(payload, itemKey) }
            : { key: itemKey, value };
        })
      ),
  };
};

export const encryptionPlugin = (
  options: EncryptionPluginOptions
): LocalSpacePlugin =>
  markBuiltInStorageTransformPlugin(
    createEncryptionPlugin(options, 'gcm'),
    'encryption'
  );

/**
 * Explicit, read-only bridge for decrypting supported AES-CBC/AES-CTR payloads
 * before rewriting them through a separate AES-GCM instance.
 */
export const legacyEncryptionMigrationPlugin = (
  options: LegacyEncryptionMigrationOptions
): LocalSpacePlugin =>
  markBuiltInStorageTransformPlugin(
    createEncryptionPlugin(options, 'legacy-migration'),
    'encryption'
  );

export default encryptionPlugin;
