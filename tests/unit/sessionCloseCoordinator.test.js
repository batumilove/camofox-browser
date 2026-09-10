import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, jest, test } from '@jest/globals';
import { createSessionCloseCoordinator } from '../../lib/session-close.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '..', '..', 'server.js'), 'utf8');

describe('session close coordination', () => {
  test('concurrent close calls share one teardown', async () => {
    const gate = Promise.withResolvers();
    const contextClose = jest.fn(async () => gate.promise);
    const coordinator = createSessionCloseCoordinator({ destroyingTimeoutMs: 20 });
    const session = { context: { close: contextClose } };

    const first = coordinator.close(session, { emitDestroying: async () => {} });
    const second = coordinator.close(session, { emitDestroying: async () => {} });
    expect(second).toBe(first);
    await new Promise(resolve => setImmediate(resolve));
    expect(contextClose).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });

  test('hung persistence hook is bounded before context close', async () => {
    const contextClose = jest.fn(async () => {});
    const coordinator = createSessionCloseCoordinator({ destroyingTimeoutMs: 10 });
    const session = { context: { close: contextClose } };

    await coordinator.close(session, { emitDestroying: () => new Promise(() => {}) });
    expect(contextClose).toHaveBeenCalledTimes(1);
  });

  test('destroyed hook failures are reported without rejecting teardown', async () => {
    const onDestroyedError = jest.fn();
    const coordinator = createSessionCloseCoordinator();
    const session = { context: { close: jest.fn(async () => {}) } };

    await expect(coordinator.close(session, {
      emitDestroyed: async () => { throw new Error('plugin failed'); },
      onDestroyedError,
    })).resolves.toBeUndefined();
    expect(onDestroyedError).toHaveBeenCalledWith(expect.objectContaining({ message: 'plugin failed' }));
  });

  test('server delegates closeSession teardown to the coordinator', () => {
    expect(serverSrc).toContain("from './lib/session-close.js'");
    expect(serverSrc).toMatch(/sessionCloseCoordinator\.close\(/);
    expect(serverSrc).toMatch(/try \{\s*await sessionCloseCoordinator\.close[\s\S]*?finally \{[\s\S]*?sessions\.delete\(key\)/);
    const closeSession = serverSrc.match(/async function closeSession[\s\S]*?\n}\n/)?.[0] ?? '';
    const closingIndex = closeSession.indexOf('session._closing = true');
    const cleanupAwaitIndex = closeSession.indexOf('await clearSessionDownloads');
    expect(closingIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupAwaitIndex).toBeGreaterThan(closingIndex);
  });

  test('legacy tab operations refresh session access time', () => {
    for (const route of ["app.post('/navigate'", "app.get('/snapshot'", "app.post('/act'"]) {
      const start = serverSrc.indexOf(route);
      const end = serverSrc.indexOf('\n});', start);
      expect(serverSrc.slice(start, end)).toContain('session.lastAccess = Date.now()');
    }
  });
});
