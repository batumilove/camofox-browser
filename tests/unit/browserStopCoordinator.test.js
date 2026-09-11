import { describe, expect, jest, test } from '@jest/globals';
import { BrowserStopCoordinator } from '../../lib/browser-stop-coordinator.js';

describe('browser stop coordinator', () => {
  test('publishes stopping state synchronously and rejects launches until stop settles', async () => {
    const gate = Promise.withResolvers();
    const coordinator = new BrowserStopCoordinator();
    const stoppingError = new Error('browser stopping');

    const stop = coordinator.run(() => gate.promise);
    expect(coordinator.isStopping()).toBe(true);
    expect(() => coordinator.assertLaunchAllowed(() => stoppingError)).toThrow(stoppingError);

    gate.resolve();
    await stop;
    expect(coordinator.isStopping()).toBe(false);
    expect(() => coordinator.assertLaunchAllowed(() => stoppingError)).not.toThrow();
  });

  test('coalesces concurrent stop operations', async () => {
    const gate = Promise.withResolvers();
    const operation = jest.fn(() => gate.promise);
    const coordinator = new BrowserStopCoordinator();

    const first = coordinator.run(operation);
    const second = coordinator.run(operation);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;
  });
});
