import { describe, it, expect, beforeEach } from 'vitest';
import localspace from '../src/index';
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
    expect(seen[0]).toMatchObject({
      key: 'officeX',
      value: 'InitechX',
      iteration: 1,
    });
    expect(seen[1]).toMatchObject({
      key: 'officeY',
      value: 'InitrodeY',
      iteration: 2,
    });
  });
});
