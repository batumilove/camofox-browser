function asAbortError(signal, fallback = 'Resource creation aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function composeSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return { signal: null, cleanup: () => {} };
  if (active.length === 1) return { signal: active[0], cleanup: () => {} };
  const controller = new AbortController();
  const listeners = [];
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(asAbortError(signal));
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(asAbortError(signal));
    };
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

export async function createOwnedResource({
  target,
  method,
  options,
  signals = [],
  timeoutMs,
  acquire = () => ({ settle: () => {}, retire: () => {} }),
  validate = () => {},
  adopt = resource => resource,
  cleanup = async () => {},
  onDeadline = async () => {},
  label = 'resource creation',
}) {
  const composed = composeSignals(signals);
  const { signal } = composed;
  if (signal?.aborted) {
    composed.cleanup();
    throw asAbortError(signal);
  }

  const lease = acquire();
  let leaseSettled = false;
  const settleLease = () => {
    if (leaseSettled) return;
    leaseSettled = true;
    lease.settle?.();
  };
  let resource;
  let adopted = false;
  let cleanupPromise = null;
  const cleanupOnce = value => {
    if (!cleanupPromise) cleanupPromise = Promise.resolve(cleanup(value));
    return cleanupPromise;
  };
  let raw;
  try {
    if (signal?.aborted) throw asAbortError(signal);
    const creator = target?.[method];
    if (typeof creator !== 'function') throw new TypeError(`Unsupported resource creation method: ${method}`);
    raw = Promise.resolve(creator.call(target, options));
  } catch (error) {
    settleLease();
    composed.cleanup();
    throw error;
  }

  let abandoned = false;
  const settlement = raw.then(async (value) => {
    resource = value;
    if (abandoned && !adopted) {
      try { await cleanupOnce(value); } finally { settleLease(); }
    }
    return value;
  }, (error) => {
    settleLease();
    throw error;
  });
  // Always observe the raw settlement even after the caller times out or aborts.
  settlement.catch(() => {});

  let timer;
  let abortListener;
  const racers = [settlement];
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  if (boundedTimeout > 0) {
    racers.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), {
        code: 'resource_creation_timeout',
      })), boundedTimeout);
    }));
  }
  if (signal) {
    racers.push(new Promise((_, reject) => {
      abortListener = () => reject(asAbortError(signal));
      signal.addEventListener('abort', abortListener, { once: true });
    }));
  }

  try {
    const value = await Promise.race(racers);
    if (signal?.aborted) throw asAbortError(signal);
    await validate(value);
    if (signal?.aborted) throw asAbortError(signal);
    // The unresolved-creation lease ends once the raw resource is validated.
    // Managed/temporary lifetime capacity is held separately by the caller.
    settleLease();
    const result = await adopt(value);
    if (signal?.aborted) throw asAbortError(signal);
    adopted = true;
    return result;
  } catch (error) {
    abandoned = true;
    if (resource && !adopted) {
      try { await cleanupOnce(resource); } finally { settleLease(); }
    }
    if (!resource) {
      Promise.resolve(onDeadline(error, lease)).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    composed.cleanup();
  }
}

export async function withTemporaryResource(options, operation) {
  let cleaned = false;
  const cleanup = options.cleanup || (async () => {});
  return createOwnedResource({
    ...options,
    cleanup: async resource => {
      if (cleaned) return;
      cleaned = true;
      await cleanup(resource);
    },
    adopt: async resource => {
      try {
        return await operation(resource);
      } finally {
        if (!cleaned) {
          cleaned = true;
          await cleanup(resource);
        }
      }
    },
  });
}
