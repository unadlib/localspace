import { createLocalSpaceError } from '../errors.js';
import type { StorageBinary, StorageValue } from '../types.js';
import serializer from '../utils/serializer.js';
import { inspectStorageValue } from './storage-value.js';

export const STORED_RECORD_PROPERTY = '__localspace__' as const;
export const STORED_RECORD_NAMESPACE = 'localspace.record' as const;
export const STORED_RECORD_VERSION = 1 as const;
export const STORED_RECORD_CODEC = 'localspace.storage-value' as const;

export type StoredBinaryKind =
  | 'ArrayBuffer'
  | 'Int8Array'
  | 'Uint8Array'
  | 'Uint8ClampedArray'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Int32Array'
  | 'Uint32Array'
  | 'Float32Array'
  | 'Float64Array'
  | 'BigInt64Array'
  | 'BigUint64Array';

export type EncodedStorageValueV1 =
  | null
  | boolean
  | number
  | string
  | {
      type: 'array';
      items: EncodedStorageValueV1[];
    }
  | {
      type: 'object';
      prototype: 'object' | 'null';
      entries: Array<[string, EncodedStorageValueV1]>;
    }
  | {
      type: 'binary';
      kind: StoredBinaryKind;
      data: string;
    };

export type StoredRecordV1 = {
  [STORED_RECORD_PROPERTY]: {
    namespace: typeof STORED_RECORD_NAMESPACE;
    version: typeof STORED_RECORD_VERSION;
  };
  payload: {
    codec: typeof STORED_RECORD_CODEC;
    data: EncodedStorageValueV1;
  };
};

export type StoredRecordReadResult =
  | { matched: false }
  | { matched: true; value: StorageValue };

const objectToString = Object.prototype.toString;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const binaryKinds: Record<string, StoredBinaryKind> = {
  '[object ArrayBuffer]': 'ArrayBuffer',
  '[object Int8Array]': 'Int8Array',
  '[object Uint8Array]': 'Uint8Array',
  '[object Uint8ClampedArray]': 'Uint8ClampedArray',
  '[object Int16Array]': 'Int16Array',
  '[object Uint16Array]': 'Uint16Array',
  '[object Int32Array]': 'Int32Array',
  '[object Uint32Array]': 'Uint32Array',
  '[object Float32Array]': 'Float32Array',
  '[object Float64Array]': 'Float64Array',
  '[object BigInt64Array]': 'BigInt64Array',
  '[object BigUint64Array]': 'BigUint64Array',
};

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ownDataDescriptor = (
  value: object,
  property: PropertyKey
): PropertyDescriptor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && 'value' in descriptor ? descriptor : undefined;
};

const hasExactDataProperties = (
  value: object,
  expected: readonly string[]
): boolean => {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    return false;
  }
  return expected.every((key) => {
    const descriptor = ownDataDescriptor(value, key);
    return !!descriptor?.enumerable;
  });
};

const serializationFailure = (value: unknown): never => {
  const issue = inspectStorageValue(value);
  throw createLocalSpaceError(
    'SERIALIZATION_FAILED',
    issue
      ? `Cannot encode LocalSpace StoredRecord: value at ${issue.path} ${issue.reason}.`
      : 'Cannot encode LocalSpace StoredRecord.',
    issue
      ? {
          valuePath: issue.path,
          valueType: issue.valueType,
          valueReason: issue.reason,
        }
      : undefined
  );
};

const deserializationFailure = (reason: string, path: string): never => {
  throw createLocalSpaceError(
    'DESERIALIZATION_FAILED',
    `Invalid LocalSpace StoredRecord v1 at ${path}: ${reason}.`,
    {
      recordNamespace: STORED_RECORD_NAMESPACE,
      recordVersion: STORED_RECORD_VERSION,
      valuePath: path,
      valueReason: reason,
    }
  );
};

const binaryBytes = (value: StorageBinary, tag: string): Uint8Array => {
  if (tag === '[object ArrayBuffer]') {
    return new Uint8Array(value as ArrayBuffer).slice();
  }
  const view = value as ArrayBufferView;
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength
  ).slice();
};

const encodeValue = (value: StorageValue): EncodedStorageValueV1 => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 0 : value;
  }

  const tag = objectToString.call(value);
  const kind = binaryKinds[tag];
  if (kind) {
    const bytes = binaryBytes(value as StorageBinary, tag);
    return {
      type: 'binary',
      kind,
      data: serializer.bufferToString(bytes.buffer as ArrayBuffer),
    };
  }

  if (Array.isArray(value)) {
    const items: EncodedStorageValueV1[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = ownDataDescriptor(value, String(index))!;
      items.push(encodeValue(descriptor.value as StorageValue));
    }
    return { type: 'array', items };
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key): [string, EncodedStorageValueV1] => {
    const descriptor = ownDataDescriptor(value, key)!;
    return [key, encodeValue(descriptor.value as StorageValue)];
  });
  return {
    type: 'object',
    prototype: Object.getPrototypeOf(value) === null ? 'null' : 'object',
    entries,
  };
};

