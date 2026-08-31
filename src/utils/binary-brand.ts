export type StorageBinaryTag =
  | '[object ArrayBuffer]'
  | '[object Int8Array]'
  | '[object Uint8Array]'
  | '[object Uint8ClampedArray]'
  | '[object Int16Array]'
  | '[object Uint16Array]'
  | '[object Int32Array]'
  | '[object Uint32Array]'
  | '[object Float32Array]'
  | '[object Float64Array]'
  | '[object BigInt64Array]'
  | '[object BigUint64Array]';

type ArrayBufferViewInfo = {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
  typedArrayName: string | null;
};

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!;

const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')
        ?.get;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer'
)!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset'
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)!.get!;

const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'buffer'
)!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteOffset'
)!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength'
)!.get!;

const storageBinaryTags: Readonly<Record<string, StorageBinaryTag>> = {
  Int8Array: '[object Int8Array]',
  Uint8Array: '[object Uint8Array]',
  Uint8ClampedArray: '[object Uint8ClampedArray]',
  Int16Array: '[object Int16Array]',
  Uint16Array: '[object Uint16Array]',
  Int32Array: '[object Int32Array]',
  Uint32Array: '[object Uint32Array]',
  Float32Array: '[object Float32Array]',
  Float64Array: '[object Float64Array]',
  BigInt64Array: '[object BigInt64Array]',
  BigUint64Array: '[object BigUint64Array]',
};

export const isArrayBufferValue = (value: unknown): value is ArrayBuffer => {
  if (!value || typeof value !== 'object') return false;
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
};

export const isSharedArrayBufferValue = (
  value: unknown
): value is SharedArrayBuffer => {
  if (!sharedArrayBufferByteLength || !value || typeof value !== 'object') {
    return false;
  }
  try {
    sharedArrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
};

const getTypedArrayName = (value: unknown): string | null => {
  if (!ArrayBuffer.isView(value)) return null;
  try {
    const name = typedArrayName.call(value) as unknown;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
};

export const getStorageBinaryTag = (
  value: unknown
): StorageBinaryTag | null => {
  if (isArrayBufferValue(value)) return '[object ArrayBuffer]';
  const name = getTypedArrayName(value);
  return name ? (storageBinaryTags[name] ?? null) : null;
};

export const isUint8ArrayValue = (value: unknown): value is Uint8Array =>
  getTypedArrayName(value) === 'Uint8Array';

export const getArrayBufferViewInfo = (
  value: unknown
): ArrayBufferViewInfo | null => {
  if (!ArrayBuffer.isView(value)) return null;
  const name = getTypedArrayName(value);
  try {
    if (name) {
      return {
        buffer: typedArrayBuffer.call(value) as ArrayBufferLike,
        byteOffset: typedArrayByteOffset.call(value) as number,
        byteLength: typedArrayByteLength.call(value) as number,
        typedArrayName: name,
      };
    }
    return {
      buffer: dataViewBuffer.call(value) as ArrayBufferLike,
      byteOffset: dataViewByteOffset.call(value) as number,
      byteLength: dataViewByteLength.call(value) as number,
      typedArrayName: null,
    };
  } catch {
    return null;
  }
};

export const copyBufferSourceBytes = (value: unknown): Uint8Array | null => {
  try {
    if (isArrayBufferValue(value)) {
      const source = new Uint8Array(value);
      const copy = new Uint8Array(source.byteLength);
      copy.set(source);
      return copy;
    }
    const info = getArrayBufferViewInfo(value);
    if (!info) return null;
    const source = new Uint8Array(
      info.buffer as ArrayBuffer,
      info.byteOffset,
      info.byteLength
    );
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  } catch {
    return null;
  }
};

export const copyUint8ArrayBytes = (value: unknown): Uint8Array | null =>
  isUint8ArrayValue(value) ? copyBufferSourceBytes(value) : null;

const blobSize =
  typeof Blob === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
const blobType =
  typeof Blob === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(Blob.prototype, 'type')?.get;
const blobArrayBuffer =
  typeof Blob === 'undefined' ? undefined : Blob.prototype.arrayBuffer;

export const isBlobValue = (value: unknown): value is Blob => {
  if (!blobSize || !value || typeof value !== 'object') return false;
  try {
    blobSize.call(value);
    return true;
  } catch {
    return false;
  }
};

export const readBlobValue = async (
  value: Blob
): Promise<{ type: string; buffer: ArrayBuffer }> => {
  if (!blobType || !blobArrayBuffer || !isBlobValue(value)) {
    throw new TypeError('Blob arrayBuffer() is not supported in this runtime.');
  }
  return {
    type: blobType.call(value) as string,
    buffer: await blobArrayBuffer.call(value),
  };
};
