import { describe, it, expect } from 'vitest';
import localspace from '../src/index';
import { LocalSpaceError } from '../src/errors';

const throwingPlugin = {
  name: 'throwing',
  afterGet: () => {
    throw new Error('unexpected');
  },
};

const batchThrowingPlugin = {
  name: 'batch-throwing',
  afterSetItems: () => {
    throw new Error('batch-set boom');
  },
  afterGetItems: () => {
    throw new Error('batch-get boom');
  },
};

describe('pluginErrorPolicy', () => {
  it('lenient policy swallows non-LocalSpaceError plugin failures', async () => {
    const store = localspace.createInstance({
      name: 'policy-lenient',
      storeName: 'store',
      plugins: [throwingPlugin],
      pluginErrorPolicy: 'lenient',
    });

    await store.setDriver([store.LOCALSTORAGE]);
    await store.ready();
    await store.setItem('k', 'v');

    await expect(store.getItem('k')).resolves.toBe('v');
  });

  it('strict policy propagates plugin failures', async () => {
    const store = localspace.createInstance({
      name: 'policy-strict',
      storeName: 'store',
      plugins: [throwingPlugin],
      pluginErrorPolicy: 'strict',
    });

    await store.setDriver([store.LOCALSTORAGE]);
    await store.ready();
    await store.setItem('k', 'v');

    await expect(store.getItem('k')).rejects.toBeInstanceOf(Error);
    await expect(store.getItem('k')).rejects.not.toBeInstanceOf(
      LocalSpaceError
    );
  });

  it('lenient policy swallows batch hook failures', async () => {
    const store = localspace.createInstance({
      name: 'policy-lenient-batch',
      storeName: 'store',
      plugins: [batchThrowingPlugin],
      pluginErrorPolicy: 'lenient',
    });

    await store.setDriver([store.LOCALSTORAGE]);
    await store.ready();

    const entries = [
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
    ];

    await expect(store.setItems(entries)).resolves.toHaveLength(2);
    const got = await store.getItems(entries.map((e) => e.key));
    expect(got.map((r) => r.value)).toEqual(['v1', 'v2']);
  });

  it('strict policy propagates batch hook failures', async () => {
    const store = localspace.createInstance({
      name: 'policy-strict-batch',
      storeName: 'store',
      plugins: [batchThrowingPlugin],
      pluginErrorPolicy: 'strict',
    });

    await store.setDriver([store.LOCALSTORAGE]);
    await store.ready();

    await expect(
      store.setItems([
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ])
    ).rejects.toBeInstanceOf(Error);
  });
});