export const createStoredRecord = (value: StorageValue): StoredRecordV1 => {
  if (inspectStorageValue(value)) {
    serializationFailure(value);
  }

  return {
    [STORED_RECORD_PROPERTY]: {
      namespace: STORED_RECORD_NAMESPACE,
      version: STORED_RECORD_VERSION,
    },
    payload: {
      codec: STORED_RECORD_CODEC,
      data: encodeValue(value),
    },
  };
};

const decodeBinary = (
  kind: StoredBinaryKind,
  data: string,
  path: string
): StorageBinary => {
  if (!BASE64_PATTERN.test(data)) {
    return deserializationFailure('binary data is not canonical base64', path);
  }

  const buffer = serializer.stringToBuffer(data);
  if (serializer.bufferToString(buffer) !== data) {
    return deserializationFailure('binary data is not canonical base64', path);
  }

  try {
    switch (kind) {
      case 'ArrayBuffer':
        return buffer;
      case 'Int8Array':
        return new Int8Array(buffer);
      case 'Uint8Array':
        return new Uint8Array(buffer);
      case 'Uint8ClampedArray':
        return new Uint8ClampedArray(buffer);
      case 'Int16Array':
        return new Int16Array(buffer);
      case 'Uint16Array':
        return new Uint16Array(buffer);
      case 'Int32Array':
        return new Int32Array(buffer);
      case 'Uint32Array':
        return new Uint32Array(buffer);
      case 'Float32Array':
        return new Float32Array(buffer);
      case 'Float64Array':
        return new Float64Array(buffer);
      case 'BigInt64Array':
        if (typeof BigInt64Array === 'undefined') {
          return deserializationFailure(
            'BigInt64Array is unavailable in this runtime',
            path
          );
        }
        return new BigInt64Array(buffer);
      case 'BigUint64Array':
        if (typeof BigUint64Array === 'undefined') {
          return deserializationFailure(
            'BigUint64Array is unavailable in this runtime',
            path
          );
        }
        return new BigUint64Array(buffer);
    }
  } catch {
    return deserializationFailure(
      `binary byte length is invalid for ${kind}`,
      path
    );
  }
};

