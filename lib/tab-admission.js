export class TabAdmissionError extends Error {
  constructor(message, { code, retryAfter, statusCode = 429 } = {}) {
    super(message);
    this.name = 'TabAdmissionError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class TabAdmissionController {
  constructor({
    maxActive,
    maxActivePerUser,
    maxPending,
    maxAbandoned = Number.POSITIVE_INFINITY,
    waitTimeoutMs = 0,
    operationTimeoutMs = 0,
    retryAfterSeconds = 2,
    onStateChange = () => {},
    onRejected = () => {},
    onTimeout = () => {},
    onAbandonedLimit = () => {},
  }) {
    this.maxActive = positiveInteger(maxActive, 1);
    this.maxActivePerUser = positiveInteger(maxActivePerUser, 1);
    this.maxPending = positiveInteger(maxPending, 1);
    this.maxAbandoned = positiveInteger(maxAbandoned, Number.POSITIVE_INFINITY);
    this.waitTimeoutMs = Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 0;
    this.operationTimeoutMs = Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0 ? operationTimeoutMs : 0;
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onStateChange = onStateChange;
    this.onRejected = onRejected;
    this.onTimeout = onTimeout;
    this.onAbandonedLimit = onAbandonedLimit;
    this.active = 0;
    this.pending = 0;
    this.abandoned = 0;
    this.abandonedLimitNotified = false;
    this.activeByUser = new Map();
    this.queue = [];
  }

  snapshot() {
    const pendingByUser = Object.create(null);
    for (const entry of this.queue) {
      pendingByUser[entry.key] = (pendingByUser[entry.key] || 0) + 1;
    }
    return {
      active: this.active,
      pending: this.pending,
      abandoned: this.abandoned,
      activeByUser: Object.fromEntries(this.activeByUser),
      pendingByUser,
    };
  }

  run(userKey, operation) {
    const key = String(userKey);
    const canStartNow = this.#canStart(key);
    if (!canStartNow && this.pending >= this.maxPending) {
      this.onRejected();
      return Promise.reject(new TabAdmissionError('Tab admission queue is full', {
        code: 'tab_admission_queue_full',
        retryAfter: this.retryAfterSeconds,
      }));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        key,
        operation,
        resolve,
        reject,
        queued: true,
        responded: false,
        waitTimer: null,
      };
      this.queue.push(entry);
      this.pending += 1;

      if (this.waitTimeoutMs > 0) {
        entry.waitTimer = setTimeout(() => this.#expireQueued(entry), this.waitTimeoutMs);
      }

      this.#stateChanged();
      this.#pump();
    });
  }

  #canStart(key) {
    return this.abandoned < this.maxAbandoned
      && this.active < this.maxActive
      && (this.activeByUser.get(key) || 0) < this.maxActivePerUser;
  }

  #expireQueued(entry) {
    if (!entry.queued) return;
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.queued = false;
    this.pending -= 1;
    this.onTimeout('wait');
    this.#stateChanged();
    entry.responded = true;
    entry.reject(new TabAdmissionError('Tab admission wait timed out', {
      code: 'tab_admission_wait_timeout',
      retryAfter: this.retryAfterSeconds,
    }));
    this.#pump();
  }

  #pump() {
    while (this.active < this.maxActive) {
      const index = this.queue.findIndex((entry) => this.#canStart(entry.key));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.#start(entry);
    }
  }

  #start(entry) {
    entry.queued = false;
    clearTimeout(entry.waitTimer);
    this.pending -= 1;
    this.active += 1;
    entry.slotOwned = true;
    this.activeByUser.set(entry.key, (this.activeByUser.get(entry.key) || 0) + 1);
    this.#stateChanged();

    const abortController = new AbortController();
    let operationTimer = null;
    if (this.operationTimeoutMs > 0) {
      operationTimer = setTimeout(() => {
        if (entry.responded) return;
        const error = new TabAdmissionError('Tab creation timed out', {
          code: 'tab_admission_operation_timeout',
          retryAfter: this.retryAfterSeconds,
        });
        entry.responded = true;
        entry.abandoned = true;
        this.abandoned += 1;
        // A hung browser cleanup must not retain admission capacity. Release
        // the slot at the externally visible timeout; abandoned work remains
        // separately bounded until its browser generation is reset or settles.
        this.#release(entry);
        this.onTimeout('operation');
        abortController.abort(error);
        entry.reject(error);
        if (this.abandoned >= this.maxAbandoned && !this.abandonedLimitNotified) {
          this.abandonedLimitNotified = true;
          try { this.onAbandonedLimit({ abandoned: this.abandoned }); } catch (_) {}
        }
      }, this.operationTimeoutMs);
    }

    Promise.resolve()
      .then(() => entry.operation(abortController.signal))
      .then(
        (value) => {
          if (entry.responded) return;
          entry.responded = true;
          entry.resolve(value);
        },
        (error) => {
          if (entry.responded) return;
          entry.responded = true;
          entry.reject(error);
        },
      )
      .finally(() => {
        clearTimeout(operationTimer);
        if (entry.abandoned) {
          entry.abandoned = false;
          this.abandoned = Math.max(0, this.abandoned - 1);
          if (this.abandoned < this.maxAbandoned) this.abandonedLimitNotified = false;
        }
        this.#release(entry);
        this.#pump();
      });
  }

  #release(entry) {
    if (!entry.slotOwned) return;
    entry.slotOwned = false;
    this.active -= 1;
    const remaining = (this.activeByUser.get(entry.key) || 1) - 1;
    if (remaining > 0) this.activeByUser.set(entry.key, remaining);
    else this.activeByUser.delete(entry.key);
    this.#stateChanged();
    this.#pump();
  }

  #stateChanged() {
    this.onStateChange(this.snapshot());
  }
}

