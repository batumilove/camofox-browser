function abortReason(signal, fallback = 'Session creation aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function raceWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve(promise), aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

export class SessionCreationCoordinator {
  constructor({
    maxInflight,
    maxResetBarriers = 8,
    settleTimeoutMs,
    escalationTimeoutMs,
    disposeLate = async () => {},
    onEscalate = async () => ({ terminated: false }),
    onInternalError = () => {},
  }) {
    this.maxInflight = Number.isInteger(maxInflight) && maxInflight > 0 ? maxInflight : 1;
    this.maxResetBarriers = Number.isInteger(maxResetBarriers) && maxResetBarriers > 0
      ? maxResetBarriers
      : 1;
    this.settleTimeoutMs = Number.isFinite(settleTimeoutMs) && settleTimeoutMs > 0
      ? settleTimeoutMs
      : 5000;
    this.escalationTimeoutMs = Number.isFinite(escalationTimeoutMs) && escalationTimeoutMs > 0
      ? escalationTimeoutMs
      : this.settleTimeoutMs;
    this.disposeLate = disposeLate;
    this.onEscalate = onEscalate;
    this.onInternalError = onInternalError;
    this.tokens = new Map();
    this.entries = new Map();
    this.resets = new Set();
    this.nextToken = 0;
    this.shutdownReason = null;
    this.barrierReason = null;
  }

  #newToken(key) {
    const token = ++this.nextToken;
    this.tokens.set(key, token);
    return token;
  }

  #report(error, fields) {
    try { this.onInternalError(error, fields); } catch { /* observer must not break lifecycle */ }
  }

  #applyEscalationProof(entry, proof) {
    const proofMatchesOwner = entry.ownerEpoch !== null
      && proof?.ownerEpoch === entry.ownerEpoch;
    if (proof?.terminated === true && proofMatchesOwner) {
      entry.terminal = true;
      if (entry.escalationRetryTimer) clearTimeout(entry.escalationRetryTimer);
      entry.escalationRetryTimer = null;
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      if (this.tokens.get(entry.key) === entry.invalidationToken) this.tokens.delete(entry.key);
      return true;
    }
    if (proof?.terminated === true) {
      this.#report(new Error('Termination proof did not match session creation owner epoch'), {
        key: entry.key,
        generation: entry.generation,
        ownerEpoch: entry.ownerEpoch,
        proofOwnerEpoch: proof?.ownerEpoch ?? null,
        phase: 'escalation_proof_mismatch',
      });
    }
    return false;
  }

  async #escalateWithin(entry, reason) {
    if (!entry.escalationRaw) {
      const controller = new AbortController();
      const holder = { controller, timedOut: false, promise: null };
      holder.promise = Promise.resolve()
        .then(() => this.onEscalate(entry, reason, { signal: controller.signal }))
        .then(proof => {
          if (holder.timedOut) this.#applyEscalationProof(entry, proof);
          return proof;
        }, error => {
          this.#report(error, { key: entry.key, generation: entry.generation, phase: 'escalation' });
          return null;
        })
        .finally(() => {
          if (entry.escalationRaw === holder) entry.escalationRaw = null;
          if (!entry.terminal && !entry.settled && this.entries.get(entry.key) === entry) {
            entry.escalated = false;
            this.#scheduleEscalationRetry(entry, reason);
          }
        });
      entry.escalationRaw = holder;
    }

    const holder = entry.escalationRaw;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        holder.timedOut = true;
        holder.controller.abort(new Error('Session creation escalation timed out'));
        resolve(null);
      }, this.escalationTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([holder.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #scheduleEscalationRetry(entry, reason) {
    if (entry.escalationRetryTimer || entry.settled || this.entries.get(entry.key) !== entry) return;
    entry.escalationRetryTimer = setTimeout(() => {
      entry.escalationRetryTimer = null;
      if (entry.settled || this.entries.get(entry.key) !== entry) return;
      void this.invalidate(entry.key, reason).catch(error => {
        this.#report(error, { key: entry.key, generation: entry.generation, phase: 'escalation_retry' });
      });
    }, this.settleTimeoutMs);
    entry.escalationRetryTimer.unref?.();
  }

  has(key) {
    return this.entries.has(String(key));
  }

  isResetting(key) {
    return this.resets.has(String(key));
  }

  snapshot() {
    let waiters = 0;
    for (const entry of this.entries.values()) waiters += entry.waiters.size;
    return {
      inflight: this.entries.size,
      lifecycleKeys: this.tokens.size,
      resetting: this.resets.size,
      waiters,
    };
  }

  isCurrent(key, token) {
    return this.tokens.get(String(key)) === token;
  }

  release(key, expectedToken) {
    const normalized = String(key);
    if (this.entries.has(normalized) || this.resets.has(normalized)) return false;
    if (expectedToken !== undefined && this.tokens.get(normalized) !== expectedToken) return false;
    return this.tokens.delete(normalized);
  }

  async getOrCreate(key, factory, { signal } = {}) {
    const normalized = String(key);
    if (signal?.aborted) throw abortReason(signal);
    if (this.shutdownReason) throw this.shutdownReason;
    if (this.barrierReason) throw this.barrierReason;
    if (this.resets.has(normalized)) {
      throw Object.assign(new Error('Session reset is in progress'), {
        statusCode: 409,
        code: 'session_reset_in_progress',
        retryable: true,
      });
    }

    let entry = this.entries.get(normalized);
    if (!entry) {
      if (this.entries.size >= this.maxInflight) {
        throw Object.assign(new Error('Maximum in-flight session creations reached'), {
          statusCode: 503,
          code: 'session_creation_capacity',
          retryable: true,
        });
      }

      const token = this.#newToken(normalized);
      const controller = new AbortController();
      entry = {
        key: normalized,
        generation: token,
        controller,
        invalidReason: null,
        escalated: false,
        escalationRetryTimer: null,
        escalationRaw: null,
        settled: false,
        terminal: false,
        succeeded: false,
        promise: null,
        settlement: null,
        waiters: new Set(),
        ownerEpoch: null,
        invalidationToken: null,
      };
      const assertCurrent = () => {
        if (controller.signal.aborted || !this.isCurrent(normalized, token) || this.resets.has(normalized)) {
          throw entry.invalidReason || abortReason(controller.signal, 'Session creation invalidated');
        }
      };
      const raw = Promise.resolve().then(() => factory({
        key: normalized,
        generation: token,
        signal: controller.signal,
        assertCurrent,
        bindOwner: ownerEpoch => { entry.ownerEpoch = ownerEpoch; },
      }));
      const tracked = raw.then(async (value) => {
        if (controller.signal.aborted || !this.isCurrent(normalized, token) || this.resets.has(normalized)) {
          await this.disposeLate(value, entry);
          throw entry.invalidReason || abortReason(controller.signal, 'Session creation invalidated');
        }
        entry.succeeded = true;
        return value;
      });
      const sharedAbort = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(entry.invalidReason || abortReason(controller.signal));
        }, { once: true });
      });
      entry.promise = Promise.race([tracked, sharedAbort]);
      entry.settlement = tracked.then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      ).finally(() => {
        entry.settled = true;
        if (entry.escalationRetryTimer) clearTimeout(entry.escalationRetryTimer);
        entry.escalationRetryTimer = null;
        if (this.entries.get(normalized) === entry) this.entries.delete(normalized);
        const cleanupToken = entry.invalidationToken ?? token;
        if (!entry.succeeded && this.tokens.get(normalized) === cleanupToken && !this.resets.has(normalized)) {
          this.tokens.delete(normalized);
        }
      });
      this.entries.set(normalized, entry);
    }

    const waiter = Symbol(normalized);
    entry.waiters.add(waiter);
    try {
      return await raceWithSignal(entry.promise, signal);
    } finally {
      entry.waiters.delete(waiter);
      if (!entry.settled && !entry.succeeded && !entry.controller.signal.aborted && entry.waiters.size === 0) {
        const reason = Object.assign(new Error('All session creation waiters departed'), {
          code: 'session_creation_abandoned',
        });
        void this.invalidate(normalized, reason).catch(error => {
          this.#report(error, { key: normalized, phase: 'all_waiters_abort' });
        });
      }
    }
  }

  async invalidate(key, reason = Object.assign(new Error('Session invalidated'), { code: 'session_invalidated' })) {
    const normalized = String(key);
    const entry = this.entries.get(normalized);
    const currentToken = this.tokens.get(normalized);
    if (!entry && currentToken === undefined) return true;

    if (currentToken !== undefined) {
      const invalidationToken = this.#newToken(normalized);
      if (entry) entry.invalidationToken = invalidationToken;
    }
    if (!entry) return true;

    entry.invalidReason = reason;
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);

    let timer;
    const settled = entry.settlement.then(() => true);
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), this.settleTimeoutMs);
    });
    const completed = await Promise.race([settled, deadline]);
    clearTimeout(timer);
    if (!completed && !entry.escalated) {
      entry.escalated = true;
      const proof = await this.#escalateWithin(entry, reason);
      if (!entry.terminal && !this.#applyEscalationProof(entry, proof)) {
        // A failed, timed-out, or mismatched escalation keeps ownership and
        // schedules another bounded attempt until raw settlement or valid proof.
        entry.escalated = false;
        this.#scheduleEscalationRetry(entry, reason);
      }
    }
    return completed;
  }

  async reset(key, {
    reason = 'session_reset',
    whileBlocked = async () => {},
  } = {}) {
    const normalized = String(key);
    if (this.resets.has(normalized)) {
      throw Object.assign(new Error('Session reset is already in progress'), {
        statusCode: 409,
        code: 'session_reset_in_progress',
        retryable: true,
      });
    }
    if (this.resets.size >= this.maxResetBarriers) {
      throw Object.assign(new Error('Maximum concurrent session resets reached'), {
        statusCode: 503,
        code: 'session_lifecycle_capacity',
        retryable: true,
      });
    }

    this.resets.add(normalized);
    const hadCreation = this.entries.has(normalized);
    try {
      const invalidationReason = Object.assign(new Error(`Session reset: ${reason}`), {
        statusCode: 409,
        code: 'session_reset_in_progress',
        retryable: true,
      });
      await this.invalidate(normalized, invalidationReason);
      if (this.entries.has(normalized)) {
        throw Object.assign(new Error('Session creation did not terminate during reset'), {
          statusCode: 503,
          code: 'session_reset_incomplete',
          retryable: true,
        });
      }
      return await whileBlocked({ key: normalized, hadCreation });
    } finally {
      this.resets.delete(normalized);
      if (!this.entries.has(normalized)) this.tokens.delete(normalized);
    }
  }

  async barrier(reason = Object.assign(new Error('Session creation is temporarily blocked'), {
    code: 'session_creation_blocked',
    statusCode: 503,
    retryable: true,
  }), whileBlocked = async () => {}) {
    if (this.shutdownReason) throw this.shutdownReason;
    if (this.barrierReason) throw this.barrierReason;
    const barrierReason = reason instanceof Error ? reason : new Error(String(reason));
    this.barrierReason = barrierReason;
    try {
      const keys = Array.from(this.entries.keys());
      await Promise.all(keys.map(key => this.invalidate(key, barrierReason)));
      if (this.entries.size > 0) {
        throw Object.assign(new Error('Session creations did not terminate during lifecycle barrier'), {
          code: 'session_creation_barrier_incomplete',
          statusCode: 503,
          retryable: true,
        });
      }
      return await whileBlocked();
    } finally {
      this.barrierReason = null;
    }
  }

  async shutdown(reason = Object.assign(new Error('Server is shutting down'), {
    code: 'server_shutting_down',
    statusCode: 503,
    retryable: true,
  })) {
    if (!this.shutdownReason) {
      this.shutdownReason = reason instanceof Error ? reason : new Error(String(reason));
    }
    const shutdownReason = this.shutdownReason;
    const keys = Array.from(this.entries.keys());
    await Promise.all(keys.map(key => this.invalidate(key, shutdownReason)));
  }
}
