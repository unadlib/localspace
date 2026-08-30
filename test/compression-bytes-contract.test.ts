import { describe, expect, it, vi } from 'vitest';
import localspace, { compressionPlugin, type CompressionCodec } from '../src';
import {
  createPluginEnvelope,
  readPluginEnvelope,
} from '../src/core/plugin-envelope';
import { readStoredRecord } from '../src/core/stored-record';
import { getRawMemoryValue, setRawMemoryValue } from './utils/raw-memory';

const uniqueName = (label: string) =>
  `${label}-${Math.random().toString(36).slice(2)}`;

const createStore = async (
  label: string,
  codec?: CompressionCodec,
  algorithm?: string
) => {
  const options = { name: uniqueName(label), storeName: 'store' };
  const store = localspace.createInstance({
    ...options,
    plugins: [compressionPlugin({ threshold: 0, codec, algorithm })],
  });
  await store.setDriver([store.MEMORY]);
  return { store, options };
};

describe('compression bytes contract', () => {
  it('passes bytes to custom codecs and writes the frozen V1 envelope', async () => {
    let sourceBytes: Uint8Array | undefined;
    const compress = vi.fn((data: Uint8Array) => {
      sourceBytes = data.slice();
      return new Uint8Array([42]);
    });
    const decompress = vi.fn((data: Uint8Array) => {
      expect([...data]).toEqual([42]);
      return sourceBytes!.slice();
    });
    const { store, options } = await createStore(
      'compression-byte-codec',
      { compress, decompress },
      'test-byte-codec-v1'
    );
    const value = { text: 'x'.repeat(4_000) };

    await store.setItem('value', value);
    const physical = await getRawMemoryValue(options, 'value');
    const parsed = readPluginEnvelope<{
      algorithm: string;
      data: string;
      originalSize: number;
    }>(physical, 'compression');

    expect(parsed.matched).toBe(true);
    if (!parsed.matched) {
      throw new Error('Compression envelope missing');
    }
    expect(parsed.payload).toMatchObject({
      algorithm: 'test-byte-codec-v1',
      data: 'Kg==',
      originalSize: sourceBytes?.byteLength,
    });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(Object.prototype.toString.call(compress.mock.calls[0]?.[0])).toBe(
      '[object Uint8Array]'
    );
    await expect(store.getItem('value')).resolves.toEqual(value);
    expect(decompress).toHaveBeenCalledTimes(1);
  });

  it('keeps the StoredRecord when envelope overhead erases byte savings', async () => {
    let sourceBytes: Uint8Array | undefined;
    const decompress = vi.fn(() => sourceBytes!.slice());
    const codec: CompressionCodec = {
      compress: (data) => {
        sourceBytes = data.slice();
        return new Uint8Array(0);
      },
      decompress,
    };
    const { store, options } = await createStore(
      'compression-net-size',
      codec,
      'tiny'
    );

    await store.setItem('value', 0);

    const physical = await getRawMemoryValue(options, 'value');
    expect(readPluginEnvelope(physical, 'compression')).toEqual({
      matched: false,
    });
    expect(readStoredRecord(physical)).toEqual({ matched: true, value: 0 });
    await expect(store.getItem('value')).resolves.toBe(0);
    expect(decompress).not.toHaveBeenCalled();
  });

  it('rejects non-byte codec output before storage side effects', async () => {
    const codec = {
      compress: () => 'not-bytes',
      decompress: (data: Uint8Array) => data,
    } as unknown as CompressionCodec;
    const { store, options } = await createStore(
      'compression-invalid-codec-output',
      codec,
      'invalid-output'
    );

    await expect(
      store.setItem('value', 'x'.repeat(2_000))
    ).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'Failed to compress payload',
    });
    await expect(getRawMemoryValue(options, 'value')).resolves.toBeNull();
  });

  it('consumes algorithm and originalSize metadata on every versioned read', async () => {
    const { store, options } = await createStore('compression-metadata');
    const value = { text: 'x'.repeat(2_000) };
    await store.setItem('seed', value);
    const parsed = readPluginEnvelope<{
      algorithm: string;
      data: string;
      originalSize: number;
    }>(await getRawMemoryValue(options, 'seed'), 'compression');
    if (!parsed.matched) {
      throw new Error('Compression envelope missing');
    }

    const wrongAlgorithm = createPluginEnvelope('compression', {
      ...parsed.payload,
      algorithm: 'different-codec',
    });
    await setRawMemoryValue(options, 'wrong-algorithm', wrongAlgorithm);
    await expect(store.getItem('wrong-algorithm')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
      details: { reason: 'algorithm-mismatch' },
    });

    const wrongSize = createPluginEnvelope('compression', {
      ...parsed.payload,
      originalSize: parsed.payload.originalSize + 1,
    });
    await setRawMemoryValue(options, 'wrong-size', wrongSize);
    await expect(store.getItem('wrong-size')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
      details: { reason: 'original-size-mismatch' },
    });

    const invalidData = createPluginEnvelope('compression', {
      ...parsed.payload,
      data: 'not-base64',
    });
    await setRawMemoryValue(options, 'invalid-data', invalidData);
    await expect(store.getItem('invalid-data')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
      details: { reason: 'invalid-data' },
    });
  });

  it('rejects invalid compression configuration synchronously', () => {
    expect(() => compressionPlugin({ threshold: -1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' })
    );
    expect(() => compressionPlugin({ threshold: 0.5 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' })
    );
    expect(() => compressionPlugin({ algorithm: '' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' })
    );
    expect(() =>
      compressionPlugin({ codec: {} as CompressionCodec })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
