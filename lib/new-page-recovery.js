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
}) {
  const createPage = (activeSession, label) => {
    const lease = acquirePageLease(activeSession);
    const releasePendingCreation = reservePendingCreation(activeSession);
    const pagePromise = Promise.resolve()
      .then(() => activeSession.context.newPage())
      .then(page => setLeasedPage(lease, page));
    // A timeout does not necessarily settle the underlying newPage promise.
    // Keep the pending reservation until the real attempt resolves or rejects.
    pagePromise.then(releasePendingCreation, releasePendingCreation);
    return { lease, promise: withTimeout(pagePromise, timeoutMs, label) };
  };

  let attempt = createPage(session, 'new page');
  try {
    const page = await attempt.promise;
    return { session, page, lease: attempt.lease };
  } catch (err) {
    // The pending reservation remains until raw settlement; the page lease is
    // redundant once recovery starts and must not remain pinned indefinitely.
    releasePageLease(session, attempt.lease);
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
    attempt = createPage(session, 'new page retry');
    try {
      const page = await attempt.promise;
      return { session, page, lease: attempt.lease };
    } catch (retryErr) {
      releasePageLease(session, attempt.lease);
      throw retryErr;
    }
  }
}
