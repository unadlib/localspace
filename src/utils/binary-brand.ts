const storageBinaryNames = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
] as const;

type StorageBinaryName = (typeof storageBinaryNames)[number];
export type StorageBinaryTag = `[object ${'ArrayBuffer' | StorageBinaryName}]`;

type IntrinsicGetter = (this: unknown) => unknown;
type ArrayBufferViewInfo = {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
};

const getter = (prototype: object, property: PropertyKey): IntrinsicGetter =>
  Object.getOwnPropertyDescriptor(prototype, property)!.get!;

const arrayBufferByteLength = getter(ArrayBuffer.prototype, 'byteLength');
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : getter(SharedArrayBuffer.prototype, 'byteLength');

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = getter(typedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getter(typedArrayPrototype, 'buffer');
const typedArrayByteOffset = getter(typedArrayPrototype, 'byteOffset');
const typedArrayByteLength = getter(typedArrayPrototype, 'byteLength');
const dataViewBuffer = getter(DataView.prototype, 'buffer');
const dataViewByteOffset = getter(DataView.prototype, 'byteOffset');
const dataViewByteLength = getter(DataView.prototype, 'byteLength');
const storageBinaryNameSet = new Set<string>(storageBinaryNames);

const matchesGetter = (
  value: unknown,
  intrinsic: IntrinsicGetter | undefined
): value is object => {
  if (!intrinsic || !value || typeof value !== 'object') return false;
  try {
    intrinsic.call(value);
    return true;
  } catch {
    return false;
  }
};

const isArrayBufferValue = (value: unknown): value is ArrayBuffer =>
  matchesGetter(value, arrayBufferByteLength);

export const isSharedArrayBufferValue = (
  value: unknown
): value is SharedArrayBuffer =>
  matchesGetter(value, sharedArrayBufferByteLength);

const getTypedArrayName = (value: unknown): string | null => {
  if (!ArrayBuffer.isView(value)) return null;
  const name = typedArrayName.call(value);
  return typeof name === 'string' ? name : null;
};

export const getStorageBinaryTag = (
  value: unknown
): StorageBinaryTag | null => {
  if (isArrayBufferValue(value)) return '[object ArrayBuffer]';
  const name = getTypedArrayName(value);
  return name && storageBinaryNameSet.has(name)
    ? (`[object ${name}]` as StorageBinaryTag)
    : null;
};

const isUint8ArrayValue = (value: unknown): value is Uint8Array =>
  getTypedArrayName(value) === 'Uint8Array';

export const getArrayBufferViewInfo = (
  value: unknown
): ArrayBufferViewInfo | null => {
  if (!ArrayBuffer.isView(value)) return null;
  const accessors = getTypedArrayName(value)
    ? [typedArrayBuffer, typedArrayByteOffset, typedArrayByteLength]
    : [dataViewBuffer, dataViewByteOffset, dataViewByteLength];
  try {
    return {
      buffer: accessors[0].call(value) as ArrayBufferLike,
      byteOffset: accessors[1].call(value) as number,
      byteLength: accessors[2].call(value) as number,
    };
  } catch {
    return null;
  }
};

export const copyBufferSourceBytes = (value: unknown): Uint8Array | null => {
  try {
    const view = getArrayBufferViewInfo(value);
    const source = isArrayBufferValue(value)
      ? new Uint8Array(value)
      : view
        ? new Uint8Array(
            view.buffer as ArrayBuffer,
            view.byteOffset,
            view.byteLength
          )
        : null;
    return source ? new Uint8Array(source) : null;
  } catch {
    return null;
  }
};

export const copyUint8ArrayBytes = (value: unknown): Uint8Array | null =>
  isUint8ArrayValue(value) ? copyBufferSourceBytes(value) : null;

const blobSize =
  typeof Blob === 'undefined' ? undefined : getter(Blob.prototype, 'size');
const blobType =
  typeof Blob === 'undefined' ? undefined : getter(Blob.prototype, 'type');
const blobArrayBuffer =
  typeof Blob === 'undefined' ? undefined : Blob.prototype.arrayBuffer;

export const isBlobValue = (value: unknown): value is Blob =>
  matchesGetter(value, blobSize);

export const readBlobValue = async (
  value: Blob
): Promise<{ type: string; buffer: ArrayBuffer }> => {
  if (!blobType || !blobArrayBuffer) {
    throw new TypeError('Blob arrayBuffer() is not supported in this runtime.');
  }
  return {
    type: blobType.call(value) as string,
    buffer: await blobArrayBuffer.call(value),
  };
};
