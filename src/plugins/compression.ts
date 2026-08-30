import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import serializer from '../utils/serializer.js';
import { compressToUint8Array, decompressFromUint8Array } from 'lz-string';
import {
  createPluginEnvelope,
  hasExactPayloadFields,
  hasOwnPayloadField,
  readOwnPayloadField,
  readPluginEnvelope,
} from '../core/plugin-envelope.js';
import { markBuiltInStorageTransformPlugin } from '../core/plugin-capabilities.js';

export interface CompressionCodec {
  compress(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
  decompress(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface CompressionPluginOptions {
  /** Minimum uncompressed byte length before compression is attempted. */
  threshold?: number;
  /** Optional bytes-to-bytes codec. */
  codec?: CompressionCodec;
  /** Non-empty codec label persisted in versioned metadata. */
  algorithm?: string;
}

type CompressionPayloadBody = {
  algorithm: string;
  data: string;
  originalSize: number;
};

type ParsedCompressionPayload = {
  payload: CompressionPayloadBody;
  versioned: boolean;
};

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const invalidCompressionPayload = (reason: string) =>
  createLocalSpaceError(
    'DESERIALIZATION_FAILED',
    'Failed to decompress payload: invalid compression payload.',
    { payloadKind: 'compression', reason }
  );

const validateCompressionPayload = (
  value: unknown,
  allowEmptyAlgorithm: boolean,
  expectedFields: readonly string[]
): CompressionPayloadBody => {
  if (!hasExactPayloadFields(value, expectedFields)) {
    throw invalidCompressionPayload('invalid-payload');
  }
  const algorithm = readOwnPayloadField(value, 'algorithm');
  const data = readOwnPayloadField(value, 'data');
  const originalSize = readOwnPayloadField(value, 'originalSize');
  if (
    typeof algorithm !== 'string' ||
    (!allowEmptyAlgorithm && algorithm.length === 0)
  ) {
    throw invalidCompressionPayload('invalid-algorithm');
  }
  if (
    typeof data !== 'string' ||
    data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(data)
  ) {
    throw invalidCompressionPayload('invalid-data');
  }
  if (
    typeof originalSize !== 'number' ||
    !Number.isSafeInteger(originalSize) ||
    originalSize < 0
  ) {
    throw invalidCompressionPayload('invalid-original-size');
  }
  return { algorithm, data, originalSize };
};

const parseCompressionPayload = (
  value: unknown
): ParsedCompressionPayload | null => {
  const envelope = readPluginEnvelope<unknown>(value, 'compression');
  if (envelope.matched) {
    return {
      payload: validateCompressionPayload(envelope.payload, false, [
        'algorithm',
        'data',
        'originalSize',
      ]),
      versioned: true,
    };
  }

  if (
    !value ||
    typeof value !== 'object' ||
    readOwnPayloadField(value, '__ls_compressed') !== true
  ) {
    return null;
  }

  const hasLegacyPayloadFields = ['algorithm', 'data', 'originalSize'].some(
    (field) => hasOwnPayloadField(value, field)
  );
  if (!hasLegacyPayloadFields) {
    return null;
  }

  // The 2.x label was informational and could be empty. Retain that reader
  // behavior only for marker-based legacy payloads.
  return {
    payload: validateCompressionPayload(value, true, [
      '__ls_compressed',
      'algorithm',
      'data',
      'originalSize',
    ]),
    versioned: false,
  };
};

const decodeUtf8 = (data: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(data);

const encodeUtf8 = (data: string): Uint8Array => new TextEncoder().encode(data);

const defaultCodec: CompressionCodec = {
  compress: (data) => compressToUint8Array(decodeUtf8(data)),
  decompress: (data) => {
    const decompressed = decompressFromUint8Array(data);
    if (decompressed === null) {
      throw new Error('The compressed byte sequence is invalid.');
    }
    return encodeUtf8(decompressed);
  },
};

const copyCodecBytes = (value: unknown, method: string): Uint8Array => {
  if (Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError(
      `Compression codec ${method}() must return Uint8Array.`
    );
  }
  const source = value as Uint8Array;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
};

const bytesToBase64 = (bytes: Uint8Array): string =>
  serializer.bufferToString(bytes.slice().buffer as ArrayBuffer);

const base64ToBytes = (value: string): Uint8Array =>
  new Uint8Array(serializer.stringToBuffer(value));

const serializeToBytes = async (value: unknown): Promise<Uint8Array> =>
  encodeUtf8(await serializer.serialize(value));

const validateOptions = (
  options: CompressionPluginOptions
): { threshold: number; codec: CompressionCodec; algorithm: string } => {
  const threshold = options.threshold ?? 1024;
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Compression threshold must be a non-negative safe integer.',
      { configKey: 'threshold', providedValue: threshold }
    );
  }

  const codec = options.codec ?? defaultCodec;
  if (
    !codec ||
    typeof codec.compress !== 'function' ||
    typeof codec.decompress !== 'function'
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Compression codec must provide compress() and decompress() functions.',
      { configKey: 'codec' }
    );
  }

  const algorithm =
    options.algorithm ?? (options.codec ? 'custom' : 'lz-string');
  if (typeof algorithm !== 'string' || algorithm.length === 0) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Compression algorithm must be a non-empty string.',
      { configKey: 'algorithm' }
    );
  }

  return { threshold, codec, algorithm };
};

