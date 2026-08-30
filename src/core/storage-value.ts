import { createLocalSpaceError } from '../errors.js';
import type { StorageValue } from '../types.js';

const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!;

const SUPPORTED_BINARY_TAGS = new Set([
  '[object ArrayBuffer]',
  '[object Int8Array]',
  '[object Uint8Array]',
  '[object Uint8ClampedArray]',
  '[object Int16Array]',
  '[object Uint16Array]',
  '[object Int32Array]',
  '[object Uint32Array]',
  '[object Float32Array]',
  '[object Float64Array]',
  '[object BigInt64Array]',
  '[object BigUint64Array]',
]);

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
};

const propertyPath = (parent: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;

const describeType = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  try {
    return objectToString.call(value).slice(8, -1);
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

const hasPlainObjectPrototype = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor'
  );
  return (
    Object.getPrototypeOf(prototype) === null &&
    !!constructorDescriptor &&
    'value' in constructorDescriptor &&
    typeof constructorDescriptor.value === 'function' &&
    constructorDescriptor.value.name === 'Object'
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

  const tag = objectToString.call(value);
  if (tag === '[object ArrayBuffer]') {
    try {
      const byteLength = arrayBufferByteLength.call(value) as number;
      if (typeof byteLength !== 'number') {
        return issue(path, 'binary values must expose a byteLength', value);
      }
      new Uint8Array(value as ArrayBuffer);
      return null;
    } catch {
      return issue(path, 'detached binary values are not supported', value);
    }
  }
  if (ArrayBuffer.isView(value)) {
    if (!SUPPORTED_BINARY_TAGS.has(tag) || tag === '[object ArrayBuffer]') {
      return issue(path, 'only supported typed-array views are allowed', value);
    }
    const backingBuffer = value.buffer;
    if (objectToString.call(backingBuffer) === '[object SharedArrayBuffer]') {
      return issue(
        path,
        'binary views backed by shared memory are not supported',
        value
      );
    }
    try {
      arrayBufferByteLength.call(backingBuffer);
      new Uint8Array(backingBuffer as ArrayBuffer);
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
  const valueIssue = inspectStorageValue(value);
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
