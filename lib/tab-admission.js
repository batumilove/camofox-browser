export class TabAdmissionError extends Error {
  constructor(message, { code, retryAfter = 2, statusCode = 429 } = {}) {
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
    maxActive = 4,
    maxActivePerUser = 2,
    maxAbandoned = maxActive,
    waitTimeoutMs = 30000,
    operationTimeoutMs = 30000,
    retryAfter = 2,
    onAbandonedSaturated = () => {},
  } = {}) {
    this.maxActive = positiveInteger(maxActive, 4);
    this.maxActivePerUser = positiveInteger(maxActivePerUser, 2);
    this.maxAbandoned = positiveInteger(maxAbandoned, this.maxActive);
    this.waitTimeoutMs = positiveInteger(waitTimeoutMs, 30000);
    this.operationTimeoutMs = positiveInteger(operationTimeoutMs, 30000);
    this.retryAfter = positiveInteger(retryAfter, 2);
    this.onAbandonedSaturated = onAbandonedSaturated;
    this.active = 0;
    this.activePerUser = new Map();
    this.abandoned = new Set();
    this.waiters = [];
    this.saturationReported = false;
  }

  snapshot() {
    return {
      active: this.active,
      abandoned: this.abandoned.size,
      waiting: this.waiters.length,
    };
  }

  async run(userId, operation) {
    const key = String(userId);
    const release = await this.#acquire(key);
    let operationPromise;
    try {
      operationPromise = Promise.resolve().then(operation);
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new TabAdmissionError(
          'Tab creation operation timed out',
          { code: 'tab_admission_operation_timeout', retryAfter: this.retryAfter },
        )), this.operationTimeoutMs);
        operationPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
      });
      return await Promise.race([operationPromise, timeout]);
    } catch (error) {
      if (error?.code === 'tab_admission_operation_timeout' && operationPromise) {
        this.#trackAbandoned(operationPromise);
      }
      throw error;
    } finally {
      release();
    }
  }

  #canStart(userId) {
    return this.abandoned.size < this.maxAbandoned
      && this.active < this.maxActive
      && (this.activePerUser.get(userId) || 0) < this.maxActivePerUser;
  }

  #reserve(userId) {
    this.active += 1;
    this.activePerUser.set(userId, (this.activePerUser.get(userId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const count = (this.activePerUser.get(userId) || 1) - 1;
      if (count > 0) this.activePerUser.set(userId, count);
      else this.activePerUser.delete(userId);
      this.#drain();
    };
  }

  #acquire(userId) {
    if (this.abandoned.size >= this.maxAbandoned) {
      this.#reportSaturation();
      return Promise.reject(new TabAdmissionError(
        'Abandoned tab creations saturated',
        { code: 'tab_admission_abandoned_saturated', retryAfter: this.retryAfter },
      ));
    }
    if (this.#canStart(userId)) return Promise.resolve(this.#reserve(userId));

    return new Promise((resolve, reject) => {
      const waiter = { userId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new TabAdmissionError(
          'Tab admission wait timed out',
          { code: 'tab_admission_wait_timeout', retryAfter: this.retryAfter },
        ));
      }, this.waitTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  #drain() {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (!this.#canStart(waiter.userId)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(this.#reserve(waiter.userId));
    }
  }

  #trackAbandoned(operationPromise) {
    const token = {};
    this.abandoned.add(token);
    if (this.abandoned.size >= this.maxAbandoned) this.#reportSaturation();
    operationPromise.then(
      () => this.#settleAbandoned(token),
      () => this.#settleAbandoned(token),
    );
  }

  #settleAbandoned(token) {
    this.abandoned.delete(token);
    if (this.abandoned.size < this.maxAbandoned) this.saturationReported = false;
    this.#drain();
  }

  #reportSaturation() {
    if (this.saturationReported) return;
    this.saturationReported = true;
    this.onAbandonedSaturated(this.snapshot());
  }
}