export class SessionCreationGenerations {
  constructor() {
    this.globalGeneration = 0;
    this.activeByUser = new Map();
  }

  begin(userKey) {
    const key = String(userKey);
    const prior = this.activeByUser.get(key);
    if (prior) prior.valid = false;
    const token = { key, globalGeneration: this.globalGeneration, valid: true };
    this.activeByUser.set(key, token);
    return token;
  }

  canPublish(token) {
    return token?.valid === true
      && token.globalGeneration === this.globalGeneration
      && (token.finished === true || this.activeByUser.get(token.key) === token);
  }

  setInvalidationHandler(token, handler) {
    if (!token || typeof handler !== 'function') return;
    if (!token.valid || token.globalGeneration !== this.globalGeneration) {
      try { handler(); } catch (_) {}
      return;
    }
    token.invalidationHandler = handler;
  }

  bindAbort(token, signal) {
    if (!signal) return () => {};
    let bound = true;
    const invalidate = () => {
      if (!bound) return;
      bound = false;
      this.invalidateToken(token);
    };
    if (signal.aborted) {
      invalidate();
      return () => {};
    }
    signal.addEventListener('abort', invalidate, { once: true });
    return () => {
      if (!bound) return;
      bound = false;
      signal.removeEventListener('abort', invalidate);
    };
  }

  invalidateToken(token) {
    if (!token || !token.valid) return;
    token.valid = false;
    if (this.activeByUser.get(token.key) === token) this.activeByUser.delete(token.key);
    const handler = token.invalidationHandler;
    token.invalidationHandler = null;
    if (handler) {
      try { handler(); } catch (_) {}
    }
  }

  invalidate(userKey) {
    const key = String(userKey);
    const token = this.activeByUser.get(key);
    this.invalidateToken(token);
  }

  finish(token) {
    if (this.activeByUser.get(token?.key) === token) this.activeByUser.delete(token.key);
    if (token) {
      token.finished = true;
      token.invalidationHandler = null;
    }
  }

  invalidateAll() {
    for (const token of this.activeByUser.values()) this.invalidateToken(token);
    this.globalGeneration += 1;
    this.activeByUser.clear();
  }
}

export class InFlightOperations {
  constructor() {
    this.operations = new Set();
  }

  get size() {
    return this.operations.size;
  }

