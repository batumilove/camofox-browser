import { collectUserDiagnostics } from '../../lib/user-diagnostics.js';

function tabState(overrides = {}) {
  return {
    toolCalls: 4,
    consecutiveTimeouts: 1,
    consecutiveFailures: 2,
    lastRequestedUrl: 'https://must-not-leak.invalid/order/99',
    ...overrides,
  };
}

function session(groups, overrides = {}) {
  return {
    tabGroups: new Map(groups),
    lastAccess: 1_000,
    _pendingTabCreations: 0,
    ...overrides,
  };
}

describe('collectUserDiagnostics', () => {
  test('returns only the requested user identifiers and omits page content', () => {
    const sessions = new Map([
      ['user-a', session([['session-a', new Map([['tab-a', tabState()]])]])],
      ['user-b', session([['secret-session-b', new Map([['secret-tab-b', tabState()]])]])],
    ]);
    const tabLocks = new Map([
      ['tab-a', { active: true, queue: [{}, {}] }],
      ['secret-tab-b', { active: true, queue: [{}] }],
    ]);
    const result = collectUserDiagnostics({
      userId: 'user-a',
      now: 2_000,
      sessions,
      tabLocks,
      userConcurrency: new Map([['user-a', { active: 1, queue: [{}] }]]),
      admissionSnapshot: {
        active: 2,
        pending: 3,
        activeByUser: { 'user-a': 1, 'user-b': 1 },
        pendingByUser: { 'user-a': 2, 'user-b': 1 },
      },
    });

    expect(result).toMatchObject({
      userId: 'user-a',
      session: { exists: true, closing: false, idleMs: 1_000, pendingTabCreations: 0, tabCount: 1 },
      admission: { activeForUser: 1, pendingForUser: 2, activeWithoutSession: false },
      concurrency: { activeForUser: 1, queuedForUser: 1 },
      locks: { activeForUser: 1, queuedForUser: 2 },
      tabs: [{ tabId: 'tab-a', sessionKey: 'session-a', lock: { active: true, queued: 2 }, toolCalls: 4 }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-tab-b');
    expect(serialized).not.toContain('secret-session-b');
    expect(serialized).not.toContain('must-not-leak.invalid');
    expect(serialized).not.toContain('lastRequestedUrl');
    expect(result.admission).not.toHaveProperty('activeGlobal');
    expect(result.admission).not.toHaveProperty('pendingGlobal');
  });

  test('reports admission held without a resident session', () => {
    const result = collectUserDiagnostics({
      userId: 'wedged-user',
      now: 2_000,
      sessions: new Map(),
      tabLocks: new Map(),
      userConcurrency: new Map(),
      admissionSnapshot: {
        active: 4,
        pending: 1,
        activeByUser: { 'wedged-user': 1 },
        pendingByUser: { 'wedged-user': 1 },
      },
    });

    expect(result).toMatchObject({
      userId: 'wedged-user',
      session: { exists: false, tabCount: 0, sessionKeys: [] },
      admission: { activeForUser: 1, pendingForUser: 1, activeWithoutSession: true },
      tabs: [],
    });
  });

  test('bounds every response counter without losing requested-user identity', () => {
    const hugeQueue = [];
    hugeQueue.length = 1_000_000_001;
    const result = collectUserDiagnostics({
      userId: 'bounded-user',
      now: Number.MAX_SAFE_INTEGER,
      sessions: new Map([['bounded-user', session([
        ['bounded-session', new Map([['bounded-tab', tabState({
          toolCalls: Number.MAX_SAFE_INTEGER,
          consecutiveTimeouts: Number.MAX_SAFE_INTEGER,
          consecutiveFailures: Number.MAX_SAFE_INTEGER,
        })]])],
      ], { _pendingTabCreations: Number.MAX_SAFE_INTEGER })]]),
      tabLocks: new Map([['bounded-tab', { active: true, queue: hugeQueue }]]),
      userConcurrency: new Map([['bounded-user', { active: Number.MAX_SAFE_INTEGER, queue: hugeQueue }]]),
      admissionSnapshot: {
        activeByUser: { 'bounded-user': Number.MAX_SAFE_INTEGER },
        pendingByUser: { 'bounded-user': Number.MAX_SAFE_INTEGER },
      },
    });

    expect(result.userId).toBe('bounded-user');
    expect(result.session.idleMs).toBe(1_000_000_000);
    expect(result.session.pendingTabCreations).toBe(1_000_000_000);
    expect(result.admission.activeForUser).toBe(1_000_000_000);
    expect(result.admission.pendingForUser).toBe(1_000_000_000);
    expect(result.concurrency.activeForUser).toBe(1_000_000_000);
    expect(result.concurrency.queuedForUser).toBe(1_000_000_000);
    expect(result.locks.queuedForUser).toBe(1_000_000_000);
    expect(result.tabs[0].lock.queued).toBe(1_000_000_000);
    expect(result.tabs[0].toolCalls).toBe(1_000_000_000);
    expect(result.tabs[0].consecutiveTimeouts).toBe(1_000_000_000);
    expect(result.tabs[0].consecutiveFailures).toBe(1_000_000_000);
  });
});
