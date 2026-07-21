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
  cleanupLatePage = async () => {},
}) {
  const createPage = async (activeSession, label) => {
    const lease = acquirePageLease(activeSession);
    const releasePendingCreation = reservePendingCreation(activeSession);
    const signal = releasePendingCreation?.signal;
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
    const pagePromise = Promise.resolve()
      .then(() => activeSession.context.newPage())
      .then(page => setLeasedPage(lease, page));

    const settlement = pagePromise.then(async (page) => {
      resolvedPage = page;
      if (!abandoned || adopted) return;
      try {
        await cleanupOnce(page);
      } finally {
        releasePendingCreation();
      }
    }, () => {
      releasePageLease(activeSession, lease);
      releasePendingCreation();
    });
    settlement.catch(() => {});

    let onAbort;
    const guardedPagePromise = signal
      ? Promise.race([
        pagePromise,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Session evicted'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]).finally(() => signal.removeEventListener('abort', onAbort))
      : pagePromise;

    try {
      const page = await withTimeout(guardedPagePromise, timeoutMs, label);
      if (signal?.aborted) throw signal.reason;
      adopted = true;
      releasePendingCreation();
      return { page, lease };
    } catch (error) {
      abandoned = true;
      if (resolvedPage && !adopted) {
        await cleanupOnce(resolvedPage).catch(() => {});
        releasePendingCreation();
      }
      throw error;
    }
  };

  try {
    const created = await createPage(session, 'new page');
    return { session, page: created.page, lease: created.lease };
  } catch (err) {
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    log('warn', 'new page failed, recreating user session', {
      userId,
      error: err.message,
    });

    // Another request may already have replaced this session. Never tear down
    // a newer healthy context while recovering the one that failed.
    if (currentSession() === session) {
      await destroySession(userId, { reason: 'new_page_unresponsive' });
    }

    session = await getSession(userId, { trace });
    const created = await createPage(session, 'new page retry');
    return { session, page: created.page, lease: created.lease };
  }
}
