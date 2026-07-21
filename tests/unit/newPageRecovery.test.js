import { describe, expect, jest, test } from '@jest/globals';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';
import { abortPendingTabCreations, reservePendingTabCreation } from '../../lib/tab-admission.js';

const isTimeoutError = err => err.code === 'timeout';
const isDeadContextError = err => err.code === 'dead_context';
const withTimeout = promise => promise;
const log = jest.fn();

function recoveryOptions(overrides) {
  return {
    userId: 'user-1',
    trace: false,
    timeoutMs: 10000,
    withTimeout,
    isTimeoutError,
    isDeadContextError,
    log,
    ...overrides,
  };
}

describe('createPageWithSessionRecovery', () => {
  test('replaces an unresponsive session and succeeds on one retry', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue(page) } };
    let mappedSession = oldSession;
    const destroySession = jest.fn(async () => { mappedSession = null; });
    const getSession = jest.fn(async () => replacement);

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => mappedSession,
      destroySession,
      getSession,
    }));

    expect(destroySession).toHaveBeenCalledWith('user-1', {
      reason: 'new_page_unresponsive',
      expectedSession: oldSession,
    });
    expect(getSession).toHaveBeenCalledWith('user-1', { trace: false });
    expect(result).toMatchObject({ session: replacement, page });
    expect(result.lease).toMatchObject({ page, released: false });
  });

  test('does not destroy a session another request already replaced', async () => {
    const deadError = Object.assign(new Error('context closed'), { code: 'dead_context' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(deadError) } };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue({ id: 'page' }) } };
    const destroySession = jest.fn();

    await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => replacement,
      destroySession,
      getSession: async () => replacement,
    }));

    expect(destroySession).not.toHaveBeenCalled();
  });

  test('retries only once', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const replacement = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
    }))).rejects.toThrow('new page timed out');

    expect(oldSession.context.newPage).toHaveBeenCalledTimes(1);
    expect(replacement.context.newPage).toHaveBeenCalledTimes(1);
  });

  test('reserves each session while its new-page attempt is pending', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { id: 'old', context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { id: 'replacement', context: { newPage: jest.fn().mockResolvedValue(page) } };
    const releases = [];
    const reservePendingCreation = jest.fn(() => {
      const release = jest.fn();
      releases.push(release);
      return release;
    });

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
      reservePendingCreation,
    }));

    expect(result).toEqual({ session: replacement, page });
    expect(reservePendingCreation.mock.calls.map(([session]) => session.id)).toEqual(['old', 'replacement']);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  test('keeps the original reservation until a timed-out late page is closed', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    let resolveOldPage;
    let finishCleanup;
    const oldPagePromise = new Promise(resolve => { resolveOldPage = resolve; });
    const cleanupGate = new Promise(resolve => { finishCleanup = resolve; });
    const oldSession = { id: 'old', context: { newPage: jest.fn(() => oldPagePromise) } };
    const page = { id: 'fresh-page' };
    const latePage = { id: 'late-page' };
    const replacement = { id: 'replacement', context: { newPage: jest.fn().mockResolvedValue(page) } };
    const releases = new Map();
    const rawReleases = new Map();
    const reservePendingCreation = jest.fn(session => {
      const release = jest.fn();
      releases.set(session.id, release);
      return release;
    });
    const reserveRawCreation = jest.fn(session => {
      const lease = { settle: jest.fn() };
      rawReleases.set(session.id, lease.settle);
      return lease;
    });
    const cleanupLatePage = jest.fn(() => cleanupGate);

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      withTimeout: (promise, _timeoutMs, label) => label === 'new page'
        ? Promise.reject(timeoutError)
        : promise,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
      reservePendingCreation,
      reserveRawCreation,
      cleanupLatePage,
    }));

    expect(result).toEqual({ session: replacement, page });
    expect(releases.get('old')).not.toHaveBeenCalled();
    expect(releases.get('replacement')).toHaveBeenCalledTimes(1);
    expect(rawReleases.get('old')).not.toHaveBeenCalled();
    expect(rawReleases.get('replacement')).toHaveBeenCalledTimes(1);

    resolveOldPage(latePage);
    await oldPagePromise;
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupLatePage).toHaveBeenCalledWith(latePage);
    expect(releases.get('old')).not.toHaveBeenCalled();
    expect(rawReleases.get('old')).not.toHaveBeenCalled();

    finishCleanup();
    await cleanupGate;
    await new Promise(resolve => setImmediate(resolve));
    expect(releases.get('old')).toHaveBeenCalledTimes(1);
    expect(rawReleases.get('old')).toHaveBeenCalledTimes(1);
  });

  test('closes a retry page that resolves after the retry timed out', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    let resolveRetryPage;
    const retryPromise = new Promise(resolve => { resolveRetryPage = resolve; });
    const oldSession = { id: 'old', context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const replacement = { id: 'replacement', context: { newPage: jest.fn(() => retryPromise) } };
    const latePage = { id: 'late-retry-page' };
    const cleanupLatePage = jest.fn(async () => {});
    const releases = new Map();
    const reservePendingCreation = jest.fn(session => {
      const release = jest.fn();
      releases.set(session.id, release);
      return release;
    });

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      withTimeout: (promise, _timeoutMs, label) => label === 'new page retry'
        ? Promise.reject(timeoutError)
        : promise,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
      reservePendingCreation,
      cleanupLatePage,
    }))).rejects.toBe(timeoutError);

    expect(releases.get('replacement')).not.toHaveBeenCalled();
    resolveRetryPage(latePage);
    await retryPromise;
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupLatePage).toHaveBeenCalledWith(latePage);
    expect(releases.get('replacement')).toHaveBeenCalledTimes(1);
  });

  test('releases without cleanup when an abandoned raw attempt rejects late', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    let rejectOldPage;
    const oldPagePromise = new Promise((_, reject) => { rejectOldPage = reject; });
    const oldSession = { id: 'old', context: { newPage: jest.fn(() => oldPagePromise) } };
    const replacementPage = { id: 'replacement-page' };
    const replacement = { id: 'replacement', context: { newPage: jest.fn().mockResolvedValue(replacementPage) } };
    const cleanupLatePage = jest.fn(async () => {});
    const releases = new Map();
    const reservePendingCreation = jest.fn(activeSession => {
      const release = jest.fn();
      releases.set(activeSession.id, release);
      return release;
    });

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      withTimeout: (promise, _timeoutMs, label) => label === 'new page'
        ? Promise.reject(timeoutError)
        : promise,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
      reservePendingCreation,
      cleanupLatePage,
    }))).resolves.toEqual({ session: replacement, page: replacementPage });

    expect(releases.get('old')).not.toHaveBeenCalled();
    rejectOldPage(new Error('late context close'));
    await oldPagePromise.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupLatePage).not.toHaveBeenCalled();
    expect(releases.get('old')).toHaveBeenCalledTimes(1);
  });

  test('cleans rather than adopts when resolve and emergency abort occur in one turn', async () => {
    let resolvePage;
    const rawPage = new Promise(resolve => { resolvePage = resolve; });
    const session = { tabGroups: new Map(), context: { newPage: jest.fn(() => rawPage) } };
    const cleanupLatePage = jest.fn(async () => {});
    const reason = Object.assign(new Error('session evicted'), { code: 'session_evicted' });
    const result = createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession: jest.fn(),
      getSession: jest.fn(),
      reservePendingCreation: reservePendingTabCreation,
      cleanupLatePage,
    }));
    await Promise.resolve();

    const page = { id: 'adjacent-race-page' };
    resolvePage(page);
    abortPendingTabCreations(session, reason);
    await expect(result).rejects.toBe(reason);
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupLatePage).toHaveBeenCalledTimes(1);
    expect(cleanupLatePage).toHaveBeenCalledWith(page);
  });

  test('emergency session teardown aborts recovery and still closes a late page', async () => {
    let resolvePage;
    const rawPage = new Promise(resolve => { resolvePage = resolve; });
    const session = {
      tabGroups: new Map(),
      context: { newPage: jest.fn(() => rawPage) },
    };
    const reason = Object.assign(new Error('session evicted'), { code: 'session_evicted' });
    const cleanupLatePage = jest.fn(async () => {});
    const destroySession = jest.fn();
    const getSession = jest.fn();
    const result = createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession,
      reservePendingCreation: reservePendingTabCreation,
      cleanupLatePage,
    }));

    await Promise.resolve();
    expect(abortPendingTabCreations(session, reason)).toBe(1);
    await expect(result).rejects.toBe(reason);
    expect(destroySession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();

    const latePage = { id: 'late-after-eviction' };
    resolvePage(latePage);
    await rawPage;
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanupLatePage).toHaveBeenCalledWith(latePage);
  });

  test('does not recover unrelated failures', async () => {
    const error = new Error('programming error');
    const session = { context: { newPage: jest.fn().mockRejectedValue(error) } };
    const destroySession = jest.fn();

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession: jest.fn(),
    }))).rejects.toBe(error);

    expect(destroySession).not.toHaveBeenCalled();
  });
});
