import { describe, expect, it } from 'vitest';
import { broadcastNotificationPlugin } from '../examples/broadcast-notification-plugin';

describe('broadcast notification plugin example', () => {
  it('exposes notification hooks without entering the package surface', () => {
    const plugin = broadcastNotificationPlugin();

    expect(plugin.name).toBe('broadcast-notification');
    expect(plugin.onInit).toBeTypeOf('function');
    expect(plugin.onDestroy).toBeTypeOf('function');
    expect(plugin.afterSet).toBeTypeOf('function');
    expect(plugin.afterRemove).toBeTypeOf('function');
  });
});
