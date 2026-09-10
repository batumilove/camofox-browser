export class CapacityReservations {
  constructor({ maxSessions, maxTabsPerSession, maxTabsGlobal }) {
    this.maxSessions = maxSessions;
    this.maxTabsPerSession = maxTabsPerSession;
    this.maxTabsGlobal = maxTabsGlobal;
    this.sessionKeys = new Set();
    this.tabTotal = 0;
    this.tabsByUser = new Map();
  }

  reserveSession(userId, activeSessions) {
    const key = String(userId);
    if (this.sessionKeys.has(key) || activeSessions + this.sessionKeys.size >= this.maxSessions) {
      return null;
    }
    this.sessionKeys.add(key);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.sessionKeys.delete(key);
    };
  }

  reserveTab(userId, activeSessionTabs, activeGlobalTabs) {
    const key = String(userId);
    const userReserved = this.tabsByUser.get(key) || 0;
    if (
      activeSessionTabs + userReserved >= this.maxTabsPerSession
      || activeGlobalTabs + this.tabTotal >= this.maxTabsGlobal
    ) {
      return null;
    }

    this.tabsByUser.set(key, userReserved + 1);
    this.tabTotal += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.tabsByUser.get(key) || 1) - 1;
      if (remaining > 0) this.tabsByUser.set(key, remaining);
      else this.tabsByUser.delete(key);
      this.tabTotal -= 1;
    };
  }
}
