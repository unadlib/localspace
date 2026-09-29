import { describe, expect, it } from 'vitest';
import { LocalSpace } from '../src/localspace';

describe('dropInstance option validation', () => {
  for (const plugins of [[], [{ name: 'observer' }]]) {
    it(`validates options ${plugins.length ? 'with' : 'without'} plugins`, async () => {
      const store = new LocalSpace({
        name: 'drop-options',
        driver: 'memoryStorageWrapper',
        plugins,
      });
      await store.setItem('a', 1);

      await expect(
        store.dropInstance({ name: 42 as unknown as string })
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        details: { configKey: 'name' },
      });
      await expect(store.dropInstance({ storeName: '' })).rejects.toMatchObject(
        {
          code: 'INVALID_CONFIG',
          details: { configKey: 'storeName' },
        }
      );
      await expect(store.getItem('a')).resolves.toBe(1);

      await store.dropInstance({ name: 'drop-options' });
      await expect(store.getItem('a')).resolves.toBeNull();
      await store.close();
    });
  }
});
