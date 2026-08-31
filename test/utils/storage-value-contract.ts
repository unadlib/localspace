import { expect } from 'vitest';
import type { StorageBinary, StorageValue } from '../../src/types';

interface BinaryExpectation {
  readonly constructorName: string;
  readonly values: readonly (number | bigint)[];
}

export interface StorageValueContractFixture {
  readonly value: StorageValue;
  readonly binaries: readonly BinaryExpectation[];
}

export function createStorageValueContractFixture(): StorageValueContractFixture {
  const binaries: StorageBinary[] = [];
  const expectations: BinaryExpectation[] = [];
  const add = (
    value: StorageBinary,
    values: readonly (number | bigint)[]
  ): void => {
    binaries.push(value);
    expectations.push({ constructorName: value.constructor.name, values });
  };

  const arrayBuffer = new Uint8Array([0, 1, 254, 255]).buffer;
  add(arrayBuffer, [0, 1, 254, 255]);
  add(new Int8Array([-128, -1, 0, 127]), [-128, -1, 0, 127]);

  const slicedBytes = new Uint8Array([9, 1, 2, 8]);
  add(slicedBytes.subarray(1, 3), [1, 2]);
  add(new Uint8ClampedArray([-1, 2, 260]), [0, 2, 255]);
  add(new Int16Array([-32_768, -2, 32_767]), [-32_768, -2, 32_767]);
  add(new Uint16Array([0, 65_535]), [0, 65_535]);
  add(
    new Int32Array([-2_147_483_648, 2_147_483_647]),
    [-2_147_483_648, 2_147_483_647]
  );
  add(new Uint32Array([0, 4_294_967_295]), [0, 4_294_967_295]);
  add(new Float32Array([1.5, -2.25]), [1.5, -2.25]);
  add(new Float64Array([Math.PI, -Number.MIN_VALUE]), [
    Math.PI,
    -Number.MIN_VALUE,
  ]);
  if (typeof BigInt64Array !== 'undefined') {
    add(new BigInt64Array([-1n, 2n]), [-1n, 2n]);
  }
  if (typeof BigUint64Array !== 'undefined') {
    add(new BigUint64Array([0n, 2n ** 64n - 1n]), [0n, 2n ** 64n - 1n]);
  }

  return {
    value: {
      primitives: [null, false, true, -0, 1.25, 'text'],
      nested: [{ z: 'last', a: 1 }, ['x', false]],
      binaries,
    },
    binaries: expectations,
  };
}

export function expectStorageValueContract(
  actual: StorageValue | null,
  fixture: StorageValueContractFixture
): void {
  expect(actual).not.toBeNull();
  const record = actual as Record<string, StorageValue>;
  expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  expect(Object.keys(record)).toEqual(['primitives', 'nested', 'binaries']);

  expect(record.primitives).toEqual([null, false, true, 0, 1.25, 'text']);
  expect(Object.is((record.primitives as StorageValue[])[3], -0)).toBe(false);
  expect(record.nested).toEqual([{ z: 'last', a: 1 }, ['x', false]]);
  expect(Object.keys((record.nested as StorageValue[])[0] as object)).toEqual([
    'z',
    'a',
  ]);

  const binaries = record.binaries as StorageBinary[];
  expect(binaries).toHaveLength(fixture.binaries.length);
  for (const [index, expected] of fixture.binaries.entries()) {
    const binary = binaries[index];
    const binaryTag = Object.prototype.toString.call(binary);
    expect(binaryTag).toBe(`[object ${expected.constructorName}]`);
    const values =
      binaryTag === '[object ArrayBuffer]'
        ? Array.from(new Uint8Array(binary))
        : Array.from(binary as ArrayLike<number | bigint>);
    expect(values).toEqual(expected.values);
  }
}
