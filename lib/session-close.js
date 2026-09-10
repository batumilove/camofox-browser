function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function createSessionCloseCoordinator({ destroyingTimeoutMs = 5000 } = {}) {
  const inflight = new WeakMap();

  function close(session, {
    emitDestroying = async () => {},
    closeContext = () => session.context.close(),
    emitDestroyed = async () => {},
    onDestroyingError = () => {},
    onDestroyedError = () => {},
  } = {}) {
    const existing = inflight.get(session);
    if (existing) return existing;

    const promise = (async () => {
      try {
        await bounded(emitDestroying(), destroyingTimeoutMs);
      } catch (error) {
        onDestroyingError(error);
      }
      try {
        await closeContext();
      } finally {
        try {
          await emitDestroyed();
        } catch (error) {
          onDestroyedError(error);
        }
      }
    })();
    inflight.set(session, promise);
    promise.then(
      () => inflight.delete(session),
      () => inflight.delete(session),
    );
    return promise;
  }

  return { close };
}
