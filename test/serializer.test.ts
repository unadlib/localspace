import { describe, it, expect, vi } from 'vitest';
import serializer from '../src/utils/serializer';

describe('serializer round-trip behaviour', () => {
  it('does not log the value when serialization fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret: Record<string, unknown> = { token: 'secret-token' };
    secret.self = secret;

    await expect(serializer.serialize(secret)).rejects.toThrow(TypeError);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('serializes and deserializes plain objects via JSON', async () => {
    const payload = { foo: 'bar', nested: { answer: 42 } };
    const encoded = await serializer.serialize(payload);
    expect(encoded).toBe(JSON.stringify(payload));
    expect(serializer.deserialize(encoded)).toEqual(payload);
  });

  it('does not consult a user-controlled Symbol.toStringTag accessor', async () => {
    const tagGetter = vi.fn(() => 'ArrayBuffer');
    const payload = { safe: true };
    Object.defineProperty(payload, Symbol.toStringTag, {
      configurable: true,
      get: tagGetter,
    });

    await expect(serializer.serialize(payload)).resolves.toBe('{"safe":true}');
    expect(tagGetter).not.toHaveBeenCalled();
  });

  it('handles ArrayBuffer with binary markers', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const encoded = await serializer.serialize(buffer);

    expect(encoded.startsWith('__lfsc__')).toBe(true);

    const decoded = serializer.deserialize(encoded);
    expect(decoded).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(decoded as ArrayBuffer)).toEqual(
      new Uint8Array(buffer)
    );
  });

  it('supports typed arrays by preserving the underlying data type', async () => {
    const view = new Int16Array([256, -512, 1024]);
    const encoded = await serializer.serialize(view);
    const decoded = serializer.deserialize(encoded);

    expect(decoded).toBeInstanceOf(Int16Array);
    expect(Array.from(decoded as Int16Array)).toEqual(Array.from(view));
  });

  it('uses the portable codec only when binary is nested', async () => {
    const backing = new Uint8Array([9, 1, 2, 8]);
    const payload = {
      label: 'nested',
      bytes: backing.subarray(1, 3),
      values: [new Int16Array([-2, 3])],
    };

    const encoded = await serializer.serialize(payload);
    const decoded = serializer.deserialize(encoded) as typeof payload;

    expect(encoded.startsWith('__lsv__:1:')).toBe(true);
    expect(decoded.label).toBe('nested');
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.bytes)).toEqual([1, 2]);
    expect(decoded.values[0]).toBeInstanceOf(Int16Array);
    expect(Array.from(decoded.values[0])).toEqual([-2, 3]);
  });

  it('does not reinterpret portable-looking ordinary JSON', async () => {
    const payload = ['b', 'ui08', 'AQI='];
    const encoded = await serializer.serialize(payload);

    expect(encoded).toBe(JSON.stringify(payload));
    expect(serializer.deserialize(encoded)).toEqual(payload);
  });

  it('rejects unknown portable codec versions', () => {
    expect(() => serializer.deserialize('__lsv__:99:["a",[]]')).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );
  });

  it.each([
    '__lsv__:1:["o",[["duplicate",1],["duplicate",2]]]',
    '__lsv__:1:["b","ui08","not-base64"]',
    '__lsv__:1:["b","blob","AQI="]',
    '__lsv__:1:["b","unknown","AQI="]',
    '__lsv__:1:["missing-node"]',
  ])('rejects malformed portable payload %s', (encoded) => {
    expect(() => serializer.deserialize(encoded)).toThrowError(
      expect.objectContaining({ code: 'DESERIALIZATION_FAILED' })
    );
  });

  it('uses intrinsic typed-array slots instead of an overridden type tag', async () => {
    const tagGetter = vi.fn(() => 'Blob');
    const view = new Uint8Array([1, 2, 3]);
    Object.defineProperty(view, Symbol.toStringTag, {
      configurable: true,
      get: tagGetter,
    });

    const encoded = await serializer.serialize(view);
    expect(Array.from(serializer.deserialize(encoded) as Uint8Array)).toEqual([
      1, 2, 3,
    ]);
    expect(tagGetter).not.toHaveBeenCalled();
  });

  const supportsBlobArrayBuffer =
    typeof Blob !== 'undefined' &&
    typeof Blob.prototype.arrayBuffer === 'function';

  (supportsBlobArrayBuffer ? it : it.skip)(
    'serializes blobs with mime type metadata',
    async () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const encoded = await serializer.serialize(blob);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Blob);
      const decodedBlob = decoded as Blob;
      expect(decodedBlob.type).toBe('text/plain');
      expect(await decodedBlob.text()).toBe('hello world');
    }
  );

  it('transforms between base64 strings and buffers', () => {
    const text = 'localspace';
    const buffer = serializer.stringToBuffer(btoa(text));
    const restored = serializer.bufferToString(buffer);
    expect(restored).toBe(btoa(text));
  });

  it('handles Int8Array', async () => {
    const view = new Int8Array([-100, 0, 100]);
    const encoded = await serializer.serialize(view);
    const decoded = serializer.deserialize(encoded);

    expect(decoded).toBeInstanceOf(Int8Array);
    expect(Array.from(decoded as Int8Array)).toEqual(Array.from(view));
  });

  describe('Additional typed array support', () => {
    it('handles Uint8Array', async () => {
      const view = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(view));
    });

    it('handles Uint8ClampedArray', async () => {
      const view = new Uint8ClampedArray([0, 128, 255]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Uint8ClampedArray);
      expect(Array.from(decoded as Uint8ClampedArray)).toEqual(
        Array.from(view)
      );
    });

    it('handles Uint16Array', async () => {
      const view = new Uint16Array([1000, 2000, 3000]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Uint16Array);
      expect(Array.from(decoded as Uint16Array)).toEqual(Array.from(view));
    });

    it('handles Int32Array', async () => {
      const view = new Int32Array([-100, 0, 100]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Int32Array);
      expect(Array.from(decoded as Int32Array)).toEqual(Array.from(view));
    });

    it('handles Uint32Array', async () => {
      const view = new Uint32Array([100, 200, 300]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Uint32Array);
      expect(Array.from(decoded as Uint32Array)).toEqual(Array.from(view));
    });

    it('handles Float32Array', async () => {
      const view = new Float32Array([1.5, 2.5, 3.5]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Float32Array);
      expect(Array.from(decoded as Float32Array)).toEqual(Array.from(view));
    });

    it('handles Float64Array', async () => {
      const view = new Float64Array([1.123456789, 2.987654321]);
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Float64Array);
      expect(Array.from(decoded as Float64Array)).toEqual(Array.from(view));
    });

    it('preserves view slices (byteOffset/byteLength)', async () => {
      const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
      const view = new Uint8Array(backing.buffer, 2, 4); // [1,2,3,4], not the whole buffer
      const encoded = await serializer.serialize(view);
      const decoded = serializer.deserialize(encoded);

      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(view));
    });

    (typeof BigInt64Array === 'function' ? it : it.skip)(
      'handles BigInt64Array',
      async () => {
        const view = new BigInt64Array([1n, -2n, 3n]);
        const encoded = await serializer.serialize(view);
        const decoded = serializer.deserialize(encoded);

        expect(decoded).toBeInstanceOf(BigInt64Array);
        expect(Array.from(decoded as BigInt64Array)).toEqual(Array.from(view));
      }
    );

    (typeof BigUint64Array === 'function' ? it : it.skip)(
      'handles BigUint64Array',
      async () => {
        const view = new BigUint64Array([0n, 4n, 8n]);
        const encoded = await serializer.serialize(view);
        const decoded = serializer.deserialize(encoded);

        expect(decoded).toBeInstanceOf(BigUint64Array);
        expect(Array.from(decoded as BigUint64Array)).toEqual(Array.from(view));
      }
    );

    it('throws error for unknown type', () => {
      const invalidData = '__lfsc__:999:invalid';
      expect(() => serializer.deserialize(invalidData)).toThrow('Unknown type');
    });
  });
});
