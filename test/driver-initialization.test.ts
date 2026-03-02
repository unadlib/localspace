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

  it('waits for async driver support in manual setDriver calls', async () => {
    vi.resetModules();

    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Safari/605.1.15');

    const { LocalSpace } = await import('../src/localspace');

    try {
      const instance = new LocalSpace({
        name: 'manual-setdriver-race',
        storeName: 'manual_race',
      });

      // Critical: immediately call setDriver without waiting for ready()
      // This should still work because setDriver now waits for driver initialization
      await instance.setDriver([instance.INDEXEDDB]);

      // Should have successfully selected IndexedDB
      expect(instance.driver()).toBe(instance.INDEXEDDB);

      // Verify it actually works
      await instance.setItem('test-key', 'test-value');
      const value = await instance.getItem('test-key');
      expect(value).toBe('test-value');
    } finally {
      userAgentSpy.mockRestore();
      vi.resetModules();
    }
  });

  it('manual setDriver rejects when no drivers are supported', async () => {
    vi.resetModules();

    const { LocalSpace } = await import('../src/localspace');

    try {
      const instance = new LocalSpace({
        name: 'no-driver-test',
        storeName: 'no_driver',
      });

      // Try to set a non-existent driver
      await expect(
        instance.setDriver(['nonExistentDriver'] as any)
      ).rejects.toThrow('No available storage method found');
    } finally {
      vi.resetModules();
    }
  });

  it('does not redefine default drivers when creating instances before singleton ready', async () => {
    vi.resetModules();

    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Safari/605.1.15');
    const consoleInfoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation(() => {});

    try {
      const { default: localspace } = await import('../src/index');

      const instances = Array.from({ length: 4 }, (_, index) =>
        localspace.createInstance({
          name: `singleton-race-${index}`,
          storeName: `singleton_race_${index}`,
        })
      );

      await Promise.all(instances.map((instance) => instance.ready()));

      const redefineCalls = consoleInfoSpy.mock.calls.filter(([message]) =>
        typeof message === 'string' &&
        message.includes('Redefining LocalSpace driver')
      );
      expect(redefineCalls).toHaveLength(0);
    } finally {
      consoleInfoSpy.mockRestore();
      userAgentSpy.mockRestore();
      vi.resetModules();
    }
  });
});
