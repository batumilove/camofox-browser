import { acquirePageLease, releasePageLease, setLeasedPage } from './page-lease.js';

export async function createPageWithSessionRecovery({
  userId,
  session,
  trace = false,
  timeoutMs,
  withTimeout,
  isTimeoutError,
  isDeadContextError,
  currentSession,
  destroySession,
  getSession,
  log,
  reservePendingCreation = () => () => {},
  reserveRawCreation = () => ({ settle: () => {} }),
  cleanupLatePage = async () => {},
  signal: requestSignal,
}) {
  const createPage = async (activeSession, label) => {
    if (requestSignal?.aborted) throw requestSignal.reason;
    const lease = acquirePageLease(activeSession);
    const releasePendingCreation = reservePendingCreation(activeSession);
    let rawLease;
    try {
      if (requestSignal?.aborted) throw requestSignal.reason;
      rawLease = reserveRawCreation(activeSession, label);
    } catch (error) {
      releasePageLease(activeSession, lease);
      releasePendingCreation();
      throw error;
    }
    const sessionSignal = releasePendingCreation?.signal;
    const settleOwnership = () => {
      rawLease?.settle?.();
      releasePendingCreation();
    };
    let resolvedPage;
    let adopted = false;
    let abandoned = false;
    let cleanupPromise = null;
    const cleanupOnce = (page) => {
      if (!cleanupPromise) {
        cleanupPromise = Promise.resolve()
          .then(() => cleanupLatePage(page))
          .finally(() => releasePageLease(activeSession, lease));
      }
      return cleanupPromise;
    };
    let pagePromise;
    try {
      if (requestSignal?.aborted) throw requestSignal.reason;
      if (sessionSignal?.aborted) throw sessionSignal.reason;
      pagePromise = Promise.resolve(activeSession.context.newPage())
        .then(page => setLeasedPage(lease, page));
    } catch (error) {
      releasePageLease(activeSession, lease);
      settleOwnership();
      throw error;
    }

    const settlement = pagePromise.then(async (page) => {
      resolvedPage = page;
      if (!abandoned || adopted) return;
      try {
        await cleanupOnce(page);
      } finally {
        settleOwnership();
      }
    }, () => {
      releasePageLease(activeSession, lease);
      settleOwnership();
    });
    settlement.catch(() => {});

    const abortSignals = [sessionSignal, requestSignal].filter(Boolean);
    const abortListeners = [];
    const abortPromises = abortSignals.map(signal => new Promise((_, reject) => {
      const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Session evicted'));
      abortListeners.push([signal, onAbort]);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }));
    const guardedPagePromise = abortPromises.length
      ? Promise.race([pagePromise, ...abortPromises]).finally(() => {
        for (const [signal, onAbort] of abortListeners) signal.removeEventListener('abort', onAbort);
      })
      : pagePromise;

    try {
      const page = await withTimeout(guardedPagePromise, timeoutMs, label);
      const abortedSignal = abortSignals.find(signal => signal.aborted);
      if (abortedSignal) throw abortedSignal.reason;
      adopted = true;
      settleOwnership();
      return { page, lease };
    } catch (error) {
      abandoned = true;
      if (resolvedPage && !adopted) {
        await cleanupOnce(resolvedPage).catch(() => {});
        settleOwnership();
      }
      throw error;
    }
  };

  try {
    const created = await createPage(session, 'new page');
    return { session, page: created.page, lease: created.lease };
  } catch (err) {
    if (requestSignal?.aborted) {
      if (currentSession() === session) {
        await destroySession(userId, { reason: 'tab_creation_aborted', expectedSession: session });
      }
      throw err;
    }
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    log('warn', 'new page failed, recreating user session', {
      userId,
      error: err.message,
    });

    if (currentSession() === session) {
      await destroySession(userId, { reason: 'new_page_unresponsive', expectedSession: session });
    }

    session = await getSession(userId, {
      trace,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
    const created = await createPage(session, 'new page retry');
    return { session, page: created.page, lease: created.lease };
  }
}
