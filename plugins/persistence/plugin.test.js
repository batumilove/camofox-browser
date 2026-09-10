import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';

describe('persistence plugin', () => {
  let tmpDir, events, ctx, mockApp;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persist-plugin-'));
    events = createPluginEvents();
    mockApp = { delete: jest.fn() };
    ctx = {
      events,
      config: { cookiesDir: path.join(tmpDir, 'cookies') },
      log: jest.fn(),
      auth: () => (req, res, next) => next(),
      normalizeUserId: (u) => String(u),
      safeError: (err) => err.message,
      destroySession: jest.fn(async (userId, { reason } = {}) => {
        await events.emitAsync('session:destroying', { userId: String(userId), reason });
        await events.emitAsync('session:destroyed', { userId: String(userId), reason });
        return true;
      }),
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('skips registration when no profileDir configured', async () => {
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no profileDir'));
  });

  test('restores persisted state on session:creating', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    // Simulate a prior persisted state
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-1');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [],
    }));

    const contextOptions = { viewport: { width: 1280, height: 720 } };
    await events.emitAsync('session:creating', { userId: 'user-1', contextOptions });

    expect(contextOptions.storageState).toBe(storageStatePath);
  });

  test('checkpoints on session:cookies:import', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: '.test.com', path: '/' }] }));
      }),
    };

    // Simulate session created then cookie import
    await events.emitAsync('session:created', { userId: 'user-2', context: mockContext });
    await events.emitAsync('session:cookies:import', { userId: 'user-2' });

    expect(mockContext.storageState).toHaveBeenCalled();

    // Verify file was written
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('x');
  });

  test('persists the exact state supplied by session:storage:export', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, indexedDB: true });

    const storageState = {
      cookies: [],
      origins: [{
        origin: 'https://example.test',
        localStorage: [],
        indexedDB: [{ name: 'auth', version: 1, stores: [] }],
      }],
    };
    const context = { storageState: jest.fn() };
    await events.emitAsync('session:created', { userId: 'user-export', context });
    await events.emitAsync('session:storage:export', { userId: 'user-export', context, storageState });

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-export');
    expect(JSON.parse(await fs.readFile(storageStatePath, 'utf8'))).toEqual(storageState);
  });

  test('storage export from a replaced context cannot publish stale state', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const contextA = { storageState: jest.fn() };
    const contextB = { storageState: jest.fn() };
    await events.emitAsync('session:created', { userId: 'export-race', context: contextA });
    await events.emitAsync('session:created', { userId: 'export-race', context: contextB });

    await events.emitAsync('session:storage:export', {
      userId: 'export-race',
      context: contextA,
      storageState: { cookies: [{ name: 'stale', value: '1' }], origins: [] },
    });

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'export-race');
    await expect(fs.access(storageStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('checkpoints on session:destroying', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'user-3', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-3', reason: 'test' });

    expect(mockContext.storageState).toHaveBeenCalled();
  });

  test('cookie import route awaits checkpoint listeners before responding', async () => {
    const source = await fs.readFile(new URL('../../server.js', import.meta.url), 'utf8');
    const route = source.match(/app\.post\('\/sessions\/:userId\/cookies'[\s\S]*?\n}\);/)?.[0] ?? '';
    expect(route).toContain("await pluginEvents.emitAsync('session:cookies:import'");
  });

  test('late destroy for an old context cannot checkpoint or remove its replacement', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const contextA = { storageState: jest.fn() };
    const contextB = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'replacement-user', context: contextA });
    await events.emitAsync('session:created', { userId: 'replacement-user', context: contextB });
    await events.emitAsync('session:destroying', {
      userId: 'replacement-user',
      context: contextA,
      reason: 'replaced',
    });
    expect(contextB.storageState).not.toHaveBeenCalled();

    await events.emitAsync('session:cookies:import', { userId: 'replacement-user' });

    expect(contextA.storageState).not.toHaveBeenCalled();
    expect(contextB.storageState).toHaveBeenCalledTimes(1);
  });

  test('DELETE storage_state destroys the live session without checkpointing and removes persisted state', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const call = mockApp.delete.mock.calls.find(c => c[0] === '/sessions/:userId/storage_state');
    expect(call).toBeTruthy();
    const handler = call.at(-1);

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(tmpDir, 'user-4');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'a', domain: '.x.com', path: '/' }],
      origins: [{
        origin: 'https://x.com',
        localStorage: [{ name: 'token', value: 'secret' }],
        indexedDB: [{ name: 'auth', version: 1, stores: [] }],
      }],
    }));
    await fs.writeFile(metaPath, JSON.stringify({ userId: 'user-4' }));

    const mockContext = { storageState: jest.fn() };
    await events.emitAsync('session:created', { userId: 'user-4', context: mockContext });

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    await handler({ params: { userId: 'user-4' } }, res);

    expect(ctx.destroySession).toHaveBeenCalledWith('user-4', { reason: 'storage_reset' });
    expect(mockContext.storageState).not.toHaveBeenCalled();
    await expect(fs.access(storageStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(metaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      userId: 'user-4',
      clearedLive: true,
      removedPersisted: true,
    });
  });

  test('DELETE storage_state invalidates an in-flight checkpoint without waiting for serialization', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const handler = mockApp.delete.mock.calls
      .find(c => c[0] === '/sessions/:userId/storage_state')
      .at(-1);

    let finishCheckpoint;
    let markCheckpointStarted;
    const checkpointBlocked = new Promise(resolve => { finishCheckpoint = resolve; });
    const checkpointStarted = new Promise(resolve => { markCheckpointStarted = resolve; });
    const mockContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        markCheckpointStarted();
        await checkpointBlocked;
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-race', context: mockContext });
    const checkpoint = events.emitAsync('session:cookies:import', { userId: 'user-race' });
    await checkpointStarted;

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    const outcome = await Promise.race([
      handler({ params: { userId: 'user-race' } }, res).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 200)),
    ]);
    expect(outcome).toBe('completed');
    expect(res.json).toHaveBeenCalled();

    finishCheckpoint();
    await checkpoint;

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-race');
    await expect(fs.access(storageStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('checkpoint bursts coalesce to one running and one latest pending write', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    let releaseFirst;
    const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
    let markFirstStarted;
    const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
    const mockContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        if (mockContext.storageState.mock.calls.length === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'burst', context: mockContext });
    const writes = Array.from({ length: 20 }, () =>
      events.emitAsync('session:cookies:import', { userId: 'burst' }));
    await firstStarted;
    expect(mockContext.storageState).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all(writes);
    expect(mockContext.storageState).toHaveBeenCalledTimes(2);
  });

  test('timed-out checkpoints retain serialization ownership before the latest write', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointTimeoutMs: 100 });
    let releaseFirst;
    const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
    let firstStartedResolve;
    const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
    const mockContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        const call = mockContext.storageState.mock.calls.length;
        if (call === 1) {
          firstStartedResolve();
          await firstBlocked;
        }
        await fs.writeFile(targetPath, JSON.stringify({
          cookies: [{ name: call === 1 ? 'old' : 'latest', value: '1' }],
          origins: [],
        }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'serialized', context: mockContext });
    const first = events.emitAsync('session:cookies:import', { userId: 'serialized' });
    await firstStarted;
    await expect(first).rejects.toThrow('storage checkpoint timed out');

    const second = events.emitAsync('session:cookies:import', { userId: 'serialized' });
    await new Promise(resolve => setImmediate(resolve));
    expect(mockContext.storageState).toHaveBeenCalledTimes(1);

    releaseFirst();
    await second;
    expect(mockContext.storageState).toHaveBeenCalledTimes(2);
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'serialized');
    expect(JSON.parse(await fs.readFile(storageStatePath, 'utf8')).cookies[0].name).toBe('latest');
  });

  test('shutdown starts all user checkpoints in parallel within one timeout window', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointTimeoutMs: 20 });
    let started = 0;
    let resolveAllStarted;
    const allStarted = new Promise(resolve => { resolveAllStarted = resolve; });
    const makeContext = () => ({
      storageState: jest.fn(() => {
        started += 1;
        if (started === 2) resolveAllStarted();
        return new Promise(() => {});
      }),
    });
    const contextA = makeContext();
    const contextB = makeContext();
    await events.emitAsync('session:created', { userId: 'shutdown-a', context: contextA });
    await events.emitAsync('session:created', { userId: 'shutdown-b', context: contextB });

    const shutdown = events.emitAsync('server:shutdown');
    await expect(Promise.race([
      allStarted.then(() => 'all-started'),
      new Promise(resolve => setTimeout(() => resolve('serial'), 100)),
    ])).resolves.toBe('all-started');
    await shutdown;
    expect(contextA.storageState).toHaveBeenCalledTimes(1);
    expect(contextB.storageState).toHaveBeenCalledTimes(1);
  });

  test('storage reset is bounded when storage serialization hangs', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointTimeoutMs: 20 });
    const handler = mockApp.delete.mock.calls
      .find(c => c[0] === '/sessions/:userId/storage_state')
      .at(-1);
    const mockContext = { storageState: jest.fn(() => new Promise(() => {})) };
    await events.emitAsync('session:created', { userId: 'hung', context: mockContext });
    const hungCheckpoint = events.emitAsync('session:cookies:import', { userId: 'hung' });
    const hungResult = hungCheckpoint.then(
      () => ({ ok: true, error: null }),
      error => ({ ok: false, error }),
    );
    await new Promise(resolve => setImmediate(resolve));

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    const outcome = await Promise.race([
      handler({ params: { userId: 'hung' } }, res).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 200)),
    ]);
    expect(outcome).toBe('completed');
    expect(res.json).toHaveBeenCalled();
    const checkpointOutcome = await hungResult;
    expect(checkpointOutcome.ok).toBe(false);
    expect(checkpointOutcome.error).toHaveProperty(
      'message',
      expect.stringContaining('storage checkpoint timed out'),
    );
  });

  test('DELETE storage_state is idempotent without a live session or persisted file', async () => {
    ctx.destroySession.mockResolvedValueOnce(false);
    await register(mockApp, ctx, { profileDir: tmpDir });
    const call = mockApp.delete.mock.calls.find(c => c[0] === '/sessions/:userId/storage_state');
    const handler = call.at(-1);

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    await handler({ params: { userId: 'nobody' } }, res);

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      userId: 'nobody',
      clearedLive: false,
      removedPersisted: false,
    });
  });

  test('env var CAMOFOX_PROFILE_DIR overrides pluginConfig', async () => {
    const envDir = path.join(tmpDir, 'env-override');
    const orig = process.env.CAMOFOX_PROFILE_DIR;
    process.env.CAMOFOX_PROFILE_DIR = envDir;
    try {
      await register(mockApp, ctx, { profileDir: '/should/not/use' });
      expect(ctx.log).toHaveBeenCalledWith(
        'info',
        'persistence plugin enabled',
        expect.objectContaining({ profileDir: envDir })
      );
    } finally {
      if (orig === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
      else process.env.CAMOFOX_PROFILE_DIR = orig;
    }
  });

  test('does not persist IndexedDB by default', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-no-idb', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-no-idb', reason: 'test' });

    expect(ctx.log).toHaveBeenCalledWith(
      'info',
      'persistence plugin enabled',
      expect.objectContaining({ indexedDB: false })
    );
    expect(mockContext.storageState).toHaveBeenCalled();
    for (const [arg] of mockContext.storageState.mock.calls) {
      expect(arg.indexedDB).toBeUndefined();
    }
  });

  test('indexedDB: true opts in to IndexedDB persistence', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, indexedDB: true });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-idb', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-idb', reason: 'test' });

    expect(ctx.log).toHaveBeenCalledWith(
      'info',
      'persistence plugin enabled',
      expect.objectContaining({ indexedDB: true })
    );
    expect(mockContext.storageState).toHaveBeenCalledWith(
      expect.objectContaining({ indexedDB: true })
    );
  });
});
