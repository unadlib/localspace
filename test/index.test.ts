import { describe, it, expect, beforeEach, vi } from 'vitest';
import localspace, { LocalSpace } from '../src/index';
import { executeTwoCallbacks } from '../src/utils/helpers';
import type { LocalSpaceInstance } from '../src/types';

describe('localspace localStorage parity checks', () => {
  let instance: LocalSpaceInstance;

  beforeEach(async () => {
    instance = localspace.createInstance({
      name: 'vitest-suite',
      storeName: `spec_${Math.random().toString(36).slice(2)}`,
    });

    await instance.setDriver([instance.LOCALSTORAGE]);
    await instance.ready();
    await instance.clear();
  });

  it('persists values with setItem/getItem', async () => {
    const stored = await instance.setItem('office', 'Initech');
    expect(stored).toBe('Initech');

    const retrieved = await instance.getItem('office');
    expect(retrieved).toBe('Initech');
  });

  it('iterates keys with monotonically increasing iteration numbers', async () => {
    await instance.setItem('officeX', 'InitechX');
    await instance.setItem('officeY', 'InitrodeY');

    const seen: Array<{ key: string; value: string; iteration: number }> = [];
    await instance.iterate((value, key, iterationNumber) => {
      seen.push({ key, value, iteration: iterationNumber });
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ key: 'officeX', value: 'InitechX', iteration: 1 });
    expect(seen[1]).toMatchObject({ key: 'officeY', value: 'InitrodeY', iteration: 2 });
  });
});

describe('localspace config compatibility snapshots', () => {
  it('sanitises storeName', () => {
    const instance = new LocalSpace();
    instance.config({
      name: 'My Cool App',
      storeName: 'my store&name-v1',
    });

    expect(instance.config('storeName')).toBe('my_store_name_v1');
  });

  it('blocks config calls once the instance is in use', async () => {
    const instance = localspace.createInstance({
      name: 'config-lock',
      storeName: 'config_store',
    });

    await instance.setDriver([instance.LOCALSTORAGE]);
    await instance.setItem('foo', 'bar');

    const result = instance.config({ description: 'should fail' });
    expect(result).toBeInstanceOf(Error);
  });
});

describe('compatibility mode toggles callback semantics', () => {
  it('defaults to node-style callbacks when compatibility mode is disabled', async () => {
    const instance = localspace.createInstance({
      name: 'compat-default',
      storeName: `store_${Math.random().toString(36).slice(2)}`,
    });

    const success = vi.fn();
    const failure = vi.fn();

    await instance.setDriver([instance.LOCALSTORAGE], success, failure);

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toBeNull();
    expect(failure).not.toHaveBeenCalled();
  });

  it('invokes legacy success callback signature when compatibility mode is enabled', async () => {
    const instance = localspace.createInstance({
      name: 'compat-legacy',
      storeName: `store_${Math.random().toString(36).slice(2)}`,
      compatibilityMode: true,
    });

    const success = vi.fn();
    const failure = vi.fn();

    await instance.setDriver([instance.LOCALSTORAGE], success, failure);

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0].length).toBe(1);
    expect(failure).not.toHaveBeenCalled();
  });

  it('routes errors to legacy error callback in compatibility mode', async () => {
    const success = vi.fn();
    const failure = vi.fn();

    const handlers: { onCatch?: (error: Error) => void } = {};
    const fakePromise = {
      then: vi.fn().mockImplementation(() => fakePromise),
      catch: vi.fn().mockImplementation((handler: (error: Error) => void) => {
        handlers.onCatch = handler;
        return fakePromise;
      }),
    } as unknown as Promise<void>;

    executeTwoCallbacks(fakePromise, success, failure, { compatibilityMode: true });

    handlers.onCatch?.(new Error('compat failure'));

    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
