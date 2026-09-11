/**
 * Unit tests for session cleanup race conditions.
 *
 * Covers:
 * 1. Tab reaper → empty session cleanup (with _closing flag)
 * 2. getSession() skips sessions marked _closing
 * 3. YT transcript cleanup uses context.pages() instead of tabGroups
 * 4. Session expiry sets _closing before teardown
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SessionCreationGenerations,
  coalesceSessionClose,
  detachSessionForClose,
} from '../../lib/tab-admission.js';

describe('session close registry detachment', () => {
  test('admission abort invalidates only the exact in-flight session creation', () => {
    const generations = new SessionCreationGenerations();
    const controller = new AbortController();
    const token = generations.begin('user-1');
    let cleanups = 0;
    generations.setInvalidationHandler(token, () => { cleanups += 1; });

    const unbind = generations.bindAbort(token, controller.signal);
    controller.abort(new Error('tab admission timed out'));

    expect(generations.canPublish(token)).toBe(false);
    expect(cleanups).toBe(1);
    const successor = generations.begin('user-1');
    unbind();
    expect(generations.canPublish(successor)).toBe(true);
  });

  test('delete invalidation prevents an in-flight creation from publishing', () => {
    const generations = new SessionCreationGenerations();
    const token = generations.begin('user-1');

    expect(generations.canPublish(token)).toBe(true);
    generations.invalidate('user-1');
    expect(generations.canPublish(token)).toBe(false);
    expect(generations.canPublish(generations.begin('user-1'))).toBe(true);
  });

  test('shutdown invalidation prevents every captured creation from publishing', () => {
    const generations = new SessionCreationGenerations();
    const first = generations.begin('user-1');
    const second = generations.begin('user-2');

    generations.invalidateAll();
    expect(generations.canPublish(first)).toBe(false);
    expect(generations.canPublish(second)).toBe(false);
  });

  test('a published creation remains current until a later global invalidation', () => {
    const generations = new SessionCreationGenerations();
    const token = generations.begin('user-1');

    generations.finish(token);
    expect(generations.canPublish(token)).toBe(true);
    generations.invalidateAll();
    expect(generations.canPublish(token)).toBe(false);
  });

  test('failed creation invalidates its exact token and starts attached context cleanup', () => {
    const generations = new SessionCreationGenerations();
    const token = generations.begin('user-1');
    let cleanups = 0;
    generations.setInvalidationHandler(token, () => { cleanups += 1; });

    generations.invalidateToken(token);
    generations.finish(token);

    expect(generations.canPublish(token)).toBe(false);
    expect(cleanups).toBe(1);
  });

  test('server wires creation invalidation into delete, shutdown, and publication', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../server.js'), 'utf8');
    const getSessionSource = source.slice(
      source.indexOf('async function getSession('),
      source.indexOf('\nfunction touchSession(', source.indexOf('async function getSession(')),
    );
    const deleteSource = source.slice(
      source.indexOf("app.delete('/sessions/:userId'"),
      source.indexOf("app.get('/sessions/:userId/diagnostics'"),
    );
    const shutdownSource = source.slice(
      source.indexOf('async function gracefulShutdown('),
      source.indexOf("process.on('SIGTERM'"),
    );

    expect(getSessionSource).toContain('sessionCreationGenerations.begin(key)');
    expect(getSessionSource).toContain('sessionCreationGenerations.canPublish(creationToken)');
    expect(getSessionSource).toContain('sessionCreationGenerations.setInvalidationHandler(creationToken');
    expect(getSessionSource).toContain('sessionCreationGenerations.invalidateToken(creationToken)');
    expect(getSessionSource).toContain('sessionCreationGenerations.bindAbort(creationToken, signal)');
    expect(getSessionSource.indexOf("pluginEvents.emitAsync('session:created'")).toBeLessThan(
      getSessionSource.indexOf('sessions.set(key, created)'),
    );
    expect(getSessionSource).toContain('isCurrent: () => sessionCreationGenerations.canPublish(creationToken)');
    expect(getSessionSource).toContain("reason: 'session_creation_failed'");
    expect(deleteSource).toContain('sessionCreationGenerations.invalidate(userId)');
    expect(deleteSource).toContain('sessionCreations.get(userId)');
    expect(shutdownSource).toContain('sessionCreationGenerations.invalidateAll()');
    expect(shutdownSource).toContain('const httpClosePromise = closeHttpServer()');
    expect(shutdownSource).toContain('await Promise.allSettled(Array.from(sessionCreations.values()))');
    expect(shutdownSource).toContain('await activeTimedOperations.drain()');
    expect(shutdownSource).toContain('await activeSessionTeardownOperations.drain()');
    expect(shutdownSource).toContain('await httpClosePromise');
    expect(shutdownSource).toContain('teardownTimeoutMs: Number.POSITIVE_INFINITY');
    expect(shutdownSource).toContain('const closeSessionsPromise = closeAllSessions(');
    expect(shutdownSource).toContain('const closeBrowserPromise = closeBrowserFully(');
    expect(shutdownSource).toContain('await Promise.allSettled([closeSessionsPromise, closeBrowserPromise])');
    expect(shutdownSource.indexOf('const closeSessionsPromise = closeAllSessions(')).toBeLessThan(
      shutdownSource.indexOf('const closeBrowserPromise = closeBrowserFully('),
    );
    expect(shutdownSource.indexOf('const closeBrowserPromise = closeBrowserFully(')).toBeLessThan(
      shutdownSource.indexOf('await activeTimedOperations.drain()'),
    );
    expect(shutdownSource.indexOf('await httpClosePromise')).toBeLessThan(
      shutdownSource.indexOf('await activeTimedOperations.drain()'),
    );
    expect(shutdownSource).toContain("await closeBrowserFully(`shutdown:${signal}:final_sweep`)");
    expect(getSessionSource).toContain('sessionCapacity.reserve()');
    expect(getSessionSource).toContain('await closeInvalidatedContext()');
    expect(getSessionSource).toContain("await closeSession(key, session, { reason: 'closing_session_replacement'");

    const ensureBrowserSource = source.slice(
      source.indexOf('async function ensureBrowser()'),
      source.indexOf('// Helper to normalize userId', source.indexOf('async function ensureBrowser()')),
    );
    expect(ensureBrowserSource).toContain("code: 'shutting_down'");
    expect(ensureBrowserSource.indexOf("code: 'shutting_down'")).toBeLessThan(
      ensureBrowserSource.indexOf('browserLaunchCoordinator.ensure()'),
    );

    const createHandlerSource = source.slice(
      source.indexOf('async function createTabHandler('),
      source.indexOf("app.post('/tabs', createTabHandler)"),
    );
    expect(createHandlerSource).toContain('getSession(userId, { trace: !!trace, signal })');
  });

  test('coalesces concurrent teardown calls for the same session', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const session = {};
    let calls = 0;
    const first = coalesceSessionClose(session, async () => { calls += 1; await gate; });
    const second = coalesceSessionClose(session, async () => { calls += 1; });

    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
  });

  test('production closeSession delegates the entire teardown to the once guard', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../server.js'), 'utf8');
    const closeStart = source.indexOf('async function closeSession(');
    const closeEnd = source.indexOf('\nasync function closeAllSessions(', closeStart);
    const closeSource = source.slice(closeStart, closeEnd);

    expect(closeSource).toContain('return coalesceSessionClose(session, async () => {');
    expect(closeSource).toContain('sessionCapacity.trackDetached(detachedClose)');
    expect(closeSource).toContain('contextClosePromise.then(settleDetachedCapacity, settleDetachedCapacity)');
    expect(closeSource).not.toContain('if (detached) {');
    expect(closeSource).toContain('trackOperation: (operation) => activeSessionTeardownOperations.track(operation)');
  });

  test('destroySession delegates detachment to closeSession so capacity remains accounted', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../server.js'), 'utf8');
    const start = source.indexOf('function destroySession(');
    const end = source.indexOf('\nfunction findTab(', start);
    const destroySource = source.slice(start, end);

    expect(destroySource).toContain('closeSession(key, session');
    expect(destroySource).not.toContain('sessions.delete(key)');
  });

  test('detaches the exact session before asynchronous context cleanup settles', () => {
    const session = { _closing: false };
    const sessions = new Map([['internal-user', session]]);

    expect(detachSessionForClose(sessions, 'internal-user', session)).toBe(true);
    expect(session._closing).toBe(true);
    expect(sessions.has('internal-user')).toBe(false);
  });

  test('never deletes a replacement session installed under the same user key', () => {
    const stale = { _closing: true };
    const replacement = { _closing: false };
    const sessions = new Map([['internal-user', replacement]]);

    expect(detachSessionForClose(sessions, 'internal-user', stale)).toBe(false);
    expect(sessions.get('internal-user')).toBe(replacement);
  });
});

describe('session cleanup after tab reaper', () => {
  // Simulate the reaper loop logic from server.js (with _closing flag)
  function runTabReaper({ sessions, TAB_INACTIVITY_MS, destroyTab, onSessionEmpty }) {
    const now = Date.now();
    for (const [userId, session] of sessions) {
      for (const [listItemId, group] of session.tabGroups) {
        for (const [tabId, tabState] of group) {
          if (!tabState._lastReaperCheck) {
            tabState._lastReaperCheck = now;
            tabState._lastReaperToolCalls = tabState.toolCalls;
            continue;
          }
          if (tabState.toolCalls === tabState._lastReaperToolCalls) {
            const idleMs = now - tabState._lastReaperCheck;
            if (idleMs >= TAB_INACTIVITY_MS) {
              destroyTab(tabId);
              group.delete(tabId);
            }
          } else {
            tabState._lastReaperCheck = now;
            tabState._lastReaperToolCalls = tabState.toolCalls;
          }
        }
        if (group.size === 0) {
          session.tabGroups.delete(listItemId);
        }
      }
      if (session.tabGroups.size === 0) {
        session._closing = true;
        onSessionEmpty(userId);
        sessions.delete(userId);
      }
    }
  }

  function makeSession(tabs) {
    const tabGroups = new Map();
    const group = new Map();
    for (const [tabId, tabState] of Object.entries(tabs)) {
      group.set(tabId, { toolCalls: 0, ...tabState });
    }
    tabGroups.set('list-1', group);
    return { tabGroups, lastAccess: Date.now() };
  }

  test('empty session is cleaned up when all tabs are reaped', () => {
    const past = Date.now() - 600_000; // 10 min ago
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual(['tab-1', 'tab-2']);
    expect(emptied).toEqual(['user-1']);
    expect(sessions.size).toBe(0);
  });

  test('reaped session gets _closing flag set before deletion', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    const session = makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    });
    sessions.set('user-1', session);

    let closingFlagAtCallback = null;
    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: () => {},
      onSessionEmpty: () => { closingFlagAtCallback = session._closing; },
    });

    // _closing should be set BEFORE the onSessionEmpty callback
    expect(closingFlagAtCallback).toBe(true);
  });

  test('session with active tabs is NOT cleaned up', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 5 }, // active
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual(['tab-1']);
    expect(emptied).toEqual([]);
    expect(sessions.size).toBe(1);
    const session = sessions.get('user-1');
    expect(session._closing).toBeUndefined();
    expect(session.tabGroups.get('list-1').has('tab-2')).toBe(true);
  });

  test('multiple sessions: only empty ones are cleaned up', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    }));
    sessions.set('user-2', makeSession({
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 3 }, // active
    }));

    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: () => {},
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(emptied).toEqual(['user-1']);
    expect(sessions.size).toBe(1);
    expect(sessions.has('user-2')).toBe(true);
  });

  test('tabs not yet checked are skipped (first pass initializes reaper state)', () => {
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { toolCalls: 0 }, // no _lastReaperCheck
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual([]);
    expect(emptied).toEqual([]);
    expect(sessions.size).toBe(1);
  });
});

describe('getSession _closing flag handling', () => {
  // Simulate getSession logic from server.js
  function getSession(sessions, userId, createContext) {
    const key = String(userId);
    let session = sessions.get(key);

    if (session) {
      if (session._closing) {
        session = null;
      } else {
        try {
          session.context.pages();
        } catch {
          sessions.delete(key);
          session = null;
        }
      }
    }

    if (!session) {
      const context = createContext();
      session = { context, tabGroups: new Map(), lastAccess: Date.now() };
      sessions.set(key, session);
    }
    session.lastAccess = Date.now();
    return session;
  }

  test('returns existing session when context is alive', () => {
    const sessions = new Map();
    const existingContext = { pages: () => [] };
    sessions.set('user-1', { context: existingContext, tabGroups: new Map(), lastAccess: 0 });

    const result = getSession(sessions, 'user-1', () => { throw new Error('should not create'); });
    expect(result.context).toBe(existingContext);
  });

  test('skips session with _closing flag and creates new one', () => {
    const sessions = new Map();
    const oldContext = { pages: () => [] };
    sessions.set('user-1', { context: oldContext, tabGroups: new Map(), lastAccess: 0, _closing: true });

    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
    expect(result.context).not.toBe(oldContext);
    expect(result._closing).toBeUndefined();
    // Old entry is replaced in the map
    expect(sessions.get('user-1').context).toBe(newContext);
  });

  test('recreates session when context.pages() throws', () => {
    const sessions = new Map();
    const deadContext = { pages: () => { throw new Error('context closed'); } };
    sessions.set('user-1', { context: deadContext, tabGroups: new Map(), lastAccess: 0 });

    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
  });

  test('creates fresh session when none exists', () => {
    const sessions = new Map();
    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
    expect(sessions.has('user-1')).toBe(true);
  });
});

describe('YT transcript session cleanup', () => {
  test('production plugin delegates transcript teardown to closeSession accounting', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../plugins/youtube/index.js'), 'utf8');
    const cleanupStart = source.indexOf('const releaseTranscriptLease = reservePendingTabCreation(session)');
    const cleanupSource = source.slice(
      cleanupStart,
      source.indexOf('\n        }\n      }\n    });', cleanupStart),
    );

    expect(source).toContain('closeSession } = ctx');
    expect(source).toContain("import { reservePendingTabCreation } from '../../lib/tab-admission.js'");
    expect(source.indexOf('const releaseTranscriptLease = reservePendingTabCreation(session)')).toBeLessThan(
      source.indexOf('page = await session.context.newPage()'),
    );
    expect(cleanupSource).toContain('releaseTranscriptLease()');
    expect(cleanupSource).toContain('safePageClose(page, { retainUntilSettled: true })');
    expect(cleanupSource).toContain('(session._pendingTabCreations || 0) === 0');
    expect(cleanupSource).toContain('await closeSession(ytKey, session');
    expect(cleanupSource).not.toContain('sessions.delete(');
    expect(cleanupSource).not.toContain('context.close(');
  });

  // Simulate the finally-block cleanup logic from browserTranscript
  function ytCleanup(sessions, ytKey, contextPagesResult, contextPagesThrows) {
    const ytSession = sessions.get(ytKey);
    if (ytSession && !ytSession._closing) {
      try {
        if (contextPagesThrows) throw new Error('context closed');
        const remainingPages = contextPagesResult;
        if (remainingPages.length === 0) {
          ytSession._closing = true;
          // context.close() would be called here
          sessions.delete(ytKey);
        }
      } catch {
        sessions.delete(ytKey);
      }
    }
  }

  test('does NOT close session when other pages are still open', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    // Another transcript request still has a page open
    ytCleanup(sessions, '__yt_transcript__', [{ /* page */ }], false);

    expect(sessions.has('__yt_transcript__')).toBe(true);
    expect(session._closing).toBeUndefined();
  });

  test('closes session when no pages remain', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], false);

    expect(sessions.has('__yt_transcript__')).toBe(false);
    expect(session._closing).toBe(true);
  });

  test('cleans up map entry when context is already dead', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], true /* throws */);

    expect(sessions.has('__yt_transcript__')).toBe(false);
  });

  test('skips cleanup when session is already _closing', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now(), _closing: true };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], false);

    // Session is still in the map (another cleanup path owns it)
    expect(sessions.has('__yt_transcript__')).toBe(true);
  });

  test('concurrent requests: first closer sees pages, second sees empty', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    // Request A finishes first — request B still has a page
    ytCleanup(sessions, '__yt_transcript__', [{ /* B's page */ }], false);
    expect(sessions.has('__yt_transcript__')).toBe(true);
    expect(session._closing).toBeUndefined();

    // Request B finishes — no pages left
    ytCleanup(sessions, '__yt_transcript__', [], false);
    expect(sessions.has('__yt_transcript__')).toBe(false);
    expect(session._closing).toBe(true);
  });
});

describe('session expiry _closing flag', () => {
  // Simulate session expiry logic from server.js
  function runSessionExpiry({ sessions, SESSION_TIMEOUT_MS, onExpired }) {
    const now = Date.now();
    for (const [userId, session] of sessions) {
      if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
        session._closing = true;
        onExpired(userId);
        sessions.delete(userId);
      }
    }
  }

  test('expired session gets _closing flag before deletion', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    const session = { tabGroups: new Map(), lastAccess: past };
    sessions.set('user-1', session);

    let closingFlagAtCallback = null;
    runSessionExpiry({
      sessions,
      SESSION_TIMEOUT_MS: 300_000,
      onExpired: () => { closingFlagAtCallback = session._closing; },
    });

    expect(closingFlagAtCallback).toBe(true);
    expect(sessions.size).toBe(0);
  });

  test('active session is NOT expired or flagged', () => {
    const sessions = new Map();
    const session = { tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('user-1', session);

    runSessionExpiry({
      sessions,
      SESSION_TIMEOUT_MS: 300_000,
      onExpired: () => { throw new Error('should not expire'); },
    });

    expect(sessions.size).toBe(1);
    expect(session._closing).toBeUndefined();
  });
});
