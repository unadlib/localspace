import type { LocalSpacePlugin } from '../types';
import { createLocalSpaceError, toLocalSpaceError } from '../errors';
import serializer from '../utils/serializer';
import { compressToUint8Array, decompressFromUint8Array } from 'lz-string';

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

type CompressionPayload = {
  __ls_compressed: true;
  algorithm: string;
  data: string;
  originalSize: number;
};

const COMPRESSED_MARKER = '__ls_compressed';

const isCompressionPayload = (value: unknown): value is CompressionPayload =>
  !!value &&
  typeof value === 'object' &&
  (value as CompressionPayload).__ls_compressed === true;

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
    beforeSet: async <T>(_key: string, value: T): Promise<T> => {
      if (value == null) {
        return value;
      }

      const serialized = await serializer.serialize(value);
      const encoded = new TextEncoder().encode(serialized);
      if (encoded.byteLength < threshold) {
        return value;
      }

      let compressed: Uint8Array;
      try {
        compressed = toUint8Array(await codec.compress(serialized));
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to compress payload'
        );
      }

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
    },
    afterGet: async <T>(_key: string, value: T | null): Promise<T | null> => {
      if (!isCompressionPayload(value)) {
        return value;
      }
      try {
        const buffer = serializer.stringToBuffer(value.data);
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
  };
};

export default compressionPlugin;
