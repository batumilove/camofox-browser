import { jest } from '@jest/globals';
import {
  TabAdmissionController,
  TabCapacityReservations,
  awaitAbortableResource,
  canReapEmptySession,
  closePageWithin,
  coalesceSessionClose,
  replaceSessionAfterProxyFailure,
  reservePendingTabCreation,
  sendTabAdmissionError,
  settleAllConcurrently,
  settleWithin,
  withAbortableResource,
} from '../../lib/tab-admission.js';

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

describe('TabAdmissionController', () => {
  test('snapshot reports pending counts per user without exposing operations', async () => {
    const controller = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxPending: 4,
    });
    const gate = deferred();
    const active = controller.run('user-a', () => gate.promise);
    const queuedA = controller.run('user-a', async () => 'a');
    const queuedB = controller.run('user-b', async () => 'b');
    await flush();

    expect(controller.snapshot().pendingByUser).toEqual({ 'user-a': 1, 'user-b': 1 });

    gate.resolve('done');
    await expect(active).resolves.toBe('done');
    await expect(queuedA).resolves.toBe('a');
    await expect(queuedB).resolves.toBe('b');
  });

  test('snapshot counts pending prototype-named user IDs as ordinary keys', async () => {
    const controller = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxPending: 4,
    });
    const gate = deferred();
    const active = controller.run('active-user', () => gate.promise);
    const queued = ['__proto__', 'constructor', 'toString'].map((user) => (
      controller.run(user, async () => user)
    ));
    await flush();

    const snapshot = controller.snapshot();
    expect(Object.hasOwn(snapshot.pendingByUser, '__proto__')).toBe(true);
    expect(snapshot.pendingByUser.__proto__).toBe(1);
    expect(snapshot.pendingByUser.constructor).toBe(1);
    expect(snapshot.pendingByUser.toString).toBe(1);

    gate.resolve('done');
    await expect(active).resolves.toBe('done');
    await expect(Promise.all(queued)).resolves.toEqual(['__proto__', 'constructor', 'toString']);
  });

  test('enforces the global active limit and starts queued work after release', async () => {
    const controller = new TabAdmissionController({ maxActive: 2, maxActivePerUser: 2, maxPending: 4 });
    const gates = [deferred(), deferred(), deferred()];
    const started = [];

    const runs = gates.map((gate, index) => controller.run(`user-${index}`, async () => {
      started.push(index);
      return gate.promise;
    }));
    await flush();

    expect(started).toEqual([0, 1]);
    expect(controller.snapshot()).toMatchObject({ active: 2, pending: 1 });

    gates[0].resolve('first');
    await expect(runs[0]).resolves.toBe('first');
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve('second');
    gates[2].resolve('third');
    await expect(Promise.all(runs.slice(1))).resolves.toEqual(['second', 'third']);
    expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  test('enforces per-user active limit without head-of-line blocking another user', async () => {
    const controller = new TabAdmissionController({ maxActive: 2, maxActivePerUser: 1, maxPending: 4 });
    const first = deferred();
    const second = deferred();
    const other = deferred();
    const started = [];

    const run1 = controller.run('same-user', async () => { started.push('same-1'); return first.promise; });
    const run2 = controller.run('same-user', async () => { started.push('same-2'); return second.promise; });
    const run3 = controller.run('other-user', async () => { started.push('other'); return other.promise; });
    await flush();

    expect(started).toEqual(['same-1', 'other']);
    first.resolve('one');
    await expect(run1).resolves.toBe('one');
    await flush();
    expect(started).toEqual(['same-1', 'other', 'same-2']);

    second.resolve('two');
    other.resolve('other');
    await expect(Promise.all([run2, run3])).resolves.toEqual(['two', 'other']);
  });

  test('bounds the pending queue and rejects overflow with 429 retry metadata', async () => {
    const controller = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxPending: 2,
      retryAfterSeconds: 7,
    });
    const active = deferred();
    const queued1 = deferred();
    const queued2 = deferred();

    const run1 = controller.run('u1', () => active.promise);
    const run2 = controller.run('u2', () => queued1.promise);
    const run3 = controller.run('u3', () => queued2.promise);
    await flush();

    await expect(controller.run('u4', async () => 'never')).rejects.toMatchObject({
      statusCode: 429,
      code: 'tab_admission_queue_full',
      retryAfter: 7,
    });

    active.resolve('active');
    await run1;
    queued1.resolve('q1');
    await run2;
    queued2.resolve('q2');
    await run3;
  });

  test.each([
    ['success', async () => 'ok'],
    ['error', async () => { throw new Error('boom'); }],
  ])('releases capacity after operation %s', async (_label, operation) => {
    const controller = new TabAdmissionController({ maxActive: 1, maxActivePerUser: 1, maxPending: 1 });
    const first = controller.run('u1', operation);
    const second = controller.run('u2', async () => 'next');

    if (_label === 'success') await expect(first).resolves.toBe('ok');
    else await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('next');
    expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  test('times out active work, aborts it, and releases before late settlement', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 1,
        operationTimeoutMs: 100,
      });
      const late = deferred();
      let signal;
      const first = controller.run('u1', async (operationSignal) => {
        signal = operationSignal;
        return late.promise;
      });
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });
      const second = controller.run('u2', async () => 'next');
      await flush();

      await jest.advanceTimersByTimeAsync(100);
      await firstRejection;
      expect(signal.aborted).toBe(true);
      await expect(second).resolves.toBe('next');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });

      late.resolve('ignored');
      await flush();
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('times out queued work and removes it fairly', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 2,
        waitTimeoutMs: 100,
      });
      const active = deferred();
      const run1 = controller.run('u1', () => active.promise);
      const queued = controller.run('u2', async () => 'never');
      const queuedRejection = expect(queued).rejects.toMatchObject({
        statusCode: 429,
        code: 'tab_admission_wait_timeout',
      });
      await flush();

      await jest.advanceTimersByTimeAsync(100);
      await queuedRejection;
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 0 });

      active.resolve('done');
      await expect(run1).resolves.toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('TabCapacityReservations', () => {
  test('atomically enforces resident global and per-user tab limits', () => {
    let globalTabs = 1;
    const userTabs = new Map([['u1', 1]]);
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => globalTabs,
      getUserCount: (user) => userTabs.get(user) || 0,
      retryAfterSeconds: 3,
    });

    const release = capacity.reserve('u1');
    expect(() => capacity.reserve('u2')).toThrow(expect.objectContaining({
      statusCode: 429,
      code: 'tab_admission_global_limit',
      retryAfter: 3,
    }));
    expect(() => capacity.reserve('u1')).toThrow(expect.objectContaining({
      statusCode: 429,
      code: 'tab_admission_user_limit',
    }));

    release();
    expect(() => capacity.reserve('u2')).not.toThrow();
  });
});

