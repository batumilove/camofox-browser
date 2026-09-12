export class TabAdmissionError extends Error {
  constructor(message, { code, retryAfter = 2, statusCode = 429 } = {}) {
    super(message);
    this.name = 'TabAdmissionError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTabAdmissionShutdownError(retryAfter = 2) {
  return new TabAdmissionError(
    'Tab admission is shutting down',
    { code: 'tab_admission_shutting_down', retryAfter, statusCode: 503 },
  );
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class TabAdmissionController {
  constructor({
    maxActive = 4,
    maxActivePerUser = 2,
    maxAbandoned = maxActive,
    maxWaiting = 32,
    maxWaitingPerUser = 8,
    waitTimeoutMs = 30000,
    operationTimeoutMs = 30000,
    retryAfter = 2,
    onAbandonedSaturated = () => {},
  } = {}) {
    this.maxActive = positiveInteger(maxActive, 4);
    this.maxActivePerUser = positiveInteger(maxActivePerUser, 2);
    this.maxAbandoned = positiveInteger(maxAbandoned, this.maxActive);
    this.maxWaiting = positiveInteger(maxWaiting, 32);
    this.maxWaitingPerUser = positiveInteger(maxWaitingPerUser, 8);
    this.waitTimeoutMs = positiveInteger(waitTimeoutMs, 30000);
    this.operationTimeoutMs = positiveInteger(operationTimeoutMs, 30000);
    this.retryAfter = positiveInteger(retryAfter, 2);
    this.onAbandonedSaturated = onAbandonedSaturated;
    this.active = 0;
    this.activePerUser = new Map();
    this.abandoned = new Set();
    this.waiters = [];
    this.saturationReported = false;
    this.closed = false;
    this.settleWaiters = new Set();
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
    const controller = new AbortController();
    let operationPromise;
    try {
      operationPromise = Promise.resolve().then(() => operation({ signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const error = new TabAdmissionError(
            'Tab creation operation timed out',
            { code: 'tab_admission_operation_timeout', retryAfter: this.retryAfter },
          );
          controller.abort(error);
          reject(error);
        }, this.operationTimeoutMs);
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

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(createTabAdmissionShutdownError(this.retryAfter));
    }
    this.#notifySettled();
  }

  waitForSettled() {
    if (this.#isSettled()) return Promise.resolve();
    return new Promise(resolve => this.settleWaiters.add(resolve));
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
      this.#notifySettled();
    };
  }

  #acquire(userId) {
    if (this.closed) {
      return Promise.reject(createTabAdmissionShutdownError(this.retryAfter));
    }
    if (this.abandoned.size >= this.maxAbandoned) {
      this.#reportSaturation();
      return Promise.reject(new TabAdmissionError(
        'Abandoned tab creations saturated',
        { code: 'tab_admission_abandoned_saturated', retryAfter: this.retryAfter },
      ));
    }
    if (this.#canStart(userId)) return Promise.resolve(this.#reserve(userId));

    const userWaiting = this.waiters.reduce(
      (count, waiter) => count + (waiter.userId === userId ? 1 : 0),
      0,
    );
    if (this.waiters.length >= this.maxWaiting || userWaiting >= this.maxWaitingPerUser) {
      return Promise.reject(new TabAdmissionError(
        'Tab admission waiting queue saturated',
        { code: 'tab_admission_wait_saturated', retryAfter: this.retryAfter },
      ));
    }

    return new Promise((resolve, reject) => {
      const waiter = { userId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new TabAdmissionError(
          'Tab admission wait timed out',
          { code: 'tab_admission_wait_timeout', retryAfter: this.retryAfter },
        ));
        this.#notifySettled();
      }, this.waitTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  #drain() {
    if (this.closed) return;
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
    this.#notifySettled();
  }

  #isSettled() {
    return this.active === 0 && this.abandoned.size === 0 && this.waiters.length === 0;
  }

  #notifySettled() {
    if (!this.#isSettled()) return;
    for (const resolve of this.settleWaiters) resolve();
    this.settleWaiters.clear();
  }

  #reportSaturation() {
    if (this.saturationReported) return;
    this.saturationReported = true;
    this.onAbandonedSaturated(this.snapshot());
  }
}
