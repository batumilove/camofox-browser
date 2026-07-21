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
    waitTimeoutMs = 0,
    operationTimeoutMs = 0,
    abortGraceMs = 5000,
    retryAfterSeconds = 2,
    onStateChange = () => {},
    onRejected = () => {},
    onTimeout = () => {},
  }) {
    this.maxActive = positiveInteger(maxActive, 1);
    this.maxActivePerUser = positiveInteger(maxActivePerUser, 1);
    this.maxPending = positiveInteger(maxPending, 1);
    this.waitTimeoutMs = Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 0;
    this.operationTimeoutMs = Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0 ? operationTimeoutMs : 0;
    this.abortGraceMs = Number.isFinite(abortGraceMs) && abortGraceMs >= 0 ? abortGraceMs : 5000;
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onStateChange = onStateChange;
    this.onRejected = onRejected;
    this.onTimeout = onTimeout;
    this.active = 0;
    this.pending = 0;
    this.activeByUser = new Map();
    this.queue = [];
  }

  snapshot() {
    return {
      active: this.active,
      pending: this.pending,
      activeByUser: Object.fromEntries(this.activeByUser),
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
    return this.active < this.maxActive && (this.activeByUser.get(key) || 0) < this.maxActivePerUser;
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
    this.activeByUser.set(entry.key, (this.activeByUser.get(entry.key) || 0) + 1);
    this.#stateChanged();

    const abortController = new AbortController();
    let operationTimer = null;
    let abortGraceTimer = null;
    let activeReleased = false;
    const releaseActive = () => {
      if (activeReleased) return;
      activeReleased = true;
      this.active -= 1;
      const remaining = (this.activeByUser.get(entry.key) || 1) - 1;
      if (remaining > 0) this.activeByUser.set(entry.key, remaining);
      else this.activeByUser.delete(entry.key);
      this.#stateChanged();
      this.#pump();
    };

    if (this.operationTimeoutMs > 0) {
      operationTimer = setTimeout(() => {
        if (entry.responded) return;
        const error = new TabAdmissionError('Tab creation timed out', {
          code: 'tab_admission_operation_timeout',
          retryAfter: this.retryAfterSeconds,
        });
        entry.responded = true;
        this.onTimeout('operation');
        abortController.abort(error);
        entry.reject(error);
        if (this.abortGraceMs === 0) releaseActive();
        else abortGraceTimer = setTimeout(releaseActive, this.abortGraceMs);
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
        clearTimeout(abortGraceTimer);
        releaseActive();
      });
  }

  #stateChanged() {
    this.onStateChange(this.snapshot());
  }
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
    this.reservedVictims = new Set();
    this.claimedResidentGlobal = 0;
    this.claimedResidentByUser = new Map();
  }

  reserve(userKey, { selectVictim } = {}) {
    const key = String(userKey);
    const userReserved = this.reservedByUser.get(key) || 0;
    const userClaimedResident = this.claimedResidentByUser.get(key) || 0;
    const projectedUser = this.getUserCount(key) + userReserved - userClaimedResident;
    const projectedGlobal = this.getGlobalCount() + this.reservedGlobal - this.claimedResidentGlobal;
    const userAtLimit = projectedUser >= this.maxPerUser;
    const globalAtLimit = projectedGlobal >= this.maxGlobal;
    let victim = null;

    if (userAtLimit || globalAtLimit) {
      victim = typeof selectVictim === 'function'
        ? selectVictim(new Set(this.reservedVictims))
        : null;
      if (!victim || this.reservedVictims.has(victim)) {
        this.onRejected();
        if (userAtLimit) {
          throw new TabAdmissionError('Maximum tabs per user reached', {
            code: 'tab_admission_user_limit',
            retryAfter: this.retryAfterSeconds,
          });
        }
        throw new TabAdmissionError('Maximum global tabs reached', {
          code: 'tab_admission_global_limit',
          retryAfter: this.retryAfterSeconds,
        });
      }
      this.reservedVictims.add(victim);
      this.claimedResidentGlobal += 1;
      this.claimedResidentByUser.set(key, userClaimedResident + 1);
    }

    this.reservedGlobal += 1;
    this.reservedByUser.set(key, userReserved + 1);
    let pending = true;
    let victimStillResident = Boolean(victim);
    let released = false;

    const decrementPending = () => {
      if (!pending) return;
      pending = false;
      this.reservedGlobal = Math.max(0, this.reservedGlobal - 1);
      const remaining = Math.max(0, (this.reservedByUser.get(key) || 1) - 1);
      if (remaining > 0) this.reservedByUser.set(key, remaining);
      else this.reservedByUser.delete(key);
    };
    const decrementClaimedResident = () => {
      if (!victimStillResident) return;
      victimStillResident = false;
      this.claimedResidentGlobal = Math.max(0, this.claimedResidentGlobal - 1);
      const remaining = Math.max(0, (this.claimedResidentByUser.get(key) || 1) - 1);
      if (remaining > 0) this.claimedResidentByUser.set(key, remaining);
      else this.claimedResidentByUser.delete(key);
    };
    const release = () => {
      if (released) return;
      released = true;
      decrementPending();
      decrementClaimedResident();
      if (victim) this.reservedVictims.delete(victim);
    };
    release.victim = victim;
    release.markVictimRemoved = decrementClaimedResident;
    release.markCreated = decrementPending;
    return release;
  }
}

