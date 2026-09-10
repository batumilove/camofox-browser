import { jest } from '@jest/globals';
import {
  OrphanPageCleanup,
  RawCreationRegistry,
  TabAdmissionController,
  TabCapacityReservations,
  abortPendingTabCreations,
  awaitAbortableResource,
  canReapEmptySession,
  closeContextWithin,
  closePageWithin,
  deleteSessionMappingIfCurrent,
  hasPendingTabCreations,
  popupOwnerIsCurrent,
  reservePendingTabCreation,
  scheduleSiblingSessionCleanup,
  sendTabAdmissionError,
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

  test('times out active work, aborts it, and releases only after late settlement', async () => {
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
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 1 });

      late.resolve('ignored');
      await flush();
      await expect(second).resolves.toBe('next');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('releases an admission slot after abort grace even if work never acknowledges abort', async () => {
    jest.useFakeTimers();
    const stuck = deferred();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 1,
        operationTimeoutMs: 100,
        abortGraceMs: 50,
      });
      const first = controller.run('u1', () => stuck.promise);
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });
      const second = controller.run('u2', async () => 'next');
      await flush();

      await jest.advanceTimersByTimeAsync(100);
      await firstRejection;
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 1 });

      await jest.advanceTimersByTimeAsync(50);
      await expect(second).resolves.toBe('next');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      stuck.resolve('late');
      await flush();
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

  test('removes an externally aborted queued request immediately', async () => {
    const controller = new TabAdmissionController({ maxActive: 1, maxActivePerUser: 1, maxPending: 2 });
    const active = deferred();
    const first = controller.run('u1', () => active.promise);
    const request = new AbortController();
    const queued = controller.run('u2', async () => 'never', { signal: request.signal });
    await flush();
    const reason = Object.assign(new Error('client disconnected'), { code: 'request_disconnected' });
    request.abort(reason);
    await expect(queued).rejects.toBe(reason);
    expect(controller.snapshot()).toMatchObject({ active: 1, pending: 0 });
    active.resolve('done');
    await first;
  });

  test('aborts active work when the external request disconnects', async () => {
    const controller = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxPending: 1,
      abortGraceMs: 0,
    });
    const request = new AbortController();
    let operationSignal;
    const running = controller.run('u1', async signal => {
      operationSignal = signal;
      await new Promise(() => {});
    }, { signal: request.signal });
    await flush();
    const reason = Object.assign(new Error('client disconnected'), { code: 'request_disconnected' });
    request.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(operationSignal.aborted).toBe(true);
    expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });
});

