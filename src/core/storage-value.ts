import { createLocalSpaceError } from '../errors.js';
import type { StorageBinary, StorageValue } from '../types.js';
import {
  copyBufferSourceBytes,
  getArrayBufferViewInfo,
  getStorageBinaryTag,
  isBlobValue,
  isSharedArrayBufferValue,
} from '../utils/binary-brand.js';
import {
  PLUGIN_ENVELOPE_NAMESPACE,
  PLUGIN_ENVELOPE_PROPERTY,
} from './plugin-envelope.js';

const hasOwn = Object.prototype.hasOwnProperty;
const functionToString = Function.prototype.toString;
const nativeObjectSource = functionToString.call(Object);
const dateGetTime = Date.prototype.getTime;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const regexpSource = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  'source'
)!.get!;

type StorageValueIssue = {
  path: string;
  reason: string;
  valueType: string;
};

type StorageValueWriteContext = {
  operation: 'setItem' | 'setItems' | 'runTransaction';
  key?: string;
  valueSource?: 'application' | 'plugin-output';
  plugin?: string;
  allowReservedPluginEnvelope?: boolean;
};

const propertyPath = (parent: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;

const describeType = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const binaryTag = getStorageBinaryTag(value);
  if (binaryTag) return binaryTag.slice(8, -1);
  if (isSharedArrayBufferValue(value)) return 'SharedArrayBuffer';
  if (Array.isArray(value)) return 'Array';
  if (ArrayBuffer.isView(value)) return 'DataView';
  if (isBlobValue(value)) return 'Blob';

  const intrinsicBrands: ReadonlyArray<readonly [string, () => unknown]> = [
    ['Date', () => dateGetTime.call(value)],
    ['Map', () => mapSize.call(value)],
    ['Set', () => setSize.call(value)],
    ['RegExp', () => regexpSource.call(value)],
  ];
  for (const [name, check] of intrinsicBrands) {
    try {
      check();
      return name;
    } catch {
      // Continue until an intrinsic internal-slot check succeeds.
    }
  }
  try {
    return Object.getPrototypeOf(value) === null
      ? 'null-prototype Object'
      : 'Object';
  } catch {
    return 'uninspectable-object';
  }
};

const issue = (
  path: string,
  reason: string,
  value: unknown
): StorageValueIssue => ({
  path,
  reason,
  valueType: describeType(value),
});

const hasReservedPluginEnvelopeHeader = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const header = Object.getOwnPropertyDescriptor(
    value,
    PLUGIN_ENVELOPE_PROPERTY
  );
  if (!header || !('value' in header) || !header.value) return false;
  if (typeof header.value !== 'object' || Array.isArray(header.value)) {
    return false;
  }
  const namespace = Object.getOwnPropertyDescriptor(header.value, 'namespace');
  return (
    !!namespace &&
    'value' in namespace &&
    namespace.value === PLUGIN_ENVELOPE_NAMESPACE
  );
};

const hasPlainObjectPrototype = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return false;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor'
  );
  return (
    Object.getPrototypeOf(prototype) === null &&
    !!constructorDescriptor &&
    'value' in constructorDescriptor &&
    typeof constructorDescriptor.value === 'function' &&
    functionToString.call(constructorDescriptor.value) === nativeObjectSource
  );
};

const findStorageValueIssue = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>
): StorageValueIssue | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? null
      : issue(path, 'numbers must be finite', value);
  }

  if (typeof value !== 'object') {
    return issue(path, `${typeof value} values are not supported`, value);
  }

  const tag = getStorageBinaryTag(value);
  if (tag === '[object ArrayBuffer]') {
    try {
      new Uint8Array(value as ArrayBuffer);
      return null;
    } catch {
      return issue(path, 'detached binary values are not supported', value);
    }
  }
  if (ArrayBuffer.isView(value)) {
    if (!tag) {
      return issue(path, 'only supported typed-array views are allowed', value);
    }
    const view = getArrayBufferViewInfo(value);
    if (!view) {
      return issue(path, 'detached binary values are not supported', value);
    }
    if (isSharedArrayBufferValue(view.buffer)) {
      return issue(
        path,
        'binary views backed by shared memory are not supported',
        value
      );
    }
    try {
      new Uint8Array(view.buffer as ArrayBuffer);
    } catch {
      return issue(path, 'detached binary values are not supported', value);
    }
    return null;
  }

  if (ancestors.has(value)) {
    return issue(path, 'cyclic references are not supported', value);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const property of Reflect.ownKeys(value)) {
        if (property === 'length') continue;
        if (typeof property === 'symbol') {
          return issue(
            path,
            'symbol-keyed array properties are not supported',
            value
          );
        }
        if (!/^(0|[1-9]\d*)$/.test(property)) {
          return issue(
            propertyPath(path, property),
            'custom array properties are not supported',
            value
          );
        }
      }

      for (let index = 0; index < value.length; index++) {
        const itemPath = `${path}[${index}]`;
        if (!hasOwn.call(value, index)) {
          return issue(itemPath, 'sparse arrays are not supported', value);
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index)
        );
        if (!descriptor || !('value' in descriptor)) {
          return issue(itemPath, 'array accessors are not supported', value);
        }
        const childIssue = findStorageValueIssue(
          descriptor.value,
          itemPath,
          ancestors
        );
        if (childIssue) return childIssue;
      }
      return null;
    }

    if (!hasPlainObjectPrototype(value)) {
      return issue(path, 'only plain objects are supported', value);
    }

    for (const property of Reflect.ownKeys(value)) {
      if (typeof property === 'symbol') {
        return issue(
          path,
          'symbol-keyed object properties are not supported',
          value
        );
      }
      const childPath = propertyPath(path, property);
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (!descriptor?.enumerable) {
        return issue(
          childPath,
          'non-enumerable properties are not supported',
          value
        );
      }
      if (!('value' in descriptor)) {
        return issue(childPath, 'accessor properties are not supported', value);
      }
      const childIssue = findStorageValueIssue(
        descriptor.value,
        childPath,
        ancestors
      );
      if (childIssue) return childIssue;
    }
    return null;
  } finally {
    ancestors.delete(value);
  }
};

