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
    this.disposeLate = disposeLate;
    this.onEscalate = onEscalate;
    this.onInternalError = onInternalError;
    this.tokens = new Map();
    this.entries = new Map();
    this.resets = new Set();
    this.nextToken = 0;
  }

  #newToken(key) {
    const token = ++this.nextToken;
    this.tokens.set(key, token);
    return token;
  }

  #report(error, fields) {
    try { this.onInternalError(error, fields); } catch { /* observer must not break lifecycle */ }
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
        settled: false,
        terminal: false,
        succeeded: false,
        promise: null,
        settlement: null,
        waiters: new Set(),
        ownerEpoch: null,
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
        if (this.entries.get(normalized) === entry) this.entries.delete(normalized);
        if (!entry.succeeded && this.tokens.get(normalized) === token && !this.resets.has(normalized)) {
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

    if (currentToken !== undefined) this.#newToken(normalized);
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
      let proof = null;
      try {
        proof = await this.onEscalate(entry, reason);
      } catch (error) {
        this.#report(error, { key: normalized, generation: entry.generation, phase: 'escalation' });
      }
      if (proof?.terminated === true) {
        entry.terminal = true;
        if (this.entries.get(normalized) === entry) this.entries.delete(normalized);
        if (this.tokens.get(normalized) === entry.generation || entry.controller.signal.aborted) {
          this.tokens.delete(normalized);
        }
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
}
