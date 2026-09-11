import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { BrowserStopCoordinator } from '../../lib/browser-stop-coordinator.js';

const serverSource = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

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

  test('admin stop cancels pending and already-fired background warm retries', () => {
    const warmRetrySource = serverSource.match(/function scheduleBrowserWarmRetry[\s\S]*?\n}/)?.[0] ?? '';
    const closeWrapper = serverSource.match(/async function closeBrowserFully[\s\S]*?\n}/)?.[0] ?? '';
    const startRoute = serverSource.match(/app\.post\('\/start'[\s\S]*?\n}\);/)?.[0] ?? '';
    const stopRoute = serverSource.match(/app\.post\('\/stop'[\s\S]*?\n}\);/)?.[0] ?? '';
    expect(serverSource).toMatch(/function clearBrowserWarmRetry\(\)/);
    expect(warmRetrySource.match(/shouldSuppressBrowserWarmRetry/g)).toHaveLength(3);
    expect(warmRetrySource).toMatch(/const retryGeneration = browserLaunchGeneration[\s\S]*?currentGeneration: browserLaunchGeneration[\s\S]*?scheduleBrowserWarmRetry/);
    expect(closeWrapper).toMatch(/_lastBrowserStopReason = nextBrowserStopReason[\s\S]*?if \(_browserClosePromise\) return _browserClosePromise;/);
    expect(startRoute).toMatch(/await ensureBrowser\(\);[\s\S]*?_lastBrowserStopReason = null;/);
    expect(stopRoute).toMatch(/browserStopCoordinator\.run[\s\S]*?clearBrowserWarmRetry\(\)[\s\S]*?invalidateBrowserLaunch\(\)/);
  });
});
