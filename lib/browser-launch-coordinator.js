export class BrowserLaunchCoordinator {
  constructor({
    launch,
    publish,
    discard,
    timeoutMs,
    timeoutError,
    onDiscardError = () => {},
  }) {
    this.launch = launch;
    this.publish = publish;
    this.discard = discard;
    this.timeoutMs = timeoutMs;
    this.timeoutError = timeoutError;
    this.onDiscardError = onDiscardError;
    this.current = null;
    this.generation = 0;
  }

  get inFlight() {
    return this.current !== null;
  }

  invalidate(error = new Error('Browser launch invalidated')) {
    const current = this.current;
    if (!current) return;
    current.token.active = false;
    current.rejectInvalidation(error);
    if (this.current === current) this.current = null;
  }

  ensure() {
    if (this.current) return this.current.promise;

    const token = {
      generation: ++this.generation,
      active: true,
      discardStarted: false,
    };
    let launchPromise;
    try {
      launchPromise = Promise.resolve(this.launch(token));
    } catch (error) {
      launchPromise = Promise.reject(error);
    }
    let timeoutId = null;
    let rejectTimeout;
    const timeoutMs = this.timeoutMs();
    const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
    let rejectInvalidation;
    const invalidationPromise = new Promise((_, reject) => { rejectInvalidation = reject; });

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        token.active = false;
        rejectTimeout(this.timeoutError(timeoutMs));
      }, timeoutMs);
    }

    // Observe the underlying launch independently of the caller-facing timeout.
    // A candidate that settles after its generation was invalidated is owned by
    // that generation and must be discarded without touching newer state.
    launchPromise.then(
      (candidate) => {
        if (!token.active) void this.#discardOnce(candidate, token);
      },
      () => {},
    );

    const promise = (async () => {
      let candidate = null;
      let published = false;
      try {
        candidate = timeoutId
          ? await Promise.race([launchPromise, timeoutPromise, invalidationPromise])
          : await Promise.race([launchPromise, invalidationPromise]);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (!token.active || this.current?.token !== token) {
          await this.#discardOnce(candidate, token);
          throw new Error(`Browser launch generation ${token.generation} is no longer current`);
        }

        const result = await this.publish(candidate, token);
        published = true;
        return result;
      } catch (error) {
        token.active = false;
        if (candidate && !published) await this.#discardOnce(candidate, token);
        throw error;
      } finally {
        token.active = false;
        if (timeoutId) clearTimeout(timeoutId);
        if (this.current?.token === token) this.current = null;
      }
    })();

    this.current = { token, promise, rejectInvalidation };
    return promise;
  }

  async #discardOnce(candidate, token) {
    if (token.discardStarted) return;
    token.discardStarted = true;
    try {
      await this.discard(candidate, token);
    } catch (error) {
      this.onDiscardError(error, candidate, token);
    }
  }
}