describe('RawCreationRegistry', () => {
  test('bounds unresolved raw work globally and per user until explicit settlement', () => {
    const registry = new RawCreationRegistry({ maxOutstanding: 2, maxPerUser: 1, retryAfterSeconds: 2 });
    const first = registry.acquire({ userKey: 'u1', kind: 'page', deadlineMs: 1000 });
    expect(registry.snapshot()).toMatchObject({ outstanding: 1, byKind: { page: 1 } });
    expect(() => registry.acquire({ userKey: 'u1', kind: 'page', deadlineMs: 1000 }))
      .toThrow(expect.objectContaining({ code: 'tab_admission_raw_creation_limit', statusCode: 429 }));
    const second = registry.acquire({ userKey: 'u2', kind: 'context', deadlineMs: 1000 });
    expect(() => registry.acquire({ userKey: 'u3', kind: 'page', deadlineMs: 1000 }))
      .toThrow(expect.objectContaining({ code: 'tab_admission_raw_creation_limit' }));
    first.settle();
    second.settle();
    expect(registry.snapshot().outstanding).toBe(0);
  });

  test('deadline escalates once but retains ownership until settlement', async () => {
    jest.useFakeTimers();
    try {
      const onDeadline = jest.fn(async () => {});
      const registry = new RawCreationRegistry({ maxOutstanding: 1, maxPerUser: 1, onDeadline });
      const lease = registry.acquire({ userKey: 'u1', kind: 'page', deadlineMs: 50, owner: { id: 's1' } });
      await jest.advanceTimersByTimeAsync(50);
      expect(onDeadline).toHaveBeenCalledTimes(1);
      expect(registry.snapshot().outstanding).toBe(1);
      expect(() => registry.acquire({ userKey: 'u2', kind: 'page', deadlineMs: 50 }))
        .toThrow(expect.objectContaining({ code: 'tab_admission_raw_creation_limit' }));
      lease.settle();
      expect(registry.snapshot().outstanding).toBe(0);
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

  test('atomically reserves distinct recycle victims for concurrent creates at the limit', () => {
    const victims = Array.from({ length: 9 }, (_, index) => ({ id: `tab-${index}` }));
    const capacity = new TabCapacityReservations({
      maxGlobal: 10,
      maxPerUser: 10,
      getGlobalCount: () => 9,
      getUserCount: () => 9,
    });
    const selectVictim = reserved => victims.find(victim => !reserved.has(victim));

    const growth = capacity.reserve('u1', { selectVictim });
    const replacement1 = capacity.reserve('u1', { selectVictim });
    const replacement2 = capacity.reserve('u1', { selectVictim });

    expect(growth.victim).toBeNull();
    expect(replacement1.victim).toBe(victims[0]);
    expect(replacement2.victim).toBe(victims[1]);

    growth();
    replacement1();
    replacement2();
  });

  test('transfers pending capacity to a resident page without double-counting', () => {
    let resident = 0;
    const victim = { id: 'existing' };
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => resident,
      getUserCount: () => resident,
    });
    const selectVictim = reserved => reserved.has(victim) ? null : victim;

    const first = capacity.reserve('u1', { selectVictim });
    resident = 1;
    first.markCreated();

    const second = capacity.reserve('u1', { selectVictim });
    expect(second.victim).toBeNull();
    resident = 2;
    second.markCreated();

    const replacement = capacity.reserve('u1', { selectVictim });
    expect(replacement.victim).toBe(victim);
    resident = 1;
    replacement.markVictimRemoved();
    resident = 2;
    replacement.markCreated();

    first();
    second();
    replacement();
  });

  test('releases an unconsumed recycle claim exactly once', () => {
    const victim = { id: 'existing' };
    const capacity = new TabCapacityReservations({
      maxGlobal: 1,
      maxPerUser: 1,
      getGlobalCount: () => 1,
      getUserCount: () => 1,
    });
    const selectVictim = reserved => reserved.has(victim) ? null : victim;
    const lease = capacity.reserve('u1', { selectVictim });
    expect(lease.victim).toBe(victim);
    lease();
    lease();
    const reacquired = capacity.reserve('u1', { selectVictim });
    expect(reacquired.victim).toBe(victim);
    reacquired();
  });

  test('admits an already-resident popup only when projected capacity stays within limits', () => {
    let residentGlobal = 1;
    let residentUser = 1;
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => residentGlobal,
      getUserCount: () => residentUser,
    });

    expect(() => capacity.adoptResident('u1')).not.toThrow();

    residentGlobal = 3;
    residentUser = 3;
    expect(() => capacity.adoptResident('u1')).toThrow(expect.objectContaining({
      code: 'tab_admission_user_limit',
      statusCode: 429,
    }));
  });

  test('rejects a resident popup when an API creation already owns the remaining slot', () => {
    let residentGlobal = 1;
    let residentUser = 1;
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => residentGlobal,
      getUserCount: () => residentUser,
    });
    const pending = capacity.reserve('u1');
    residentGlobal = 2;
    residentUser = 2;

    expect(() => capacity.adoptResident('u1')).toThrow(expect.objectContaining({
      code: 'tab_admission_user_limit',
    }));
    pending();
  });

  test('returns a machine-readable global rejection when no recycle victim exists', () => {
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => 2,
      getUserCount: () => 0,
      retryAfterSeconds: 4,
    });

    expect(() => capacity.reserve('new-user', { selectVictim: () => null })).toThrow(expect.objectContaining({
      statusCode: 429,
      code: 'tab_admission_global_limit',
      retryAfter: 4,
    }));
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

  test('reports pending creations for every session-expiry path', () => {
    const session = { tabGroups: new Map(), _pendingTabCreations: 0 };
    expect(hasPendingTabCreations(session)).toBe(false);
    const release = reservePendingTabCreation(session);
    expect(hasPendingTabCreations(session)).toBe(true);
    release();
    expect(hasPendingTabCreations(session)).toBe(false);
  });

  test('rejects lease acquisition atomically once teardown has begun', () => {
    const reason = Object.assign(new Error('session is closing'), { code: 'session_evicted' });
    const session = {
      tabGroups: new Map(),
      _closing: true,
      _closingReason: reason,
      _pendingTabCreations: 0,
    };

    expect(() => reservePendingTabCreation(session)).toThrow(reason);
    expect(session._pendingTabCreations).toBe(0);
    expect(session._pendingTabCreationLeases).toBeUndefined();
  });

  test('emergency teardown aborts and releases every pending creation lease', () => {
    const session = { tabGroups: new Map() };
    const first = reservePendingTabCreation(session);
    const second = reservePendingTabCreation(session);
    const reason = Object.assign(new Error('session evicted'), { code: 'session_evicted' });

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(abortPendingTabCreations(session, reason)).toBe(2);
    expect(first.signal.reason).toBe(reason);
    expect(second.signal.reason).toBe(reason);
    expect(hasPendingTabCreations(session)).toBe(false);
    expect(abortPendingTabCreations(session, reason)).toBe(0);
  });
});

