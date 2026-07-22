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

export class RawCreationRegistry {
  constructor({
    maxOutstanding,
    maxPerUser,
    retryAfterSeconds = 2,
    onRejected = () => {},
    onDeadline = async () => {},
  }) {
    this.maxOutstanding = positiveInteger(maxOutstanding, 1);
    this.maxPerUser = positiveInteger(maxPerUser, this.maxOutstanding);
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onRejected = onRejected;
    this.onDeadline = onDeadline;
    this.entries = new Map();
    this.byUser = new Map();
  }

  acquire({ userKey, kind = 'page', owner = null, deadlineMs, onDeadline } = {}) {
    const key = String(userKey);
    const userOutstanding = this.byUser.get(key) || 0;
    if (this.entries.size >= this.maxOutstanding || userOutstanding >= this.maxPerUser) {
      this.onRejected({ userKey: key, kind });
      throw new TabAdmissionError('Maximum unresolved browser creations reached', {
        code: 'tab_admission_raw_creation_limit',
        retryAfter: this.retryAfterSeconds,
      });
    }

    const id = Symbol(`${kind}:${key}`);
    const entry = {
      id,
      userKey: key,
      kind,
      owner,
      deadlineFired: false,
      timer: null,
      retired: false,
    };
    this.entries.set(id, entry);
    this.byUser.set(key, userOutstanding + 1);

    const settle = () => {
      if (!this.entries.delete(id)) return false;
      entry.retired = true;
      const remaining = (this.byUser.get(key) || 1) - 1;
      if (remaining > 0) this.byUser.set(key, remaining);
      else this.byUser.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      return true;
    };
    const boundedDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 0;
    if (boundedDeadlineMs > 0) {
      entry.timer = setTimeout(() => {
        if (!this.entries.has(id) || entry.deadlineFired) return;
        entry.deadlineFired = true;
        const handler = onDeadline || this.onDeadline;
        Promise.resolve(handler(entry)).catch(() => {});
      }, boundedDeadlineMs);
    }
    entry.retire = settle;
    return { id, settle, retire: settle, entry };
  }

  snapshot() {
    const byKind = {};
    for (const entry of this.entries.values()) {
      byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    }
    return {
      outstanding: this.entries.size,
      byKind,
      byUser: Object.fromEntries(this.byUser),
    };
  }
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

  run(userKey, operation, { signal } = {}) {
    const key = String(userKey);
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
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
        signal,
        onExternalAbort: null,
        abortController: null,
        releaseActive: null,
      };
      entry.onExternalAbort = () => this.#abortEntry(entry);
      if (signal) signal.addEventListener('abort', entry.onExternalAbort, { once: true });
      this.queue.push(entry);
      this.pending += 1;

