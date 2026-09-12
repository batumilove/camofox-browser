export class BrowserStopCoordinator {
  #inflight = null;

  isStopping() {
    return this.#inflight !== null;
  }

  assertLaunchAllowed(errorFactory = () => new Error('Browser is stopping')) {
    if (this.#inflight) throw errorFactory();
  }

  run(operation) {
    if (this.#inflight) return this.#inflight;

    // Defer the operation by one microtask so #inflight is published before
    // any stop work can yield or throw.
    const work = Promise.resolve().then(operation);
    let tracked;
    tracked = work.finally(() => {
      if (this.#inflight === tracked) this.#inflight = null;
    });
    this.#inflight = tracked;
    return tracked;
  }
}