const decodeValue = (
  node: unknown,
  path: string,
  ancestors: WeakSet<object>
): StorageValue => {
  if (node === null || typeof node === 'string' || typeof node === 'boolean') {
    return node;
  }
  if (typeof node === 'number') {
    if (!Number.isFinite(node) || Object.is(node, -0)) {
      return deserializationFailure(
        'numbers must be finite and canonicalized',
        path
      );
    }
    return node;
  }
  if (!isObject(node)) {
    return deserializationFailure('value node has an invalid type', path);
  }
  if (ancestors.has(node)) {
    return deserializationFailure('value nodes must not be cyclic', path);
  }

  ancestors.add(node);
  try {
    const typeDescriptor = ownDataDescriptor(node, 'type');
    const type = typeDescriptor?.value;
    if (type === 'array') {
      if (!hasExactDataProperties(node, ['type', 'items'])) {
        return deserializationFailure('array node shape is invalid', path);
      }
      const items = ownDataDescriptor(node, 'items')!.value;
      if (!Array.isArray(items)) {
        return deserializationFailure('array items must be an array', path);
      }
      const decoded: StorageValue[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = ownDataDescriptor(items, String(index));
        if (!item?.enumerable) {
          return deserializationFailure(
            'array items must be dense data properties',
            `${path}[${index}]`
          );
        }
        decoded.push(decodeValue(item.value, `${path}[${index}]`, ancestors));
      }
      if (
        Reflect.ownKeys(items).some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))
        )
      ) {
        return deserializationFailure(
          'array items contain custom properties',
          path
        );
      }
      return decoded;
    }

    if (type === 'object') {
      if (!hasExactDataProperties(node, ['type', 'prototype', 'entries'])) {
        return deserializationFailure('object node shape is invalid', path);
      }
      const prototype = ownDataDescriptor(node, 'prototype')!.value;
      const entries = ownDataDescriptor(node, 'entries')!.value;
      if (
        (prototype !== 'object' && prototype !== 'null') ||
        !Array.isArray(entries)
      ) {
        return deserializationFailure(
          'object prototype or entries are invalid',
          path
        );
      }

      const result: Record<string, StorageValue> =
        prototype === 'null' ? Object.create(null) : {};
      let previousKey: string | undefined;
      for (let index = 0; index < entries.length; index++) {
        const entryDescriptor = ownDataDescriptor(entries, String(index));
        if (!entryDescriptor?.enumerable) {
          return deserializationFailure(
            'object entries must be dense data properties',
            `${path}.entries[${index}]`
          );
        }
        const entry = entryDescriptor.value;
        const keyDescriptor = Array.isArray(entry)
          ? ownDataDescriptor(entry, '0')
          : undefined;
        const valueDescriptor = Array.isArray(entry)
          ? ownDataDescriptor(entry, '1')
          : undefined;
        if (
          !Array.isArray(entry) ||
          ownDataDescriptor(entry, 'length')?.value !== 2 ||
          Reflect.ownKeys(entry).some(
            (key) => key !== '0' && key !== '1' && key !== 'length'
          ) ||
          !keyDescriptor?.enumerable ||
          !valueDescriptor?.enumerable ||
          typeof keyDescriptor.value !== 'string'
        ) {
          return deserializationFailure(
            'object entry shape is invalid',
            `${path}.entries[${index}]`
          );
        }
        const key = keyDescriptor.value;
        if (previousKey !== undefined && previousKey >= key) {
          return deserializationFailure(
            'object entry keys must be unique and sorted',
            `${path}.entries[${index}]`
          );
        }
        previousKey = key;
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: decodeValue(
            valueDescriptor.value,
            `${path}.entries[${index}][1]`,
            ancestors
          ),
        });
      }
      if (
        Reflect.ownKeys(entries).some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))
        )
      ) {
        return deserializationFailure(
          'object entries contain custom properties',
          path
        );
      }
      return result;
    }

    if (type === 'binary') {
      if (!hasExactDataProperties(node, ['type', 'kind', 'data'])) {
        return deserializationFailure('binary node shape is invalid', path);
      }
      const kind = ownDataDescriptor(node, 'kind')!.value;
      const data = ownDataDescriptor(node, 'data')!.value;
      if (
        typeof kind !== 'string' ||
        !Object.values(binaryKinds).includes(kind as StoredBinaryKind) ||
        typeof data !== 'string'
      ) {
        return deserializationFailure('binary kind or data is invalid', path);
      }
      return decodeBinary(kind as StoredBinaryKind, data, path);
    }

    return deserializationFailure('value node discriminator is invalid', path);
  } finally {
    ancestors.delete(node);
  }
};

export const readStoredRecord = (value: unknown): StoredRecordReadResult => {
  if (!isObject(value)) {
    return { matched: false };
  }

  const headerDescriptor = ownDataDescriptor(value, STORED_RECORD_PROPERTY);
  if (!headerDescriptor || !isObject(headerDescriptor.value)) {
    return { matched: false };
  }
  const header = headerDescriptor.value;
  const namespaceDescriptor = ownDataDescriptor(header, 'namespace');
  if (namespaceDescriptor?.value !== STORED_RECORD_NAMESPACE) {
    return { matched: false };
  }

  const version = ownDataDescriptor(header, 'version')?.value;
  if (version !== STORED_RECORD_VERSION) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      'Unsupported LocalSpace StoredRecord version.',
      {
        recordNamespace: STORED_RECORD_NAMESPACE,
        recordVersion: version,
        supportedRecordVersions: [STORED_RECORD_VERSION],
      }
    );
  }
  if (
    !hasExactDataProperties(value, [STORED_RECORD_PROPERTY, 'payload']) ||
    !hasExactDataProperties(header, ['namespace', 'version'])
  ) {
    return deserializationFailure('record or header shape is invalid', '$');
  }

  const payload = ownDataDescriptor(value, 'payload')!.value;
  if (
    !isObject(payload) ||
    !hasExactDataProperties(payload, ['codec', 'data']) ||
    ownDataDescriptor(payload, 'codec')!.value !== STORED_RECORD_CODEC
  ) {
    return deserializationFailure('payload shape or codec is invalid', '$');
  }

  return {
    matched: true,
    value: decodeValue(
      ownDataDescriptor(payload, 'data')!.value,
      '$.payload.data',
      new WeakSet()
    ),
  };
};

export const decodeStoredRecordValue = (value: unknown): unknown => {
  const record = readStoredRecord(value);
  return record.matched ? record.value : value;
};

/** Validate, copy, and normalize a StorageValue through the frozen v1 codec. */
export const canonicalizeStorageValue = (value: StorageValue): StorageValue => {
  const record = readStoredRecord(createStoredRecord(value));
  if (!record.matched) {
    throw createLocalSpaceError(
      'SERIALIZATION_FAILED',
      'Failed to canonicalize LocalSpace StorageValue.'
    );
  }
  return record.value;
};
