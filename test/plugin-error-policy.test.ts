import { describe, it, expect } from 'vitest';
import localspace from '../src/index';
import { LocalSpaceError } from '../src/errors';

const throwingPlugin = {
  name: 'throwing',
  afterGet: () => {
    throw new Error('unexpected');
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
});
