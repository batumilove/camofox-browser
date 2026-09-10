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
  test('does not invoke a factory or retain state for a pre-aborted caller', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    const controller = new AbortController();
    const reason = Object.assign(new Error('request expired'), { code: 'tab_admission_operation_timeout' });
    controller.abort(reason);
    const factory = jest.fn();

    await expect(coordinator.getOrCreate('u1', factory, { signal: controller.signal })).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ inflight: 0, lifecycleKeys: 0, resetting: 0 });
  });

  test('successful creation remains current while settlement bookkeeping finishes', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    let generation;
    const session = await coordinator.getOrCreate('u1', async lifecycle => {
      generation = lifecycle.generation;
      return { id: 'live' };
    });
    expect(session.id).toBe('live');
    expect(coordinator.isCurrent('u1', generation)).toBe(true);
    await flush();
    expect(coordinator.isCurrent('u1', generation)).toBe(true);
  });

  test('absent-user invalidation does not grow high-cardinality lifecycle state', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    for (let index = 0; index < 10000; index++) {
      await coordinator.invalidate(`attacker-${index}`);
    }
    expect(coordinator.snapshot()).toMatchObject({ inflight: 0, lifecycleKeys: 0, resetting: 0 });
  });

  test('keeps an invalidated raw factory accounted until it settles and disposes its late value', async () => {
    const raw = deferred();
    const disposeLate = jest.fn(async () => {});
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50, disposeLate });
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

  test('verified escalation retires capacity while retaining late disposal observation', async () => {
    jest.useFakeTimers();
    try {
      const raw = deferred();
      const disposeLate = jest.fn(async () => {});
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 50,
        disposeLate,
        onEscalate: jest.fn(async () => ({ terminated: true, ownerEpoch: 'browser-1' })),
      });
      const creating = coordinator.getOrCreate('u1', async ({ bindOwner }) => {
        bindOwner('browser-1');
        return raw.promise;
      });
      creating.catch(() => {});
      await flush();

      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(50);
      await expect(invalidation).resolves.toBe(false);
      expect(coordinator.snapshot().inflight).toBe(0);

      const replacement = await coordinator.getOrCreate('u2', async () => ({ id: 'replacement' }));
      expect(replacement.id).toBe('replacement');
      raw.resolve({ id: 'late' });
      await flush();
      expect(disposeLate).toHaveBeenCalledWith(expect.objectContaining({ id: 'late' }), expect.any(Object));
    } finally {
      jest.useRealTimers();
    }
  });

  test('mismatched termination proof retains ownership and self-retries escalation', async () => {
    jest.useFakeTimers();
    try {
      const raw = deferred();
      const onInternalError = jest.fn();
      const onEscalate = jest
        .fn()
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-other' })
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-1' });
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 25,
        onEscalate,
        onInternalError,
      });
      const creating = coordinator.getOrCreate('u1', async ({ bindOwner }) => {
        bindOwner('browser-1');
        return raw.promise;
      });
      creating.catch(() => {});
      await flush();
      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(25);
      await expect(invalidation).resolves.toBe(false);
      expect(coordinator.snapshot().inflight).toBe(1);
      await expect(coordinator.getOrCreate('u2', async () => ({ id: 'must-not-start' })))
        .rejects.toMatchObject({ statusCode: 503, code: 'session_creation_capacity' });
      expect(onInternalError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
        phase: 'escalation_proof_mismatch',
        ownerEpoch: 'browser-1',
        proofOwnerEpoch: 'browser-other',
      }));

      await jest.advanceTimersByTimeAsync(50);
      await flush();
      expect(onEscalate).toHaveBeenCalledTimes(2);
      expect(coordinator.snapshot().inflight).toBe(0);

      raw.reject(new Error('owner finally terminated'));
      await flush();
      await jest.advanceTimersByTimeAsync(0);
      await flush();
      expect(coordinator.snapshot().inflight).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('times out a hanging escalation and self-retries to verified termination', async () => {
    jest.useFakeTimers();
    try {
      const raw = deferred();
      let firstSignal;
      const onEscalate = jest
        .fn()
        .mockImplementationOnce((_entry, _reason, { signal }) => {
          firstSignal = signal;
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        })
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-1' });
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 10,
        escalationTimeoutMs: 10,
        onEscalate,
      });
      const creating = coordinator.getOrCreate('u1', async ({ bindOwner }) => {
        bindOwner('browser-1');
        return raw.promise;
      });
      creating.catch(() => {});
      await flush();

      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(20);
      await expect(invalidation).resolves.toBe(false);
      expect(firstSignal.aborted).toBe(true);
      expect(coordinator.snapshot().inflight).toBe(1);

      await jest.advanceTimersByTimeAsync(20);
      await flush();
      expect(onEscalate).toHaveBeenCalledTimes(2);
      expect(coordinator.snapshot().inflight).toBe(0);

      raw.reject(new Error('late owner settlement'));
      await flush();
    } finally {
      jest.useRealTimers();
    }
  });

  test('retains one permanently hanging escalation without accumulating attempts', async () => {
    jest.useFakeTimers();
    try {
      const raw = deferred();
      const onEscalate = jest.fn(() => new Promise(() => {}));
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 10,
        escalationTimeoutMs: 10,
        onEscalate,
      });
      const creating = coordinator.getOrCreate('u1', async ({ bindOwner }) => {
        bindOwner('browser-1');
        return raw.promise;
      });
      creating.catch(() => {});
      await flush();

      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(20);
      await expect(invalidation).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      await flush();
      expect(onEscalate).toHaveBeenCalledTimes(1);
      expect(coordinator.snapshot().inflight).toBe(1);

      raw.reject(new Error('late owner settlement'));
      await flush();
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejecting escalation is observed and reported without an unhandled rejection', async () => {
    jest.useFakeTimers();
    try {
      const onInternalError = jest.fn();
      const coordinator = new SessionCreationCoordinator({
        maxInflight: 1,
        settleTimeoutMs: 10,
        onEscalate: async () => { throw new Error('teardown failed'); },
        onInternalError,
      });
      const raw = deferred();
      const creating = coordinator.getOrCreate('u1', async () => raw.promise);
      creating.catch(() => {});
      await flush();
      const invalidation = coordinator.invalidate('u1', new Error('cancelled'));
      await jest.advanceTimersByTimeAsync(10);
      await expect(invalidation).resolves.toBe(false);
      expect(onInternalError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ key: 'u1' }));
      raw.reject(new Error('terminated later'));
      await flush();
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

  test('one aborted coalesced waiter does not invalidate another live waiter', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50 });
    const gate = deferred();
    const factory = jest.fn(async () => gate.promise);
    const controller = new AbortController();
    const first = coordinator.getOrCreate('same', factory, { signal: controller.signal });
    const second = coordinator.getOrCreate('same', factory);
    const reason = new Error('caller one disconnected');
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    gate.resolve({ id: 'shared-session' });
    await expect(second).resolves.toEqual({ id: 'shared-session' });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('all aborted waiters invalidate shared creation and dispose a late result', async () => {
    const raw = deferred();
    const disposeLate = jest.fn(async () => {});
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, settleTimeoutMs: 50, disposeLate });
    const one = new AbortController();
    const two = new AbortController();
    const first = coordinator.getOrCreate('same', async () => raw.promise, { signal: one.signal });
    const second = coordinator.getOrCreate('same', async () => raw.promise, { signal: two.signal });
    one.abort(new Error('one gone'));
    two.abort(new Error('two gone'));
    await Promise.allSettled([first, second]);
    raw.resolve({ id: 'late' });
    await flush();
    expect(disposeLate).toHaveBeenCalledTimes(1);
  });

  test('reset is a synchronous publication barrier and removes state after completion', async () => {
    const coordinator = new SessionCreationCoordinator({ maxInflight: 2, maxResetBarriers: 1, settleTimeoutMs: 50 });
    const gate = deferred();
    const reset = coordinator.reset('u1', { whileBlocked: async () => gate.promise });
    await flush();
    await expect(coordinator.getOrCreate('u1', async () => ({ id: 'must-not-start' })))
      .rejects.toMatchObject({ statusCode: 409, code: 'session_reset_in_progress' });
    gate.resolve();
    await reset;
    expect(coordinator.snapshot()).toMatchObject({ inflight: 0, lifecycleKeys: 0, resetting: 0 });
  });

  test('shutdown synchronously blocks new factories and invalidates in-flight creation', async () => {
    const raw = deferred();
    const disposeLate = jest.fn(async () => {});
    const coordinator = new SessionCreationCoordinator({
      maxInflight: 2,
      settleTimeoutMs: 50,
      disposeLate,
    });
    const creating = coordinator.getOrCreate('u1', async () => raw.promise);
    creating.catch(() => {});
    await flush();

    const reason = Object.assign(new Error('server shutdown'), { code: 'server_shutting_down' });
    const shutdown = coordinator.shutdown(reason);

    const factory = jest.fn(async () => ({ id: 'must-not-publish' }));
    await expect(coordinator.getOrCreate('u2', factory)).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();

    const late = { id: 'late-session' };
    raw.resolve(late);
    await expect(creating).rejects.toBe(reason);
    await shutdown;
    expect(disposeLate).toHaveBeenCalledWith(late, expect.objectContaining({ key: 'u1' }));
    expect(coordinator.snapshot()).toMatchObject({ inflight: 0, lifecycleKeys: 0 });
  });
});