describe('pending tab creation and empty-session reaping', () => {
  test('blocks empty-session reaping until every pending creation settles', () => {
    const session = { tabGroups: new Map() };
    expect(canReapEmptySession(session)).toBe(true);

    const releaseFirst = reservePendingTabCreation(session);
    const releaseSecond = reservePendingTabCreation(session);
    expect(canReapEmptySession(session)).toBe(false);

    releaseFirst();
    releaseFirst();
    expect(canReapEmptySession(session)).toBe(false);

    releaseSecond();
    expect(canReapEmptySession(session)).toBe(true);
    expect(session._pendingTabCreations).toBe(0);
  });

  test('never reaps a session that already contains a tab group', () => {
    const session = { tabGroups: new Map([['group', new Map()]]) };
    expect(canReapEmptySession(session)).toBe(false);
  });
});

describe('sendTabAdmissionError', () => {
  test('writes HTTP 429 JSON and Retry-After for admission overflow', () => {
    const response = {
      headers: {},
      statusCode: null,
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    const error = new Error('queue full');
    Object.assign(error, {
      statusCode: 429,
      code: 'tab_admission_queue_full',
      retryAfter: 5,
    });

    expect(sendTabAdmissionError(response, error, 'safe queue full')).toBe(true);
    expect(response.headers['Retry-After']).toBe('5');
    expect(response.statusCode).toBe(429);
    expect(response.body).toEqual({
      error: 'safe queue full',
      code: 'tab_admission_queue_full',
      retryAfter: 5,
    });
  });
});

describe('awaitAbortableResource', () => {
  test('rejects promptly on abort and cleans a resource that settles later', async () => {
    const resource = deferred();
    const abort = new AbortController();
    const close = jest.fn(async () => {});
    const result = awaitAbortableResource(resource.promise, abort.signal, close);

    abort.abort(new Error('request timed out'));
    const outcome = await Promise.race([
      result.then(() => 'resolved', (error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 50)),
    ]);
    expect(outcome).toBe('request timed out');
    expect(close).not.toHaveBeenCalled();

    resource.resolve({ id: 'late-page' });
    await new Promise(setImmediate);
    expect(close).toHaveBeenCalledWith({ id: 'late-page' });
  });

  test('closes a resource that resolves after its operation was aborted', async () => {
    const resource = deferred();
    const abort = new AbortController();
    const close = jest.fn(async () => {});
    const result = awaitAbortableResource(resource.promise, abort.signal, close);

    abort.abort(new Error('request timed out'));
    resource.resolve({ id: 'late-page' });

    await expect(result).rejects.toThrow('request timed out');
    expect(close).toHaveBeenCalledWith({ id: 'late-page' });
  });

  test('unregisters and closes a managed resource when work is aborted', async () => {
    const abort = new AbortController();
    const work = deferred();
    const registered = new Map();
    const close = jest.fn(async () => {});
    const resource = { id: 'tab-1' };

    const result = withAbortableResource({
      create: async () => resource,
      signal: abort.signal,
      register: async (value) => registered.set(value.id, value),
      unregister: async (value) => registered.delete(value.id),
      cleanup: close,
      operation: async () => work.promise,
    });
    await new Promise(setImmediate);
    expect(registered.has('tab-1')).toBe(true);

    abort.abort(new Error('request timed out'));
    work.reject(new Error('page closed'));

    await expect(result).rejects.toThrow('page closed');
    expect(registered.size).toBe(0);
    expect(close).toHaveBeenCalledWith(resource);
  });
});

describe('bounded timeout cleanup helpers', () => {
  test('starts every session teardown without serially consuming the global shutdown budget', async () => {
    const first = deferred();
    const second = deferred();
    const started = [];
    const work = settleAllConcurrently([
      ['first', first],
      ['second', second],
    ], async ([name, gate]) => {
      started.push(name);
      await gate.promise;
      return name;
    });

    await flush();
    expect(started).toEqual(['first', 'second']);
    first.resolve();
    second.resolve();
    await expect(work).resolves.toEqual([
      expect.objectContaining({ status: 'fulfilled', value: 'first' }),
      expect.objectContaining({ status: 'fulfilled', value: 'second' }),
    ]);
  });

  test('coalesces concurrent teardown of the same session', async () => {
    const session = {};
    const gate = deferred();
    const teardown = jest.fn(() => gate.promise);

    const first = coalesceSessionClose(session, teardown);
    const second = coalesceSessionClose(session, teardown);
    expect(first).toBe(second);
    await flush();
    expect(teardown).toHaveBeenCalledTimes(1);

    gate.resolve('closed');
    await expect(Promise.all([first, second])).resolves.toEqual(['closed', 'closed']);
  });

  test('returns from a hung lifecycle hook at its deadline', async () => {
    jest.useFakeTimers();
    try {
      const result = settleWithin(new Promise(() => {}), 25);
      await jest.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toEqual({ status: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a hung page close is attempted once and returns at the cleanup deadline', async () => {
    jest.useFakeTimers();
    try {
      const page = {
        isClosed: jest.fn(() => false),
        close: jest.fn(() => new Promise(() => {})),
        removeAllListeners: jest.fn(),
      };
      const onFailure = jest.fn();
      const closing = closePageWithin(page, { timeoutMs: 25, onFailure });
      await jest.advanceTimersByTimeAsync(25);
      await expect(closing).resolves.toBe(false);
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(page.removeAllListeners).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('proxy retry closes only the captured failed session, never its replacement', async () => {
    const failedSession = { name: 'A', closed: false };
    const replacementSession = { name: 'B', closed: false };
    const sessions = new Map([['user', replacementSession]]);
    const closeSession = jest.fn(async (key, session) => {
      session.closed = true;
      if (sessions.get(key) === session) sessions.delete(key);
    });
    const getSession = jest.fn(async () => sessions.get('user'));

    const result = await replaceSessionAfterProxyFailure({
      signal: new AbortController().signal,
      userKey: 'user',
      failedSession,
      closeSession,
      getSession,
    });

    expect(result).toBe(replacementSession);
    expect(closeSession).toHaveBeenCalledWith('user', failedSession);
    expect(failedSession.closed).toBe(true);
    expect(replacementSession.closed).toBe(false);
  });

  test('proxy retry cannot rotate after its admission operation is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('timed out');
    controller.abort(reason);
    const closeSession = jest.fn();
    const getSession = jest.fn();

    await expect(replaceSessionAfterProxyFailure({
      signal: controller.signal,
      userKey: 'user',
      failedSession: {},
      closeSession,
      getSession,
    })).rejects.toBe(reason);
    expect(closeSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  test('proxy retry does not obtain a replacement if abort arrives while closing the failed session', async () => {
    const controller = new AbortController();
    const closeGate = deferred();
    const closeSession = jest.fn(() => closeGate.promise);
    const getSession = jest.fn();
    const result = replaceSessionAfterProxyFailure({
      signal: controller.signal,
      userKey: 'user',
      failedSession: {},
      closeSession,
      getSession,
    });

    controller.abort(new Error('timed out during close'));
    closeGate.resolve();
    await expect(result).rejects.toThrow('timed out during close');
    expect(getSession).not.toHaveBeenCalled();
  });
});
