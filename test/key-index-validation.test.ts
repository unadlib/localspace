import { describe, expect, it } from 'vitest';
import { LocalSpace } from '../src/localspace';

const drivers = [
  'asyncStorage',
  'memoryStorageWrapper',
  'localStorageWrapper',
] as const;

describe('key() index validation', () => {
  for (const driver of drivers) {
    it(`rejects non-integer indexes instead of hanging (${driver})`, async () => {
      const store = new LocalSpace({ name: `key-index-${driver}`, driver });
      await store.setItem('a', 1);
      await store.setItem('b', 2);

      for (const index of [NaN, Infinity, -Infinity, 0.5, 1.5, 2 ** 53]) {
        await expect(store.key(index)).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
          details: { operation: 'key', reason: 'invalid-key-index' },
        });
      }
      await expect(store.key(-1)).resolves.toBeNull();
      await expect(store.key(0)).resolves.toBe('a');
      await expect(store.key(1)).resolves.toBe('b');
      await expect(store.key(2)).resolves.toBeNull();
      await expect(store.key(2 ** 32)).resolves.toBeNull();
      await store.clear();
      await store.close();
    });
  }
});
