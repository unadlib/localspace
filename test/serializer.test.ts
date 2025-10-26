import { describe, it, expect } from 'vitest';
import serializer from '../src/utils/serializer';

describe('serializer round-trip behaviour', () => {
  it('serializes and deserializes plain objects via JSON', async () => {
    const payload = { foo: 'bar', nested: { answer: 42 } };
    const encoded = await serializer.serialize(payload);
    expect(encoded).toBe(JSON.stringify(payload));
    expect(serializer.deserialize(encoded)).toEqual(payload);
  });

  it('handles ArrayBuffer with binary markers', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const encoded = await serializer.serialize(buffer);

    expect(encoded.startsWith('__lfsc__')).toBe(true);

    const decoded = serializer.deserialize(encoded);
    expect(decoded).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(decoded as ArrayBuffer)).toEqual(new Uint8Array(buffer));
  });

  it('supports typed arrays by preserving the underlying data type', async () => {
    const view = new Int16Array([256, -512, 1024]);
    const encoded = await serializer.serialize(view);
    const decoded = serializer.deserialize(encoded);

    expect(decoded).toBeInstanceOf(Int16Array);
    expect(Array.from(decoded as Int16Array)).toEqual(Array.from(view));
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
      expect(Array.from(decoded as Uint8ClampedArray)).toEqual(Array.from(view));
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

    it('throws error for unknown type', () => {
      const invalidData = '__lfsc__:999:invalid';
      expect(() => serializer.deserialize(invalidData)).toThrow('Unknown type');
    });
  });
});