const createCompressionPlugin = (
  options: CompressionPluginOptions = {}
): LocalSpacePlugin => {
  const { threshold, codec, algorithm } = validateOptions(options);

  const compressValue = async <T>(value: T): Promise<T> => {
    if (value == null) {
      return value;
    }

    const originalBytes = await serializeToBytes(value);
    if (originalBytes.byteLength < threshold) {
      return value;
    }

    const compressedBytes = copyCodecBytes(
      await codec.compress(originalBytes.slice()),
      'compress'
    );
    const envelope = createPluginEnvelope('compression', {
      algorithm,
      originalSize: originalBytes.byteLength,
      data: bytesToBase64(compressedBytes),
    } satisfies CompressionPayloadBody);

    // Include the V1 envelope header, metadata, and base64 expansion in the
    // decision. Storing raw compressed bytes that make the complete persisted
    // representation larger is not a compression win.
    const compressedRepresentation = await serializeToBytes(envelope);
    return compressedRepresentation.byteLength < originalBytes.byteLength
      ? (envelope as unknown as T)
      : value;
  };

  const decompressValue = async <T>(value: T | null): Promise<T | null> => {
    const parsed = parseCompressionPayload(value);
    if (!parsed) {
      return value;
    }
    const { payload, versioned } = parsed;
    if (versioned && payload.algorithm !== algorithm) {
      throw createLocalSpaceError(
        'DESERIALIZATION_FAILED',
        'Failed to decompress payload: compression algorithm mismatch.',
        {
          payloadKind: 'compression',
          reason: 'algorithm-mismatch',
          payloadAlgorithm: payload.algorithm,
          configuredAlgorithm: algorithm,
        }
      );
    }

    const decompressedBytes = copyCodecBytes(
      await codec.decompress(base64ToBytes(payload.data)),
      'decompress'
    );
    if (decompressedBytes.byteLength !== payload.originalSize) {
      throw createLocalSpaceError(
        'DESERIALIZATION_FAILED',
        'Failed to decompress payload: original size mismatch.',
        {
          payloadKind: 'compression',
          reason: 'original-size-mismatch',
          expectedSize: payload.originalSize,
          actualSize: decompressedBytes.byteLength,
        }
      );
    }

    return serializer.deserialize(decodeUtf8(decompressedBytes)) as T;
  };

  return {
    name: 'compression',
    priority: 5,
    beforeSet: async <T>(_key: string, value: T): Promise<T> => {
      try {
        return await compressValue(value);
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to compress payload'
        );
      }
    },
    afterGet: async <T>(_key: string, value: T | null): Promise<T | null> => {
      try {
        return await decompressValue(value);
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'DESERIALIZATION_FAILED',
          'Failed to decompress payload'
        );
      }
    },
    beforeSetItems: async <T>(
      entries: BatchItems<T>,
      _context: PluginContext
    ): Promise<BatchItems<T>> =>
      Promise.all(
        normalizeBatchEntries(entries).map(async ({ key, value }) => {
          try {
            return { key, value: await compressValue(value) };
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'OPERATION_FAILED',
              `Failed to compress payload for key "${key}"`,
              { key }
            );
          }
        })
      ),
    afterGetItems: async <T>(
      entries: BatchResponse<T>,
      _context: PluginContext
    ): Promise<BatchResponse<T>> =>
      Promise.all(
        entries.map(async ({ key, value }) => {
          try {
            return { key, value: await decompressValue(value) };
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'DESERIALIZATION_FAILED',
              `Failed to decompress payload for key "${key}"`,
              { key }
            );
          }
        })
      ),
  };
};

export const compressionPlugin = (
  options: CompressionPluginOptions = {}
): LocalSpacePlugin =>
  markBuiltInStorageTransformPlugin(
    createCompressionPlugin(options),
    'compression'
  );

export default compressionPlugin;