      if (this.waitTimeoutMs > 0) {
        entry.waitTimer = setTimeout(() => this.#expireQueued(entry), this.waitTimeoutMs);
      }

      this.#stateChanged();
      this.#pump();
    });
  }

  #detachSignal(entry) {
    if (entry.signal && entry.onExternalAbort) {
      entry.signal.removeEventListener('abort', entry.onExternalAbort);
      entry.onExternalAbort = null;
    }
  }

  #abortEntry(entry) {
    if (entry.responded) return;
    const reason = entry.signal?.reason instanceof Error ? entry.signal.reason : new Error('Request aborted');
    if (entry.queued) {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      entry.queued = false;
      this.pending -= 1;
      clearTimeout(entry.waitTimer);
      this.#detachSignal(entry);
      entry.responded = true;
      entry.reject(reason);
      this.#stateChanged();
      this.#pump();
      return;
    }
    entry.responded = true;
    this.#detachSignal(entry);
    if (entry.abortController && !entry.abortController.signal.aborted) entry.abortController.abort(reason);
    entry.reject(reason);
    if (this.abortGraceMs === 0) entry.releaseActive?.();
    else setTimeout(() => entry.releaseActive?.(), this.abortGraceMs);
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
    this.#detachSignal(entry);
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
    entry.abortController = abortController;
    entry.releaseActive = releaseActive;

    if (entry.signal?.aborted) this.#abortEntry(entry);
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
        this.#detachSignal(entry);
        entry.abortController = null;
        entry.releaseActive = null;
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

  adoptResident(userKey) {
    const key = String(userKey);
    const projectedUser = this.getUserCount(key)
      + (this.reservedByUser.get(key) || 0)
      - (this.claimedResidentByUser.get(key) || 0);
    const projectedGlobal = this.getGlobalCount()
      + this.reservedGlobal
      - this.claimedResidentGlobal;
    if (projectedUser <= this.maxPerUser && projectedGlobal <= this.maxGlobal) return true;

    this.onRejected();
    if (projectedUser > this.maxPerUser) {
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
  if (session?._closing) {
    throw session._closingReason instanceof Error
      ? session._closingReason
      : Object.assign(new Error('Session is closing'), { code: 'session_evicted' });
  }
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

export function scheduleSiblingSessionCleanup({
  sessions,
  currentSession,
  cleanup,
  onError = () => {},
}) {
  let scheduled = 0;
  for (const [userId, session] of Array.from(sessions.entries())) {
    if (session === currentSession || session?._closing) continue;
    scheduled++;
    Promise.resolve()
      .then(() => cleanup(userId, session))
      .catch(error => onError(error, userId, session));
  }
  return scheduled;
}

export class OrphanPageCleanup {
  constructor({
    closePage,
    maxAttempts = 2,
    retryDelayMs = 1000,
    escalationTimeoutMs = 1000,
    onEscalate = async () => {},
  }) {
    this.closePage = closePage;
    this.maxAttempts = positiveInteger(maxAttempts, 2);
    this.retryDelayMs = positiveInteger(retryDelayMs, 1000);
    this.escalationTimeoutMs = positiveInteger(escalationTimeoutMs, 1000);
    this.onEscalate = onEscalate;
    // Strong ownership is intentional: resident pages must not disappear from cleanup
    // accounting merely because route bookkeeping or weak references were removed.
    this.owned = new Map();
    this.escalatingSessions = new WeakSet();
  }

  owns(page) {
    return Boolean(page && this.owned.has(page));
  }

  #release(entry) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    if (this.owned.get(entry.page) === entry) this.owned.delete(entry.page);
  }

  #scheduleRetry(entry) {
    if (entry.retryTimer || this.owned.get(entry.page) !== entry) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void this.#run(entry).catch(() => {});
    }, this.retryDelayMs);
    entry.retryTimer.unref?.();
  }

  #proofMatches(entry, proof) {
    return Boolean(
      proof?.terminated === true
      && entry.ownerEpoch !== null
      && proof?.ownerEpoch === entry.ownerEpoch
    );
  }

  async #escalate(entry) {
    if (!entry.escalationRaw) {
      if (entry.session && this.escalatingSessions.has(entry.session)) return null;
      if (entry.session) this.escalatingSessions.add(entry.session);
      const raw = Promise.resolve().then(() => this.onEscalate(
        entry.session,
        entry.page,
        entry.reason,
        entry.attempts + this.maxAttempts,
      ));
      entry.escalationRaw = raw;
      raw.then(proof => {
        if (entry.page.isClosed?.() || this.#proofMatches(entry, proof)) this.#release(entry);
      }, () => {
        // A later retry may start a fresh escalation after this failed one settles.
      }).finally(() => {
        if (entry.escalationRaw === raw) {
          entry.escalationRaw = null;
          if (entry.session) this.escalatingSessions.delete(entry.session);
        }
        if (this.owned.get(entry.page) === entry) this.#scheduleRetry(entry);
      }).catch(() => {});
    }

    const raw = entry.escalationRaw;
    if (!raw) return null;
    let timer;
    let timedOut = false;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, this.escalationTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([raw.catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
      if (timedOut && entry.escalationRaw === raw) {
        entry.escalationRaw = null;
        if (entry.session) this.escalatingSessions.delete(entry.session);
      }
    }
  }

  async #run(entry) {
    if (entry.task) return await entry.task;
    if (entry.page.isClosed?.()) {
      this.#release(entry);
      return true;
    }
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;

    const task = (async () => {
      for (let attempt = 0; attempt < this.maxAttempts && !entry.page.isClosed?.(); attempt++) {
        await Promise.resolve(this.closePage(entry.page, entry.session, entry.reason)).catch(() => {});
      }
      if (entry.page.isClosed?.()) return true;

      const proof = await this.#escalate(entry);
      entry.attempts += this.maxAttempts;
      return Boolean(entry.page.isClosed?.() || this.#proofMatches(entry, proof));
    })();

    entry.task = task;
    try {
      const completed = await task;
      if (completed) this.#release(entry);
      else this.#scheduleRetry(entry);
      return completed;
    } finally {
      if (entry.task === task) entry.task = null;
    }
  }

  async cleanup(session, page, reason = 'orphan_cleanup', {
    ownerEpoch = session?.browserGeneration ?? null,
  } = {}) {
    if (!page || page.isClosed?.()) {
      const existing = page ? this.owned.get(page) : null;
      if (existing) this.#release(existing);
      return true;
    }
    let entry = this.owned.get(page);
    if (!entry) {
      entry = {
        session,
        page,
        reason,
        ownerEpoch,
        attempts: 0,
        task: null,
        retryTimer: null,
        escalationRaw: null,
      };
      this.owned.set(page, entry);
    }
    return await this.#run(entry);
  }
}

