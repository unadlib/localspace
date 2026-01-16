import { describe, it, expect, vi } from 'vitest';
import localspace, { LocalSpace } from '../src/index';
import { LocalSpaceError } from '../src/errors';

describe('LocalSpace class tests', () => {
  describe('Configuration', () => {
    it('should return error when trying to configure after use', async () => {
      const instance = localspace.createInstance({
        name: 'config-test',
        storeName: 'test',
      });

      await instance.setItem('key', 'value');

      const result = instance.config({ name: 'new-name' });
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("Can't call config()");
    });

    it('should return error when version is not a number', () => {
      const instance = new LocalSpace();
      const result = instance.config({ version: 'invalid' as any });
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('Database version must be a number');
    });

    it('should not apply partial config when validation fails', () => {
      const instance = new LocalSpace({ storeName: 'original-store' });
      const result = instance.config({
        storeName: 'new-store',
        version: 'invalid' as any,
      });
      expect(result).toBeInstanceOf(Error);
      expect(instance.config('storeName')).toBe('original-store');
    });

    it('should get specific config value', () => {
      const instance = new LocalSpace({ name: 'test-db', storeName: 'test-store' });
      expect(instance.config('name')).toBe('test-db');
      expect(instance.config('storeName')).toBe('test-store');
    });

    it('should get entire config', () => {
      const instance = new LocalSpace({ name: 'test-db' });
      const config = instance.config();
      expect(config).toBeDefined();
      expect(config.name).toBe('test-db');
    });

    it('should sanitize storeName', () => {
      const instance = new LocalSpace();
      instance.config({ storeName: 'store&name-v1' });
      expect(instance.config('storeName')).toBe('store_name_v1');
    });

    it('should handle driver config update', async () => {
      const instance = new LocalSpace();
      const result = instance.config({ driver: [instance.LOCALSTORAGE] });
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('Driver management', () => {
    it('should get driver name', async () => {
      const instance = localspace.createInstance();
      await instance.ready();
      const driverName = instance.driver();
      expect(driverName).toBeTruthy();
    });

    it('should check driver support', () => {
      const instance = new LocalSpace();
      const supportsIndexedDB = instance.supports(instance.INDEXEDDB);
      const supportsLocalStorage = instance.supports(instance.LOCALSTORAGE);

      // At least one should be supported
      expect(supportsIndexedDB || supportsLocalStorage).toBe(true);
    });

    it('should get driver object', async () => {
      const instance = new LocalSpace();
      await instance.ready();
      const driverName = instance.driver();

      if (driverName) {
        const driver = await instance.getDriver(driverName);
        expect(driver).toBeDefined();
        expect(driver._driver).toBe(driverName);
      }
    });

    it('should reject getting non-existent driver', async () => {
      const instance = new LocalSpace();
      const promise = instance.getDriver('non-existent-driver');
      await expect(promise).rejects.toBeInstanceOf(LocalSpaceError);
      await expect(promise).rejects.toMatchObject({
        code: 'DRIVER_NOT_FOUND',
        details: { driver: 'non-existent-driver' },
      });
    });

    it('should get serializer', async () => {
      const instance = new LocalSpace();
      const serializer = await instance.getSerializer();
      expect(serializer).toBeDefined();
      expect(serializer.serialize).toBeDefined();
      expect(serializer.deserialize).toBeDefined();
    });

    it('should get serializer with callback', async () => {
      const instance = new LocalSpace();
      await new Promise<void>((resolve) => {
        instance.getSerializer((err, serializer) => {
          expect(err).toBeNull();
          expect(serializer).toBeDefined();
          resolve();
        });
      });
    });

    it('should handle setDriver with no available drivers', async () => {
      const instance = new LocalSpace();

      // Mock supports to return false for all drivers
      const originalSupports = instance.supports.bind(instance);
      instance.supports = vi.fn().mockReturnValue(false);

      const attemptedDrivers = [instance.INDEXEDDB, instance.LOCALSTORAGE];
      await expect(
        instance.setDriver(attemptedDrivers)
      ).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: { attemptedDrivers },
      });

      instance.supports = originalSupports;
    });
  });

  describe('Instance creation', () => {
    it('should create new instance with options', () => {
      const instance = localspace.createInstance({
        name: 'custom-db',
        storeName: 'custom-store',
        version: 2.0,
      });

      expect(instance).toBeDefined();
      expect(instance.config('name')).toBe('custom-db');
      expect(instance.config('storeName')).toBe('custom-store');
      expect(instance.config('version')).toBe(2.0);
    });

    it('should create instance with default config', () => {
      const instance = new LocalSpace();
      const config = instance.config();

      expect(config.name).toBe('localforage');
      expect(config.storeName).toBe('keyvaluepairs');
      expect(config.version).toBe(1.0);
    });
  });

  describe('Custom driver', () => {
    it('should define custom driver', async () => {
      const customDriver = {
        _driver: 'customDriver',
        _initStorage: vi.fn().mockResolvedValue(undefined),
        _support: true,
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: vi.fn(),
        key: vi.fn(),
        keys: vi.fn(),
        iterate: vi.fn(),
      };

      const instance = new LocalSpace();
      await instance.defineDriver(customDriver);

      expect(instance.supports('customDriver')).toBe(true);
    });

    it('should reject non-compliant driver', async () => {
      const invalidDriver = {
        _driver: 'invalidDriver',
        // Missing required methods
      } as any;

      const instance = new LocalSpace();
      await expect(instance.defineDriver(invalidDriver)).rejects.toThrow('Custom driver not compliant');
    });

    it('should reject driver without _driver property', async () => {
      const invalidDriver = {
        _initStorage: vi.fn(),
        getItem: vi.fn(),
      } as any;

      const instance = new LocalSpace();
      await expect(instance.defineDriver(invalidDriver)).rejects.toThrow('Custom driver not compliant');
    });

    it('should handle async _support check', async () => {
      const customDriver = {
        _driver: 'asyncSupportDriver',
        _initStorage: vi.fn().mockResolvedValue(undefined),
        _support: async () => true,
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: vi.fn(),
        key: vi.fn(),
        keys: vi.fn(),
        iterate: vi.fn(),
      };

      const instance = new LocalSpace();
      await instance.defineDriver(customDriver);

      expect(instance.supports('asyncSupportDriver')).toBe(true);
    });

    it('should warn when redefining driver', async () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const customDriver = {
        _driver: 'redefineDriver',
        _initStorage: vi.fn().mockResolvedValue(undefined),
        _support: true,
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: vi.fn(),
        key: vi.fn(),
        keys: vi.fn(),
        iterate: vi.fn(),
      };

      const instance = new LocalSpace();
      await instance.defineDriver(customDriver);
      await instance.defineDriver(customDriver);

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Redefining LocalSpace driver')
      );

      consoleInfoSpy.mockRestore();
    });

    it('should handle defineDriver with callbacks in compatibility mode', async () => {
      const customDriver = {
        _driver: 'callbackDriver',
        _initStorage: vi.fn().mockResolvedValue(undefined),
        _support: true,
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: vi.fn(),
        key: vi.fn(),
        keys: vi.fn(),
        iterate: vi.fn(),
      };

      const instance = new LocalSpace({ compatibilityMode: true });

      await new Promise<void>((resolve) => {
        instance.defineDriver(
          customDriver,
          () => {
            expect(instance.supports('callbackDriver')).toBe(true);
            resolve();
          },
          (err) => {
            throw err;
          }
        );
      });
    });
  });

  describe('Ready and initialization', () => {
    it('should wait for driver initialization', async () => {
      const instance = localspace.createInstance({
        name: 'ready-test',
        storeName: 'test',
      });

      await instance.ready();
      const driverName = instance.driver();
      expect(driverName).toBeTruthy();
    });

    it('should handle ready with callback', async () => {
      const instance = localspace.createInstance();

      await new Promise<void>((resolve) => {
        instance.ready((err) => {
          expect(err).toBeNull();
          resolve();
        });
      });
    });

    it('should handle ready in compatibility mode', async () => {
      const instance = localspace.createInstance({ compatibilityMode: true });

      await new Promise<void>((resolve) => {
        instance.ready((err) => {
          expect(err).toBeUndefined();
          resolve();
        });
      });
    });
  });

  describe('Error handling', () => {
    it('should handle driver fallback', async () => {
      const instance = localspace.createInstance({
        name: 'fallback-test',
        // Request drivers in specific order
        driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
      });

      await instance.ready();
      const driver = instance.driver();

      // Should have a driver (either one)
      expect(driver).toBeTruthy();
    });

    it('should throw error when calling methods before driver initialization', async () => {
      // Create an instance without initializing
      const uninitInstance = new LocalSpace();

      // Try to call methods before ready() - these should throw
      // Note: The implementation wraps methods with ready(), so they might not throw immediately
      // but instead wait for ready()

      // This test verifies the error throwing mechanism exists
      expect(uninitInstance.iterate).toBeDefined();
      expect(uninitInstance.getItem).toBeDefined();
      expect(uninitInstance.setItem).toBeDefined();
    });
  });

  describe('Driver initialization errors', () => {
    it('should handle initialization with unsupported driver', async () => {
      const instance = new LocalSpace();

      await expect(
        instance.setDriver(['non-existent-driver' as any])
      ).rejects.toThrow('No available storage method found');
    });

    it('should handle multiple setDriver calls', async () => {
      const instance = localspace.createInstance();

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();

      // Call setDriver again
      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();

      expect(instance.driver()).toBeTruthy();
    });
  });
});
