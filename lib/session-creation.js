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
    settleTimeoutMs,
    disposeLate = async () => {},
    onEscalate = async () => {},
  }) {
    this.maxInflight = Number.isInteger(maxInflight) && maxInflight > 0 ? maxInflight : 1;
    this.settleTimeoutMs = Number.isFinite(settleTimeoutMs) && settleTimeoutMs > 0
      ? settleTimeoutMs
      : 5000;
    this.disposeLate = disposeLate;
    this.onEscalate = onEscalate;
    this.generations = new Map();
    this.entries = new Map();
  }

  #generation(key) {
    if (!this.generations.has(key)) this.generations.set(key, 0);
    return this.generations.get(key);
  }

  has(key) {
    return this.entries.has(String(key));
  }

  snapshot() {
    return {
      inflight: this.entries.size,
      generations: Object.fromEntries(this.generations),
    };
  }

  isCurrent(key, generation) {
    const normalized = String(key);
    return this.#generation(normalized) === generation;
  }

  async getOrCreate(key, factory, { signal } = {}) {
    const normalized = String(key);
    const generation = this.#generation(normalized);
    if (signal?.aborted) throw abortReason(signal);

    let entry = this.entries.get(normalized);
    if (!entry) {
      if (this.entries.size >= this.maxInflight) {
        throw Object.assign(new Error('Maximum in-flight session creations reached'), {
          statusCode: 503,
          code: 'session_creation_capacity',
        });
      }

      const controller = new AbortController();
      entry = {
        key: normalized,
        generation,
        controller,
        invalidReason: null,
        escalated: false,
        settled: false,
        promise: null,
        settlement: null,
      };
      const assertCurrent = () => {
        if (controller.signal.aborted || !this.isCurrent(normalized, generation)) {
          throw entry.invalidReason || abortReason(controller.signal, 'Session creation invalidated');
        }
      };
      const raw = Promise.resolve().then(() => factory({
        key: normalized,
        generation,
        signal: controller.signal,
        assertCurrent,
      }));
      const tracked = raw.then(async (value) => {
        if (controller.signal.aborted || !this.isCurrent(normalized, generation)) {
          await this.disposeLate(value, entry);
          throw entry.invalidReason || abortReason(controller.signal, 'Session creation invalidated');
        }
        return value;
      });
      entry.settlement = tracked.then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      ).finally(() => {
        entry.settled = true;
        if (this.entries.get(normalized) === entry) this.entries.delete(normalized);
      });
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(entry.invalidReason || abortReason(controller.signal));
        }, { once: true });
      });
      entry.promise = Promise.race([tracked, aborted]);
      // The settlement observer owns late rejection handling even after callers abort.
      entry.settlement.catch(() => {});
      this.entries.set(normalized, entry);
    }

    let onCallerAbort;
    if (signal) {
      onCallerAbort = () => { void this.invalidate(normalized, abortReason(signal)); };
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      return await raceWithSignal(entry.promise, signal);
    } finally {
      if (onCallerAbort) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  async invalidate(key, reason = Object.assign(new Error('Session invalidated'), { code: 'session_invalidated' })) {
    const normalized = String(key);
    this.generations.set(normalized, this.#generation(normalized) + 1);
    const entry = this.entries.get(normalized);
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
      await this.onEscalate(entry, reason);
    }
    return completed;
  }
}
