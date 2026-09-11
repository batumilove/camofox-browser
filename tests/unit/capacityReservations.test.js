import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { CapacityReservations } from '../../lib/capacity-reservations.js';

describe('capacity reservations', () => {
  test('concurrent distinct session creation cannot exceed the limit', () => {
    const capacity = new CapacityReservations({ maxSessions: 2, maxTabsPerSession: 2, maxTabsGlobal: 3 });
    const first = capacity.reserveSession('a', 1);
    const second = capacity.reserveSession('b', 1);

    expect(first).toEqual(expect.any(Function));
    expect(second).toBeNull();
    first();
    expect(capacity.reserveSession('b', 1)).toEqual(expect.any(Function));
  });

  test('session reservations are keyed and releases are idempotent', () => {
    const capacity = new CapacityReservations({ maxSessions: 3, maxTabsPerSession: 2, maxTabsGlobal: 3 });
    const release = capacity.reserveSession('a', 0);
    expect(capacity.reserveSession('a', 0)).toBeNull();
    release();
    release();
    expect(capacity.reserveSession('a', 0)).toEqual(expect.any(Function));
  });

  test('concurrent tab creation respects per-session and global limits', () => {
    const capacity = new CapacityReservations({ maxSessions: 3, maxTabsPerSession: 2, maxTabsGlobal: 3 });
    const a = capacity.reserveTab('a', 1, 1);
    expect(a).toEqual(expect.any(Function));
    expect(capacity.reserveTab('a', 1, 1)).toBeNull();

    const b = capacity.reserveTab('b', 0, 1);
    expect(b).toEqual(expect.any(Function));
    expect(capacity.reserveTab('c', 0, 1)).toBeNull();

    a();
    a();
    expect(capacity.reserveTab('c', 0, 1)).toEqual(expect.any(Function));
  });

  test('server reserves session and tab capacity on every creation path', () => {
    const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(source).toMatch(/coalesceInflight\(sessionCreations[\s\S]*?reserveSession\(/);
    expect(source).toMatch(/const activeSessions = sessions\.size;[\s\S]*?reserveSession\(key, activeSessions\)/);
    for (const route of ["app.post('/tabs'", "app.post('/tabs/open'"]) {
      const start = source.indexOf(route);
      const end = source.indexOf('\n});', start);
      expect(source.slice(start, end)).toContain('reserveTabCreation(');
    }
    const popupHandler = source.match(/function attachPopupHandler[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(popupHandler).toContain('capacityReservations.reserveTab(');
    const googleRotation = source.match(/async function rotateGoogleTab[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(googleRotation).toContain('reserveTabCreation(');
    expect(source).toMatch(/const recreateTabOnFreshContext[\s\S]*?reserveTabCreation\(userId, session, req\.reqId\)/);
    expect(source).toMatch(/withTabLock\(req\.params\.tabId, \(\) => rotateGoogleTab\(/);
    expect(source).not.toMatch(/async function destroySession[\s\S]*?sessions\.delete\(key\)[\s\S]*?closeSession\(/);
    expect(source).toMatch(/if \(session\._closing\)[\s\S]*?code: 'session_closing'/);
    expect(source).toMatch(/const prewarmGoogleHome[\s\S]*?capacityReservations\.reserveTab/);
    expect(source).toMatch(/health probe[\s\S]*?capacityReservations\.reserveSession[\s\S]*?capacityReservations\.reserveTab/);
    expect(source).toMatch(/throw new TabAdmissionError\(\s*'Maximum tabs per session reached'/);
  });
});
