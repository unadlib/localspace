import { describe, it, expect, vi } from 'vitest';

describe('driver initialization ordering', () => {
  it('waits for async driver support before falling back', async () => {
    vi.resetModules();

    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Safari/605.1.15');

    const { LocalSpace } = await import('../src/localspace');

    try {
      const instance = new LocalSpace({
        name: 'safari-driver-race',
        storeName: 'safari_race',
      });

      await instance.ready();
      expect(instance.driver()).toBe(instance.INDEXEDDB);
    } finally {
      userAgentSpy.mockRestore();
      vi.resetModules();
    }
  });
});
