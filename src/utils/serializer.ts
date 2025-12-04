import { createBlob } from './helpers';
import type { Serializer } from '../types';
import { createLocalSpaceError } from '../errors';

const BASE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BLOB_TYPE_PREFIX = '~~local_forage_type~';
const BLOB_TYPE_PREFIX_REGEX = /^~~local_forage_type~([^~]+)~/;

const SERIALIZED_MARKER = '__lfsc__:';
const SERIALIZED_MARKER_LENGTH = SERIALIZED_MARKER.length;

// Type markers
const TYPE_ARRAYBUFFER = 'arbf';
const TYPE_BLOB = 'blob';
const TYPE_INT8ARRAY = 'si08';
const TYPE_UINT8ARRAY = 'ui08';
const TYPE_UINT8CLAMPEDARRAY = 'uic8';
const TYPE_INT16ARRAY = 'si16';
const TYPE_INT32ARRAY = 'si32';
const TYPE_UINT16ARRAY = 'ur16';
const TYPE_UINT32ARRAY = 'ui32';
const TYPE_FLOAT32ARRAY = 'fl32';
const TYPE_FLOAT64ARRAY = 'fl64';
const TYPE_BIGINT64ARRAY = 'bi64';
const TYPE_BIGUINT64ARRAY = 'bu64';
const TYPE_SERIALIZED_MARKER_LENGTH =
  SERIALIZED_MARKER_LENGTH + TYPE_ARRAYBUFFER.length;

const toString = Object.prototype.toString;

const getGlobalScope = (): typeof globalThis => {
  // source: https://github.com/Raynos/global/blob/master/window.js
  let win: typeof globalThis;
  if (typeof window !== 'undefined') {
    win = window;
  } else if (typeof global !== 'undefined') {
    win = global;
  } else if (typeof self !== 'undefined') {
    win = self;
  } else {
    win = {} as typeof globalThis;
  }
  return win;
};