export async function closeContextWithin(context, {
  timeoutMs,
  onTimeout = () => {},
} = {}) {
  if (!context) return true;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  let timer;
  const closeAttempt = Promise.resolve()
    .then(() => context.close())
    .then(() => ({ closed: true }), error => ({ closed: false, error }));
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ closed: false, timedOut: true }), boundedTimeoutMs);
  });
  const result = await Promise.race([closeAttempt, timeout]);
  clearTimeout(timer);
  if (result.closed) return true;
  onTimeout(result.error || new Error('context close timed out'));
  return false;
}

export async function closePageWithin(page, {
  timeoutMs,
  onTimeout = () => {},
} = {}) {
  if (!page || page.isClosed?.()) return true;
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
  if (result.closed) return true;
  onTimeout(result.error || new Error('page close timed out'));
  page.removeAllListeners?.();
  return false;
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

export async function awaitAbortableResource(resourcePromise, signal, cleanup, {
  waitOnAbortMs = 0,
} = {}) {
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
      const lateCleanup = source.then(cleanupOnce, () => {});
      if (Number.isFinite(waitOnAbortMs) && waitOnAbortMs > 0) {
        await settleWithin(lateCleanup, waitOnAbortMs).catch(() => {});
      } else {
        lateCleanup.catch(() => {});
      }
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
  let cleanupRawPromise = null;
  const currentAbortError = () => abortError(signal);
  const cleanupRawOnce = value => {
    if (!cleanupRawPromise) cleanupRawPromise = Promise.resolve().then(() => cleanup(value));
    cleanupRawPromise.catch(() => {});
    return cleanupRawPromise;
  };
  const cleanupWithinDeadline = value => settleWithin(cleanupRawOnce(value), cleanupTimeoutMs);
  const unregisterAfterOwnershipTransfer = async () => {
    if (!registered || !resource) return;
    const raw = cleanupRawOnce(resource);
    let timer;
    const bounded = Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0
      ? Promise.race([
        raw.then(value => ({ settled: true, value }), () => ({ settled: true, value: false })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), cleanupTimeoutMs); }),
      ])
      : raw.then(value => ({ settled: true, value }), () => ({ settled: true, value: false }));
    const result = await bounded;
    clearTimeout(timer);
    if (result.settled && result.value !== false) {
      await Promise.resolve(unregister(resource)).catch(() => {});
      registered = false;
      return;
    }
    if (!result.settled) {
      raw.then(async value => {
        if (value === false || !registered) return;
        await Promise.resolve(unregister(resource)).catch(() => {});
        registered = false;
      }, () => {});
    }
  };
  const onAbort = () => { cleanupRawOnce(resource).catch(() => {}); };

  try {
    if (signal?.aborted) throw currentAbortError();
    let creation;
    try {
      creation = create();
    } catch (error) {
      creation = Promise.reject(error);
    }
    resource = await awaitAbortableResource(creation, signal, cleanupWithinDeadline, {
      waitOnAbortMs: cleanupTimeoutMs,
    });
    registered = true;
    await register(resource);
    if (signal?.aborted) throw currentAbortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const operationPromise = Promise.resolve().then(() => operation(resource));
    const result = await raceWithAbort(operationPromise, signal);
    if (signal?.aborted) throw currentAbortError();
    return result;
  } catch (error) {
    await unregisterAfterOwnershipTransfer();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