export const inspectStorageValue = (
  value: unknown
): StorageValueIssue | null => {
  try {
    return findStorageValueIssue(value, '$', new WeakSet());
  } catch {
    return issue('$', 'the value could not be inspected safely', value);
  }
};

export const validateStorageValueWrite: (
  value: unknown,
  context: StorageValueWriteContext
) => asserts value is StorageValue = (value, context) => {
  const valueIssue =
    inspectStorageValue(value) ??
    (!context.allowReservedPluginEnvelope &&
    hasReservedPluginEnvelopeHeader(value)
      ? issue(
          '$',
          'top-level localspace.plugin envelopes are reserved for internal storage transforms',
          value
        )
      : null);
  if (!valueIssue) return;

  const details = {
    operation: context.operation,
    ...(context.key === undefined ? {} : { key: context.key }),
    valueSource: context.valueSource ?? 'application',
    ...(context.plugin === undefined ? {} : { plugin: context.plugin }),
    valuePath: valueIssue.path,
    valueType: valueIssue.valueType,
    valueReason: valueIssue.reason,
  };
  const message = `Value at ${valueIssue.path} is outside the LocalSpace 3.0 StorageValue contract: ${valueIssue.reason}.`;

  throw createLocalSpaceError('SERIALIZATION_FAILED', message, details);
};

const cloneStorageBinary = (value: StorageBinary): StorageBinary => {
  const tag = getStorageBinaryTag(value);
  const bytes = copyBufferSourceBytes(value);
  if (!tag || !bytes) {
    throw createLocalSpaceError(
      'SERIALIZATION_FAILED',
      'Failed to copy LocalSpace binary value.'
    );
  }

  const buffer = bytes.buffer as ArrayBuffer;
  switch (tag) {
    case '[object ArrayBuffer]':
      return buffer;
    case '[object Int8Array]':
      return new Int8Array(buffer);
    case '[object Uint8Array]':
      return new Uint8Array(buffer);
    case '[object Uint8ClampedArray]':
      return new Uint8ClampedArray(buffer);
    case '[object Int16Array]':
      return new Int16Array(buffer);
    case '[object Uint16Array]':
      return new Uint16Array(buffer);
    case '[object Int32Array]':
      return new Int32Array(buffer);
    case '[object Uint32Array]':
      return new Uint32Array(buffer);
    case '[object Float32Array]':
      return new Float32Array(buffer);
    case '[object Float64Array]':
      return new Float64Array(buffer);
    case '[object BigInt64Array]':
      if (typeof BigInt64Array === 'undefined') break;
      return new BigInt64Array(buffer);
    case '[object BigUint64Array]':
      if (typeof BigUint64Array === 'undefined') break;
      return new BigUint64Array(buffer);
  }

  throw createLocalSpaceError(
    'SERIALIZATION_FAILED',
    `Cannot copy ${tag.slice(8, -1)} in this runtime.`
  );
};

const normalizeValidatedStorageValue = (value: StorageValue): StorageValue => {
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

  if (getStorageBinaryTag(value)) {
    return cloneStorageBinary(value as StorageBinary);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValidatedStorageValue(item));
  }

  const result: Record<string, StorageValue> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: normalizeValidatedStorageValue(descriptor.value as StorageValue),
    });
  }
  return result;
};

/** Validate, detach, and normalize a logical value without changing its shape. */
export const normalizeStorageValue = (value: StorageValue): StorageValue => {
  const valueIssue = inspectStorageValue(value);
  if (valueIssue) {
    throw createLocalSpaceError(
      'SERIALIZATION_FAILED',
      `Cannot normalize LocalSpace StorageValue: value at ${valueIssue.path} ${valueIssue.reason}.`,
      {
        valuePath: valueIssue.path,
        valueType: valueIssue.valueType,
        valueReason: valueIssue.reason,
      }
    );
  }
  return normalizeValidatedStorageValue(value);
};