function stringToBuffer(serializedString: string): ArrayBuffer {
  const scope = getGlobalScope();
  const bufferLength = serializedString.length * 0.75;
  const len = serializedString.length;
  let p = 0;

  let actualLength = bufferLength;
  if (serializedString[serializedString.length - 1] === '=') {
    actualLength--;
    if (serializedString[serializedString.length - 2] === '=') {
      actualLength--;
    }
  }

  const buffer = new scope.ArrayBuffer(actualLength);
  const bytes = new scope.Uint8Array(buffer);

  for (let i = 0; i < len; i += 4) {
    const encoded1 = BASE_CHARS.indexOf(serializedString[i]);
    const encoded2 = BASE_CHARS.indexOf(serializedString[i + 1]);
    const encoded3 = BASE_CHARS.indexOf(serializedString[i + 2]);
    const encoded4 = BASE_CHARS.indexOf(serializedString[i + 3]);

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  return buffer;
}

function bufferToString(buffer: ArrayBuffer): string {
  const scope = getGlobalScope();
  const bytes = new scope.Uint8Array(buffer);
  let base64String = '';

  for (let i = 0; i < bytes.length; i += 3) {
    base64String += BASE_CHARS[bytes[i] >> 2];
    base64String += BASE_CHARS[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    base64String +=
      BASE_CHARS[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    base64String += BASE_CHARS[bytes[i + 2] & 63];
  }

  if (bytes.length % 3 === 2) {
    base64String = base64String.substring(0, base64String.length - 1) + '=';
  } else if (bytes.length % 3 === 1) {
    base64String = base64String.substring(0, base64String.length - 2) + '==';
  }

  return base64String;
}

const typedArrayTagMap: Record<string, string> = {
  '[object Int8Array]': TYPE_INT8ARRAY,
  '[object Uint8Array]': TYPE_UINT8ARRAY,
  '[object Uint8ClampedArray]': TYPE_UINT8CLAMPEDARRAY,
  '[object Int16Array]': TYPE_INT16ARRAY,
  '[object Uint16Array]': TYPE_UINT16ARRAY,
  '[object Int32Array]': TYPE_INT32ARRAY,
  '[object Uint32Array]': TYPE_UINT32ARRAY,
  '[object Float32Array]': TYPE_FLOAT32ARRAY,
  '[object Float64Array]': TYPE_FLOAT64ARRAY,
  '[object BigInt64Array]': TYPE_BIGINT64ARRAY,
  '[object BigUint64Array]': TYPE_BIGUINT64ARRAY,
};

function isTypedArray(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

async function serialize(value: unknown): Promise<string> {
  const valueType = value != null ? toString.call(value) : '';

  if (valueType === '[object ArrayBuffer]') {
    return (
      SERIALIZED_MARKER +
      TYPE_ARRAYBUFFER +
      bufferToString(value as ArrayBuffer)
    );
  }

  if (isTypedArray(value)) {
    const marker = typedArrayTagMap[valueType];
    if (!marker) {
      throw createLocalSpaceError(
        'SERIALIZATION_FAILED',
        'Failed to get type for BinaryArray',
        { valueType }
      );
    }

    const offset = value.byteOffset;
    const length = value.byteLength;
    const sourceBuffer = value.buffer;
    const normalizedBuffer =
      sourceBuffer instanceof ArrayBuffer
        ? sourceBuffer.slice(offset, offset + length)
        : new Uint8Array(sourceBuffer, offset, length).slice().buffer;

    return SERIALIZED_MARKER + marker + bufferToString(normalizedBuffer);
  }

  if (valueType === '[object Blob]') {
    const blob = value as Blob;
    const arrayBuffer = await blob.arrayBuffer();
    const str =
      BLOB_TYPE_PREFIX + blob.type + '~' + bufferToString(arrayBuffer);
    return SERIALIZED_MARKER + TYPE_BLOB + str;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    console.error("Couldn't convert value into a JSON string: ", value);
    throw error;
  }
}

function deserialize(value: string): unknown {
  // If not specially serialized, parse as JSON
  if (value.substring(0, SERIALIZED_MARKER_LENGTH) !== SERIALIZED_MARKER) {
    return JSON.parse(value);
  }

  const serializedString = value.substring(TYPE_SERIALIZED_MARKER_LENGTH);
  const type = value.substring(
    SERIALIZED_MARKER_LENGTH,
    TYPE_SERIALIZED_MARKER_LENGTH
  );

  let blobType: string | undefined;
  let actualSerializedString = serializedString;

  // Handle backwards-compatible blob type
  if (type === TYPE_BLOB && BLOB_TYPE_PREFIX_REGEX.test(serializedString)) {
    const matcher = serializedString.match(BLOB_TYPE_PREFIX_REGEX);
    if (matcher) {
      blobType = matcher[1];
      actualSerializedString = serializedString.substring(matcher[0].length);
    }
  }

  const buffer = stringToBuffer(actualSerializedString);

  // Return the right type based on the marker
  const scope = getGlobalScope();
  switch (type) {
    case TYPE_ARRAYBUFFER:
      return buffer;
    case TYPE_BLOB:
      return createBlob([buffer], { type: blobType });
    case TYPE_INT8ARRAY:
      return new scope.Int8Array(buffer);
    case TYPE_UINT8ARRAY:
      return new scope.Uint8Array(buffer);
    case TYPE_UINT8CLAMPEDARRAY:
      return new scope.Uint8ClampedArray(buffer);
    case TYPE_INT16ARRAY:
      return new scope.Int16Array(buffer);
    case TYPE_UINT16ARRAY:
      return new scope.Uint16Array(buffer);
    case TYPE_INT32ARRAY:
      return new scope.Int32Array(buffer);
    case TYPE_UINT32ARRAY:
      return new scope.Uint32Array(buffer);
    case TYPE_FLOAT32ARRAY:
      return new scope.Float32Array(buffer);
    case TYPE_FLOAT64ARRAY:
      return new scope.Float64Array(buffer);
    case TYPE_BIGINT64ARRAY:
      if (typeof scope.BigInt64Array === 'undefined') {
        throw createLocalSpaceError(
          'DESERIALIZATION_FAILED',
          'BigInt64Array is not supported in this environment',
          { operation: 'deserialize', type }
        );
      }
      return new scope.BigInt64Array(buffer);
    case TYPE_BIGUINT64ARRAY:
      if (typeof scope.BigUint64Array === 'undefined') {
        throw createLocalSpaceError(
          'DESERIALIZATION_FAILED',
          'BigUint64Array is not supported in this environment',
          { operation: 'deserialize', type }
        );
      }
      return new scope.BigUint64Array(buffer);
    default:
      throw createLocalSpaceError(
        'DESERIALIZATION_FAILED',
        'Unknown type: ' + type,
        {
          operation: 'deserialize',
          type,
        }
      );
  }
}

const localspaceSerializer: Serializer = {
  serialize,
  deserialize,
  stringToBuffer,
  bufferToString,
};

export default localspaceSerializer;
