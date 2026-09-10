function nonNegativeInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function collectUserDiagnostics({
  userId,
  now = Date.now(),
  sessions,
  tabLocks,
  userConcurrency,
  admissionSnapshot,
}) {
  const key = String(userId);
  const currentSession = sessions.get(key) || null;
  const admission = admissionSnapshot || {};
  const activeForUser = nonNegativeInteger(admission.activeByUser?.[key]);
  const pendingForUser = nonNegativeInteger(admission.pendingByUser?.[key]);
  const concurrency = userConcurrency.get(key);
  const tabs = [];
  let activeLocks = 0;
  let queuedLocks = 0;

  if (currentSession) {
    for (const [sessionKey, group] of currentSession.tabGroups) {
      for (const [tabId, state] of group) {
        const lock = tabLocks.get(tabId);
        const lockActive = Boolean(lock?.active);
        const lockQueued = Array.isArray(lock?.queue) ? lock.queue.length : 0;
        if (lockActive) activeLocks += 1;
        queuedLocks += lockQueued;
        tabs.push({
          tabId: String(tabId),
          sessionKey: String(sessionKey),
          lock: { active: lockActive, queued: lockQueued },
          toolCalls: nonNegativeInteger(state?.toolCalls),
          consecutiveTimeouts: nonNegativeInteger(state?.consecutiveTimeouts),
          consecutiveFailures: nonNegativeInteger(state?.consecutiveFailures),
        });
      }
    }
  }

  const lastAccess = Number.isFinite(currentSession?.lastAccess) ? currentSession.lastAccess : null;
  return {
    userId: key,
    generatedAt: now,
    session: {
      exists: Boolean(currentSession),
      closing: Boolean(currentSession?._closing),
      lastAccess,
      idleMs: lastAccess === null ? null : Math.max(0, now - lastAccess),
      pendingTabCreations: nonNegativeInteger(currentSession?._pendingTabCreations),
      tabCount: tabs.length,
      sessionKeys: currentSession ? Array.from(currentSession.tabGroups.keys(), String) : [],
    },
    admission: {
      activeForUser,
      pendingForUser,
      activeGlobal: nonNegativeInteger(admission.active),
      pendingGlobal: nonNegativeInteger(admission.pending),
      activeWithoutSession: activeForUser > 0 && !currentSession,
    },
    concurrency: {
      activeForUser: nonNegativeInteger(concurrency?.active),
      queuedForUser: Array.isArray(concurrency?.queue) ? concurrency.queue.length : 0,
    },
    locks: {
      activeForUser: activeLocks,
      queuedForUser: queuedLocks,
    },
    tabs,
  };
}
