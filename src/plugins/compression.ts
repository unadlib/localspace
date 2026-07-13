import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { toLocalSpaceError } from '../errors.js';
import serializer from '../utils/serializer.js';
import { compressToUint8Array, decompressFromUint8Array } from 'lz-string';
import {
  hasOwnPayloadField,
  readPluginEnvelope,
} from '../core/plugin-envelope.js';

export interface CompressionCodec {
  compress(data: string): Promise<Uint8Array | string> | Uint8Array | string;
  decompress(data: Uint8Array | string): Promise<string> | string;
}

export interface CompressionPluginOptions {
  /** Minimum payload size in bytes before compression is attempted */
  threshold?: number;
  /** Optional custom codec */
  codec?: CompressionCodec;
  /** Algorithm label stored in metadata */
  algorithm?: string;
}

type CompressionPayloadBody = {
  algorithm: string;
  data: string;
  originalSize: number;
};

type CompressionPayload = CompressionPayloadBody & {
  __ls_compressed: true;
};

const validateCompressionPayload = (value: unknown): CompressionPayloadBody => {
  const payload = value as Partial<CompressionPayloadBody>;
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.algorithm !== 'string' ||
    payload.algorithm.length === 0 ||
    typeof payload.data !== 'string' ||
    typeof payload.originalSize !== 'number' ||
    !Number.isSafeInteger(payload.originalSize) ||
    payload.originalSize < 0
  ) {
    throw toLocalSpaceError(
      new Error('Invalid compression payload fields.'),
      'DESERIALIZATION_FAILED',
      'Failed to decompress payload: invalid compression payload.'
    );
  }
  return payload as CompressionPayloadBody;
};

const parseCompressionPayload = (
  value: unknown
): CompressionPayloadBody | null => {
  const envelope = readPluginEnvelope<unknown>(value, 'compression');
  if (envelope.matched) {
    return validateCompressionPayload(envelope.payload);
  }

  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<CompressionPayload>).__ls_compressed !== true
  ) {
    return null;
  }

  const hasLegacyPayloadFields = ['algorithm', 'data', 'originalSize'].some(
    (field) => hasOwnPayloadField(value, field)
  );
  if (!hasLegacyPayloadFields) {
    return null;
  }

  return validateCompressionPayload(value);
};

const defaultCodec: CompressionCodec = {
  compress: (data: string) => compressToUint8Array(data),
  decompress: (data: Uint8Array | string) => {
    if (typeof data === 'string') {
      const buffer = serializer.stringToBuffer(data);
      return decompressFromUint8Array(new Uint8Array(buffer)) ?? '';
    }
    return decompressFromUint8Array(data) ?? '';
  },
};

const toUint8Array = (value: Uint8Array | string): Uint8Array => {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  return value;
};

export const compressionPlugin = (
  options: CompressionPluginOptions = {}
): LocalSpacePlugin => {
  const threshold = options.threshold ?? 1024;
  const codec = options.codec ?? defaultCodec;
  const algorithm = options.algorithm ?? 'lz-string';

  return {
    name: 'compression',
    priority: 5,
    beforeSet: async <T>(
      _key: string,
      value: T,
      context: PluginContext
    ): Promise<T> => {
      // Skip if already processed by batch hook
      if (context.operationState.isBatch) {
        return value;
      }
      if (value == null) {
        return value;
      }
      try {
        const serialized = await serializer.serialize(value);
        const encoded = new TextEncoder().encode(serialized);
        if (encoded.byteLength < threshold) {
          return value;
        }

        const compressed = toUint8Array(await codec.compress(serialized));
        const payload: CompressionPayload = {
          __ls_compressed: true,
          algorithm,
          originalSize: encoded.byteLength,
          data: serializer.bufferToString(
            compressed.buffer.slice(
              compressed.byteOffset,
              compressed.byteOffset + compressed.byteLength
            ) as ArrayBuffer
          ),
        };
        return payload as unknown as T;
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to compress payload'
        );
      }
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
      const payload = parseCompressionPayload(value);
      if (!payload) {
        return value;
      }
      try {
        const buffer = serializer.stringToBuffer(payload.data);
        const decompressed = await codec.decompress(new Uint8Array(buffer));
        return serializer.deserialize(decompressed) as T;
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
    ): Promise<BatchItems<T>> => {
      const normalized = normalizeBatchEntries(entries);

      const compressed = await Promise.all(
        normalized.map(async ({ key, value }) => {
          if (value == null) {
            return { key, value };
          }
          try {
            const serialized = await serializer.serialize(value);
            const encoded = new TextEncoder().encode(serialized);
            if (encoded.byteLength < threshold) {
              return { key, value };
            }

            const compressedData = toUint8Array(
              await codec.compress(serialized)
            );
            const payload: CompressionPayload = {
              __ls_compressed: true,
              algorithm,
              originalSize: encoded.byteLength,
              data: serializer.bufferToString(
                compressedData.buffer.slice(
                  compressedData.byteOffset,
                  compressedData.byteOffset + compressedData.byteLength
                ) as ArrayBuffer
              ),
            };
            return { key, value: payload as unknown as T };
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'OPERATION_FAILED',
              `Failed to compress payload for key "${key}"`
            );
          }
        })
      );

      return compressed;
    },
    afterGetItems: async <T>(
      entries: BatchResponse<T>,
      _context: PluginContext
    ): Promise<BatchResponse<T>> => {
      const decompressed = await Promise.all(
        entries.map(async ({ key, value }) => {
          const payload = parseCompressionPayload(value);
          if (!payload) {
            return { key, value };
          }
          try {
            const buffer = serializer.stringToBuffer(payload.data);
            const decompressedData = await codec.decompress(
              new Uint8Array(buffer)
            );
            return {
              key,
              value: serializer.deserialize(decompressedData) as T,
            };
          } catch (error) {
            throw toLocalSpaceError(
              error,
              'DESERIALIZATION_FAILED',
              `Failed to decompress payload for key "${key}"`
            );
          }
        })
      );

      return decompressed;
    },
  };
};

export default compressionPlugin;