describe('session mapping identity', () => {
  test('does not delete a replacement installed while an old session closes', () => {
    const oldSession = { id: 'old' };
    const replacement = { id: 'replacement' };
    const sessions = new Map([['user-1', replacement]]);

    expect(deleteSessionMappingIfCurrent(sessions, 'user-1', oldSession)).toBe(false);
    expect(sessions.get('user-1')).toBe(replacement);
    expect(deleteSessionMappingIfCurrent(sessions, 'user-1', replacement)).toBe(true);
    expect(sessions.has('user-1')).toBe(false);
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

  test('normalizes a plain HTTP 429 into the admission contract', () => {
    const response = {
      headers: {}, statusCode: null, body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    const error = Object.assign(new Error('limited'), { statusCode: 429 });
    expect(sendTabAdmissionError(response, error, 'safe limited')).toBe(true);
    expect(response.headers['Retry-After']).toBe('2');
    expect(response.body).toEqual({
      error: 'safe limited',
      code: 'tab_admission_rejected',
      retryAfter: 2,
    });
  });
});

describe('browser escalation sibling cleanup', () => {
  test('schedules siblings without awaiting them and skips current or already-closing sessions', async () => {
    const never = new Promise(() => {});
    const current = { id: 'current', _closing: true };
    const sibling = { id: 'sibling' };
    const closing = { id: 'closing', _closing: true };
    const cleanup = jest.fn(() => never);
    const sessions = new Map([
      ['current', current],
      ['sibling', sibling],
      ['closing', closing],
    ]);

    expect(scheduleSiblingSessionCleanup({ sessions, currentSession: current, cleanup })).toBe(1);
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('sibling', sibling);
  });
});

describe('bounded context cleanup', () => {
  test('returns false and escalates when context.close never settles', async () => {
    jest.useFakeTimers();
    try {
      const onTimeout = jest.fn();
      const context = { close: jest.fn(() => new Promise(() => {})) };
      const result = closeContextWithin(context, { timeoutMs: 50, onTimeout });
      await jest.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe(false);
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns true when context closes before the deadline', async () => {
    const context = { close: jest.fn(async () => {}) };
    await expect(closeContextWithin(context, { timeoutMs: 50 })).resolves.toBe(true);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

describe('popup generation ownership', () => {
  const ownerContext = {};
  const ownerSession = { context: ownerContext, browserGeneration: 'browser-1' };

  test('accepts only the captured current session, context, and generation', () => {
    expect(popupOwnerIsCurrent({
      currentSession: ownerSession,
      ownerSession,
      popupContext: ownerContext,
      ownerContext,
      ownerGeneration: 'browser-1',
    })).toBe(true);
  });

  test.each([
    ['replacement session', { currentSession: { context: ownerContext, browserGeneration: 'browser-2' } }],
    ['stale popup context', { popupContext: {} }],
    ['changed generation', { ownerGeneration: 'browser-2' }],
  ])('rejects %s', (_label, override) => {
    expect(popupOwnerIsCurrent({
      currentSession: ownerSession,
      ownerSession,
      popupContext: ownerContext,
      ownerContext,
      ownerGeneration: 'browser-1',
      ...override,
    })).toBe(false);
  });

  test('rejects a closing owner even while identity still matches', () => {
    const closing = { ...ownerSession, _closing: true };
    expect(popupOwnerIsCurrent({
      currentSession: closing,
      ownerSession: closing,
      popupContext: ownerContext,
      ownerContext,
      ownerGeneration: 'browser-1',
    })).toBe(false);
  });
});

describe('bounded orphan cleanup', () => {
  test('deduplicates cleanup while a page close is already in flight', async () => {
    const gate = deferred();
    const closePage = jest.fn(() => gate.promise);
    const session = { browserGeneration: 'browser-1' };
    const onEscalate = jest.fn(async () => ({ terminated: true, ownerEpoch: 'browser-1' }));
    const tracker = new OrphanPageCleanup({ closePage, maxAttempts: 2, onEscalate });
    const page = { isClosed: () => false };

    const first = tracker.cleanup(session, page, 'test');
    await flush();
    const duplicate = tracker.cleanup(session, page, 'duplicate');
    await flush();
    expect(closePage).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(duplicate).resolves.toBe(true);
    await expect(first).resolves.toBe(true);
    expect(closePage).toHaveBeenCalledTimes(2);
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(tracker.owns(page)).toBe(false);
  });

  test('retains strong ownership and self-retries a failed escalation', async () => {
    jest.useFakeTimers();
    try {
      const session = { browserGeneration: 'browser-1' };
      const onEscalate = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-1' });
      const tracker = new OrphanPageCleanup({
        closePage: jest.fn(async () => false),
        maxAttempts: 1,
        retryDelayMs: 10,
        onEscalate,
      });
      const page = { isClosed: () => false };

      await expect(tracker.cleanup(session, page, 'first')).resolves.toBe(false);
      expect(tracker.owns(page)).toBe(true);
      expect(onEscalate).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10);
      await flush();
      expect(onEscalate).toHaveBeenCalledTimes(2);
      expect(tracker.owns(page)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('bounds a permanently hanging escalation to one owned attempt', async () => {
    jest.useFakeTimers();
    try {
      const session = { browserGeneration: 'browser-1' };
      const onEscalate = jest.fn(() => new Promise(() => {}));
      const tracker = new OrphanPageCleanup({
        closePage: jest.fn(async () => false),
        maxAttempts: 1,
        retryDelayMs: 10,
        escalationTimeoutMs: 10,
        onEscalate,
      });
      const page = { isClosed: () => false };

      const cleanup = tracker.cleanup(session, page, 'hanging_escalation');
      await jest.advanceTimersByTimeAsync(10);
      await expect(cleanup).resolves.toBe(false);
      expect(tracker.owns(page)).toBe(true);

      await jest.advanceTimersByTimeAsync(100);
      await flush();
      expect(onEscalate).toHaveBeenCalledTimes(1);
      expect(tracker.owns(page)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects closing-state and mismatched-epoch proof as termination', async () => {
    jest.useFakeTimers();
    try {
      const session = { browserGeneration: 'browser-1', _closing: true };
      const onEscalate = jest
        .fn()
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-2' })
        .mockResolvedValueOnce({ terminated: true, ownerEpoch: 'browser-1' });
      const tracker = new OrphanPageCleanup({
        closePage: jest.fn(async () => false),
        maxAttempts: 1,
        retryDelayMs: 10,
        onEscalate,
      });
      const page = { isClosed: () => false };

      await expect(tracker.cleanup(session, page, 'mismatch')).resolves.toBe(false);
      expect(tracker.owns(page)).toBe(true);
      await jest.advanceTimersByTimeAsync(10);
      await flush();
      expect(tracker.owns(page)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('bounded page cleanup', () => {
  test('returns after its deadline when page.close never settles', async () => {
    jest.useFakeTimers();
    try {
      const closeGate = deferred();
      const page = {
        isClosed: () => false,
        close: jest.fn(() => closeGate.promise),
        removeAllListeners: jest.fn(),
      };
      const onTimeout = jest.fn();
      const cleanup = closePageWithin(page, { timeoutMs: 100, onTimeout });

      await jest.advanceTimersByTimeAsync(100);
      await expect(cleanup).resolves.toBe(false);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(page.removeAllListeners).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('awaitAbortableResource', () => {
  test('rejects promptly on abort and closes a resource that resolves later', async () => {
    const resource = deferred();
    const abort = new AbortController();
    const close = jest.fn(async () => {});
    let settled = false;
    const result = awaitAbortableResource(resource.promise, abort.signal, close);
    result.catch(() => { settled = true; });

    abort.abort(new Error('request timed out'));
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(true);

    const latePage = { id: 'late-page' };
    resource.resolve(latePage);
    await flush();
    expect(close).toHaveBeenCalledWith(latePage);
    await expect(result).rejects.toThrow('request timed out');
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

  test('unregisters and closes promptly when aborted work never settles', async () => {
    const abort = new AbortController();
    const work = deferred();
    const registered = new Map();
    const close = jest.fn(async () => {});
    const resource = { id: 'tab-stuck' };
    let settled = false;

    const result = withAbortableResource({
      create: async () => resource,
      signal: abort.signal,
      register: async (value) => registered.set(value.id, value),
      unregister: async (value) => registered.delete(value.id),
      cleanup: close,
      operation: async () => work.promise,
    });
    result.catch(() => { settled = true; });
    await new Promise(setImmediate);

    abort.abort(new Error('request timed out'));
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(registered.size).toBe(0);
    expect(close).toHaveBeenCalledWith(resource);
    await expect(result).rejects.toThrow('request timed out');
  });

  test('retains operation ownership for a bounded grace while creation is still detached', async () => {
    jest.useFakeTimers();
    try {
      const abort = new AbortController();
      const rawCreate = deferred();
      let settled = false;
      const result = withAbortableResource({
        create: async () => rawCreate.promise,
        signal: abort.signal,
        register: jest.fn(),
        unregister: jest.fn(),
        cleanup: jest.fn(),
        cleanupTimeoutMs: 50,
        operation: jest.fn(),
      });
      result.catch(() => { settled = true; });
      await flush();

      abort.abort(new Error('request timed out'));
      await jest.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(result).rejects.toThrow('request timed out');
      rawCreate.reject(new Error('terminated later'));
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not invoke create when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('already expired'), { code: 'tab_admission_operation_timeout' });
    controller.abort(reason);
    const create = jest.fn(async () => ({ id: 'must-not-exist' }));

    await expect(withAbortableResource({
      create,
      signal: controller.signal,
      register: jest.fn(),
      unregister: jest.fn(),
      cleanup: jest.fn(),
      operation: jest.fn(),
    })).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('bounds cleanup after abort even when cleanup never settles', async () => {
    jest.useFakeTimers();
    const cleanupGate = deferred();
    const work = deferred();
    const registered = new Set();
    try {
      const abort = new AbortController();
      let settled = false;
      const resource = { id: 'bounded-cleanup' };
      const result = withAbortableResource({
        create: async () => resource,
        signal: abort.signal,
        register: async value => registered.add(value),
        unregister: async value => registered.delete(value),
        cleanup: async () => cleanupGate.promise,
        cleanupTimeoutMs: 50,
        operation: async () => work.promise,
      });
      result.catch(() => { settled = true; });
      await flush();
      await jest.advanceTimersByTimeAsync(0);
      expect(registered.has(resource)).toBe(true);
      abort.abort(new Error('request timed out'));
      await jest.advanceTimersByTimeAsync(50);
      expect(settled).toBe(true);
      await expect(result).rejects.toThrow('request timed out');
      expect(registered.has(resource)).toBe(true);
      cleanupGate.resolve(true);
      await flush();
      expect(registered.size).toBe(0);
    } finally {
      cleanupGate.resolve(true);
      work.resolve();
      jest.useRealTimers();
    }
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

    await expect(result).rejects.toThrow('request timed out');
    expect(registered.size).toBe(0);
    expect(close).toHaveBeenCalledWith(resource);
  });
});
