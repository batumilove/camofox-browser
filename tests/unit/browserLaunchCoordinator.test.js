import { jest } from '@jest/globals';
import { BrowserLaunchCoordinator } from '../../lib/browser-launch-coordinator.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function candidate(name) {
  return {
    browser: { name, close: jest.fn(async () => {}) },
    virtualDisplay: { name: `${name}-display`, kill: jest.fn() },
    proxy: { server: `${name}-proxy` },
    pid: name === 'new' ? 202 : 101,
    display: `:${name}`,
  };
}

function harness(launch, timeoutMs = 100) {
  const state = {
    browser: null,
    virtualDisplay: null,
    proxy: null,
    pid: null,
    launched: [],
  };
  const discard = jest.fn(async (stale) => {
    await stale.browser.close();
    stale.virtualDisplay?.kill();
  });
  const publish = jest.fn(async (ready) => {
    state.browser = ready.browser;
    state.virtualDisplay = ready.virtualDisplay;
    state.proxy = ready.proxy;
    state.pid = ready.pid;
    state.launched.push({ browser: ready.browser, display: ready.display });
    return ready.browser;
  });
  const coordinator = new BrowserLaunchCoordinator({
    launch,
    publish,
    discard,
    timeoutMs: () => timeoutMs,
    timeoutError: (ms) => new Error(`Browser launch timeout (${Math.round(ms / 1000)}s)`),
  });
  return { coordinator, state, discard, publish };
}

describe('BrowserLaunchCoordinator', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('shares one in-flight launch and publishes a normal success once', async () => {
    const pending = deferred();
    const launch = jest.fn(() => pending.promise);
    const { coordinator, state, publish, discard } = harness(launch);

    const first = coordinator.ensure();
    const second = coordinator.ensure();
    expect(second).toBe(first);
    expect(launch).toHaveBeenCalledTimes(1);

    const ready = candidate('new');
    pending.resolve(ready);

    await expect(Promise.all([first, second])).resolves.toEqual([ready.browser, ready.browser]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      browser: ready.browser,
      virtualDisplay: ready.virtualDisplay,
      proxy: ready.proxy,
      pid: ready.pid,
      launched: [{ browser: ready.browser, display: ready.display }],
    });
    expect(coordinator.inFlight).toBe(false);
  });

  test('timed-out late launch never publishes state or launched and cleans its owned candidate once', async () => {
    jest.useFakeTimers();
    const pending = deferred();
    const { coordinator, state, publish, discard } = harness(() => pending.promise);
    const ready = candidate('old');

    const launch = coordinator.ensure();
    const rejection = expect(launch).rejects.toThrow('Browser launch timeout (0s)');
    await jest.advanceTimersByTimeAsync(100);
    await rejection;

    expect(state).toEqual({ browser: null, virtualDisplay: null, proxy: null, pid: null, launched: [] });
    expect(publish).not.toHaveBeenCalled();
    expect(coordinator.inFlight).toBe(false);

    pending.resolve(ready);
    await flush();

    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(ready, expect.objectContaining({ generation: 1 }));
    expect(ready.browser.close).toHaveBeenCalledTimes(1);
    expect(ready.virtualDisplay.kill).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ browser: null, virtualDisplay: null, proxy: null, pid: null, launched: [] });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('newer success cannot be overwritten by an older late completion', async () => {
    jest.useFakeTimers();
    const oldPending = deferred();
    const newPending = deferred();
    const launch = jest.fn()
      .mockImplementationOnce(() => oldPending.promise)
      .mockImplementationOnce(() => newPending.promise);
    const { coordinator, state, publish, discard } = harness(launch);
    const oldCandidate = candidate('old');
    const newCandidate = candidate('new');

    const oldLaunch = coordinator.ensure();
    const oldRejection = expect(oldLaunch).rejects.toThrow('Browser launch timeout');
    await jest.advanceTimersByTimeAsync(100);
    await oldRejection;

    const newLaunch = coordinator.ensure();
    newPending.resolve(newCandidate);
    await expect(newLaunch).resolves.toBe(newCandidate.browser);
    expect(state.browser).toBe(newCandidate.browser);
    expect(state.virtualDisplay).toBe(newCandidate.virtualDisplay);
    expect(state.proxy).toBe(newCandidate.proxy);
    expect(state.pid).toBe(newCandidate.pid);

    oldPending.resolve(oldCandidate);
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(oldCandidate.browser.close).toHaveBeenCalledTimes(1);
    expect(oldCandidate.virtualDisplay.kill).toHaveBeenCalledTimes(1);
    expect(newCandidate.browser.close).not.toHaveBeenCalled();
    expect(newCandidate.virtualDisplay.kill).not.toHaveBeenCalled();
    expect(state.browser).toBe(newCandidate.browser);
    expect(state.launched).toEqual([{ browser: newCandidate.browser, display: newCandidate.display }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('late rejection after timeout is observed without leaking timers or listeners', async () => {
    jest.useFakeTimers();
    const pending = deferred();
    const { coordinator } = harness(() => pending.promise);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const launch = coordinator.ensure();
      const rejection = expect(launch).rejects.toThrow('Browser launch timeout');
      await jest.advanceTimersByTimeAsync(100);
      await rejection;

      pending.reject(new Error('late launch failure'));
      await flush();

      expect(unhandled).toEqual([]);
      expect(coordinator.inFlight).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