export function reservePendingTabCreation(session) {
  if (!session._pendingTabCreationLeases) session._pendingTabCreationLeases = new Set();
  const controller = new AbortController();
  session._pendingTabCreations = (session._pendingTabCreations || 0) + 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    session._pendingTabCreationLeases.delete(release);
    session._pendingTabCreations = Math.max(0, (session._pendingTabCreations || 1) - 1);
  };
  release.signal = controller.signal;
  release.abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    release();
  };
  session._pendingTabCreationLeases.add(release);
  return release;
}

export function abortPendingTabCreations(session, reason = Object.assign(new Error('Session evicted'), { code: 'session_evicted' })) {
  const leases = Array.from(session?._pendingTabCreationLeases || []);
  for (const lease of leases) lease.abort(reason);
  return leases.length;
}

export function hasPendingTabCreations(session) {
  return (session?._pendingTabCreationLeases?.size || session?._pendingTabCreations || 0) > 0;
}

export function canReapEmptySession(session) {
  return session.tabGroups.size === 0 && !hasPendingTabCreations(session);
}

export function deleteSessionMappingIfCurrent(sessionMap, key, session) {
  if (sessionMap.get(key) !== session) return false;
  sessionMap.delete(key);
  return true;
}

export function sendTabAdmissionError(response, error, safeMessage = error?.message) {
  if (error?.statusCode !== 429) return false;
  const code = error?.code?.startsWith('tab_admission_')
    ? error.code
    : 'tab_admission_rejected';
  const retryAfter = positiveInteger(error?.retryAfter, 2);
  response.set('Retry-After', String(retryAfter));
  response.status(429).json({
    error: safeMessage,
    code,
    retryAfter,
  });
  return true;
}

export async function closePageWithin(page, {
  timeoutMs,
  onTimeout = () => {},
} = {}) {
  if (!page || page.isClosed?.()) return;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1000;
  let timer;
  const closeAttempt = Promise.resolve()
    .then(() => page.close({ runBeforeUnload: false }))
    .then(() => ({ closed: true }), error => ({ closed: false, error }));
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ closed: false, timedOut: true }), boundedTimeoutMs);
  });
  const result = await Promise.race([closeAttempt, timeout]);
  clearTimeout(timer);
  if (result.closed) return;
  onTimeout(result.error || new Error('page close timed out'));
  page.removeAllListeners?.();
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve(promise), aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function settleWithin(promise, timeoutMs) {
  const observed = Promise.resolve(promise);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return observed;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([observed, timeout]).finally(() => clearTimeout(timer));
}

export async function awaitAbortableResource(resourcePromise, signal, cleanup) {
  const source = Promise.resolve(resourcePromise);
  let cleanupPromise = null;
  const cleanupOnce = resource => {
    if (!cleanupPromise) cleanupPromise = Promise.resolve(cleanup(resource));
    return cleanupPromise;
  };

  try {
    const resource = await raceWithAbort(source, signal);
    if (!signal?.aborted) return resource;
    await cleanupOnce(resource);
    throw abortError(signal);
  } catch (error) {
    if (signal?.aborted) {
      source.then(cleanupOnce, () => {}).catch(() => {});
    }
    throw error;
  }
}

export async function withAbortableResource({
  create,
  signal,
  register,
  unregister,
  cleanup,
  cleanupTimeoutMs = 0,
  operation,
}) {
  let resource;
  let registered = false;
  let cleanupPromise = null;
  const currentAbortError = () => abortError(signal);
  const cleanupResource = value => settleWithin(
    Promise.resolve().then(() => cleanup(value)),
    cleanupTimeoutMs,
  );
  const cleanupOnce = () => {
    if (!resource) return Promise.resolve();
    if (!cleanupPromise) cleanupPromise = cleanupResource(resource);
    return cleanupPromise;
  };
  const onAbort = () => { cleanupOnce().catch(() => {}); };

  try {
    resource = await awaitAbortableResource(Promise.resolve().then(create), signal, cleanupResource);
    registered = true;
    await register(resource);
    if (signal?.aborted) throw currentAbortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const operationPromise = Promise.resolve().then(() => operation(resource));
    const result = await raceWithAbort(operationPromise, signal);
    if (signal?.aborted) throw currentAbortError();
    return result;
  } catch (error) {
    if (registered) await Promise.resolve(unregister(resource)).catch(() => {});
    await cleanupOnce().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
