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
});