  track(promise) {
    const operation = Promise.resolve(promise);
    this.operations.add(operation);
    const remove = () => this.operations.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  async drain() {
    while (this.operations.size > 0) {
      await Promise.allSettled(Array.from(this.operations));
    }
  }
}

export function runWithRetainedLock(lock, operation, observe) {
  const rawOperation = Promise.resolve().then(operation);
  rawOperation.then(() => lock.release(), () => lock.release());
  return observe(rawOperation);
}

export class SessionCapacityReservations {
  constructor({ maxSessions, getPublishedCount }) {
    this.maxSessions = positiveInteger(maxSessions, 1);
    this.getPublishedCount = getPublishedCount;
    this.reserved = 0;
    this.detached = 0;
  }

  reserve() {
    if (this.getPublishedCount() + this.reserved + this.detached >= this.maxSessions) {
      throw Object.assign(new Error('Maximum concurrent sessions reached'), {
        statusCode: 503,
        code: 'admission_rejected',
      });
    }
    this.reserved += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved = Math.max(0, this.reserved - 1);
    };
  }

  trackDetached(closePromise) {
    this.detached += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.detached = Math.max(0, this.detached - 1);
    };
    Promise.resolve(closePromise).then(release, release);
    return release;
  }

  snapshot() {
    return { reserved: this.reserved, detached: this.detached };
  }
}

export function claimTabForPressureCleanup({
  sessions,
  userId,
  session,
  group,
  tabId,
  tabState,
  observedToolCalls,
  lock,
}) {
  if (sessions.get(userId) !== session) return null;
  if (group.get(tabId) !== tabState) return null;
  if (tabState.toolCalls !== observedToolCalls) return null;
  if (!lock.tryAcquire()) return null;

  if (
    sessions.get(userId) !== session
    || group.get(tabId) !== tabState
    || tabState.toolCalls !== observedToolCalls
  ) {
    lock.release();
    return null;
  }

  // Unpublish synchronously before cleanup awaits so no lockless route can
  // discover this tab after the final activity/identity revalidation.
  group.delete(tabId);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      lock.release();
    },
  };
}

export class TabCapacityReservations {
  constructor({
    maxGlobal,
    maxPerUser,
    getGlobalCount,
    getUserCount,
    retryAfterSeconds = 2,
    onRejected = () => {},
  }) {
    this.maxGlobal = positiveInteger(maxGlobal, 1);
    this.maxPerUser = positiveInteger(maxPerUser, 1);
    this.getGlobalCount = getGlobalCount;
    this.getUserCount = getUserCount;
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onRejected = onRejected;
    this.reservedGlobal = 0;
    this.reservedByUser = new Map();
  }

  reserve(userKey) {
    const key = String(userKey);
    const userReserved = this.reservedByUser.get(key) || 0;
    if (this.getUserCount(key) + userReserved >= this.maxPerUser) {
      this.onRejected();
      throw new TabAdmissionError('Maximum tabs per user reached', {
        code: 'tab_admission_user_limit',
        retryAfter: this.retryAfterSeconds,
      });
    }
    if (this.getGlobalCount() + this.reservedGlobal >= this.maxGlobal) {
      this.onRejected();
      throw new TabAdmissionError('Maximum global tabs reached', {
        code: 'tab_admission_global_limit',
        retryAfter: this.retryAfterSeconds,
      });
    }

    this.reservedGlobal += 1;
    this.reservedByUser.set(key, userReserved + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedGlobal -= 1;
      const remaining = (this.reservedByUser.get(key) || 1) - 1;
      if (remaining > 0) this.reservedByUser.set(key, remaining);
      else this.reservedByUser.delete(key);
    };
  }
}

export function reservePendingTabCreation(session) {
  session._pendingTabCreations = (session._pendingTabCreations || 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session._pendingTabCreations = Math.max(0, (session._pendingTabCreations || 1) - 1);
  };
}

export function canReapEmptySession(session) {
  return session.tabGroups.size === 0 && (session._pendingTabCreations || 0) === 0;
}

export function releaseOnAbort(signal, release) {
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', releaseOnce);
    release();
  };
  if (signal?.aborted) releaseOnce();
  else signal?.addEventListener('abort', releaseOnce, { once: true });
  return releaseOnce;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

