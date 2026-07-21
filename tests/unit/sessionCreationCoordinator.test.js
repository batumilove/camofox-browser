import { jest } from '@jest/globals';
import { SessionCreationCoordinator } from '../../lib/session-creation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SessionCreationCoordinator', () => {
  test('does not invoke a factory for a pre-aborted caller', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    const controller = new AbortController();
    const reason = Object.assign(new Error('request expired'), { code: 'tab_admission_operation_timeout' });
    controller.abort(reason);
    const factory = jest.fn();

    await expect(coordinator.getOrCreate('u1', factory, { signal: controller.signal })).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({ inflight: 0, generations: { u1: 0 } });
  });

  test('keeps an invalidated raw factory accounted until it settles and disposes its late value', async () => {
    const raw = deferred();
    const disposeLate = jest.fn(async () => {});
    const coordinator = new SessionCreationCoordinator({
      maxInflight: 2,
      settleTimeoutMs: 50,
      disposeLate,
    });
    const creating = coordinator.getOrCreate('u1', async () => raw.promise);
    await flush();
    expect(coordinator.has('u1')).toBe(true);
    expect(coordinator.snapshot().inflight).toBe(1);

    const reason = Object.assign(new Error('user deleted'), { code: 'session_invalidated' });
    const invalidation = coordinator.invalidate('u1', reason);
    await expect(creating).rejects.toBe(reason);
    expect(coordinator.snapshot().inflight).toBe(1);

    const late = { id: 'late-context' };
    raw.resolve(late);
    await invalidation;
    await flush();
    expect(disposeLate).toHaveBeenCalledWith(late, expect.objectContaining({ key: 'u1' }));
    expect(coordinator.has('u1')).toBe(false);
    expect(coordinator.snapshot().inflight).toBe(0);
  });

  test('escalates after an invalidated factory misses its settlement deadline', async () => {
    jest.useFakeTimers();
    try {
      const onEscalate = jest.fn(async () => {});
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 50,
        onEscalate,
      });
      const raw = deferred();
      const creating = coordinator.getOrCreate('u1', async () => raw.promise);
      creating.catch(() => {});
      await flush();

      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(50);
      await expect(invalidation).resolves.toBe(false);
      expect(onEscalate).toHaveBeenCalledTimes(1);
      expect(coordinator.snapshot().inflight).toBe(1);

      raw.reject(new Error('terminated'));
      await jest.advanceTimersByTimeAsync(0);
      await flush();
      expect(coordinator.snapshot().inflight).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('bounds distinct unresolved factories', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 1, settleTimeoutMs: 50 });
    const raw = deferred();
    const first = coordinator.getOrCreate('u1', async () => raw.promise);
    first.catch(() => {});
    await flush();

    await expect(coordinator.getOrCreate('u2', async () => ({ id: 'must-not-start' })))
      .rejects.toMatchObject({ statusCode: 503, code: 'session_creation_capacity' });

    const reason = new Error('finish');
    raw.reject(reason);
    await expect(first).rejects.toBe(reason);
  });

  test('coalesces callers and exposes an atomic generation assertion', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    const gate = deferred();
    const factory = jest.fn(async ({ assertCurrent }) => {
      await gate.promise;
      assertCurrent();
      return { id: 'session' };
    });
    const first = coordinator.getOrCreate('u1', factory);
    const second = coordinator.getOrCreate('u1', factory);
    gate.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