export async function replaceSessionAfterProxyFailure({
  signal,
  userKey,
  failedSession,
  closeSession,
  closeOptions,
  getSession,
}) {
  throwIfAborted(signal);
  if (closeOptions === undefined) await closeSession(userKey, failedSession);
  else await closeSession(userKey, failedSession, closeOptions);
  throwIfAborted(signal);
  const replacement = await getSession();
  throwIfAborted(signal);
  return replacement;
}

export async function closePageWithin(page, {
  timeoutMs,
  onFailure = () => {},
  retainUntilSettled = false,
} = {}) {
  if (!page || page.isClosed()) return true;
  let timer;
  const closePromise = Promise.resolve().then(() => page.close({ runBeforeUnload: false }));
  try {
    await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('page close timed out')), timeoutMs);
      }),
    ]);
    return true;
  } catch (error) {
    try { onFailure(error); } catch (_) {}
    try { page.removeAllListeners(); } catch (_) {}
    // Admission-owned cleanup must remain pending while the underlying browser
    // operation is still hung so abandoned-work accounting cannot be bypassed.
    if (retainUntilSettled) await closePromise.catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function detachSessionForClose(sessions, userKey, session) {
  if (!session) return false;
  session._closing = true;
  if (sessions.get(userKey) !== session) return false;
  sessions.delete(userKey);
  return true;
}

export function coalesceSessionClose(session, teardown) {
  if (session._closePromise) return session._closePromise;
  session._closePromise = Promise.resolve().then(teardown);
  return session._closePromise;
}

export function settleWithin(promise, timeoutMs) {
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return settled;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

export function settleAllConcurrently(items, operation) {
  return Promise.allSettled(items.map((item) => Promise.resolve().then(() => operation(item))));
}

export async function runBoundedSessionTeardown({
  steps = [],
  closeContext,
  emitDestroyed,
  timeoutMs,
  onSettlement,
  trackOperation,
}) {
  const settleOperation = async (name, operation) => {
    const rawOperation = Promise.resolve().then(operation);
    try { trackOperation?.(rawOperation); } catch (_) {}
    const result = await settleWithin(rawOperation, timeoutMs);
    try { onSettlement?.(name, result); } catch (_) {}
    return result;
  };

  try {
    for (const [name, operation] of steps) {
      await settleOperation(name, operation);
    }
  } finally {
    await settleOperation('context.close', closeContext);
    await settleOperation('session:destroyed', emitDestroyed);
  }
}

export function sendTabAdmissionError(response, error, safeMessage = error?.message) {
  if (error?.statusCode !== 429 || !error?.code?.startsWith('tab_admission_')) return false;
  response.set('Retry-After', String(error.retryAfter));
  response.status(429).json({
    error: safeMessage,
    code: error.code,
    retryAfter: error.retryAfter,
  });
  return true;
}

export async function awaitAbortableResource(resourcePromise, signal, cleanup) {
  const resource = await resourcePromise;
  if (!signal?.aborted) return resource;
  await cleanup(resource);
  throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

export async function withAbortableResource({
  create,
  signal,
  register,
  unregister,
  cleanup,
  operation,
}) {
  let resource;
  let registered = false;
  let unregisterPromise = null;
  let cleanupPromise = null;
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
  const unregisterOnce = () => {
    if (!registered) return Promise.resolve();
    registered = false;
    if (!unregisterPromise) unregisterPromise = Promise.resolve(unregister(resource));
    return unregisterPromise;
  };
  const cleanupOnce = () => {
    if (!resource) return Promise.resolve();
    if (!cleanupPromise) cleanupPromise = Promise.resolve(cleanup(resource));
    return cleanupPromise;
  };
  const onAbort = () => {
    Promise.allSettled([unregisterOnce(), cleanupOnce()]).catch(() => {});
  };

  try {
    resource = await awaitAbortableResource(Promise.resolve().then(create), signal, cleanup);
    await register(resource);
    registered = true;
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const result = await operation(resource);
    if (signal?.aborted) throw abortError();
    return result;
  } catch (error) {
    try {
      await unregisterOnce();
    } finally {
      await cleanupOnce();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
