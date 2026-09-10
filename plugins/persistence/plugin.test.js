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
    mockApp = {};
    ctx = {
      events,
      config: { cookiesDir: path.join(tmpDir, 'cookies') },
      log: jest.fn(),
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
    await events.emitAsync('session:cookies:import', { userId: 'user-2', context: mockContext });

    expect(mockContext.storageState).toHaveBeenCalled();

    // Verify file was written
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('x');
  });

  test('late cookie import checkpoints its exact context, not the replacement session', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const contextA = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'a' }], origins: [] }));
      }),
    };
    const contextB = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'b' }], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'race-user', context: contextA });
    await events.emitAsync('session:created', { userId: 'race-user', context: contextB });
    await events.emitAsync('session:cookies:import', {
      userId: 'race-user',
      context: contextA,
    });

    expect(contextA.storageState).toHaveBeenCalledTimes(1);
    expect(contextB.storageState).not.toHaveBeenCalled();
  });

  test('checkpoints on session:destroying', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'user-3', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-3', context: mockContext, reason: 'test' });

    expect(mockContext.storageState).toHaveBeenCalled();
  });

  test('late destruction of session A neither checkpoints nor untracks replacement session B', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    let releaseCheckpoint, markCheckpointStarted;
    const checkpointStarted = new Promise((resolve) => { markCheckpointStarted = resolve; });
    const checkpointGate = new Promise((resolve) => { releaseCheckpoint = resolve; });
    const contextA = {
      storageState: jest.fn(async ({ path: p }) => {
        markCheckpointStarted();
        await checkpointGate;
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    const contextB = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'race-user', context: contextA });
    const destroyingA = events.emitAsync('session:destroying', {
      userId: 'race-user',
      context: contextA,
      reason: 'proxy_retry_rotate',
    });
    await checkpointStarted;
    expect(contextA.storageState).toHaveBeenCalledTimes(1);

    await events.emitAsync('session:created', { userId: 'race-user', context: contextB });
    releaseCheckpoint();
    await destroyingA;
    await events.emitAsync('session:destroyed', {
      userId: 'race-user',
      context: contextA,
      reason: 'proxy_retry_rotate',
    });
    await events.emitAsync('session:cookies:import', { userId: 'race-user', context: contextB });

    expect(contextA.storageState).toHaveBeenCalledTimes(1);
    expect(contextB.storageState).toHaveBeenCalledTimes(1);
  });

  test('late checkpoint from replaced context cannot overwrite replacement state', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    let releaseOld, markOldStarted;
    const oldStarted = new Promise((resolve) => { markOldStarted = resolve; });
    const oldGate = new Promise((resolve) => { releaseOld = resolve; });
    const contextA = {
      storageState: jest.fn(async ({ path: p }) => {
        markOldStarted();
        await oldGate;
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'stale-a' }], origins: [] }));
      }),
    };
    const contextB = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'current-b' }], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'race-user', context: contextA });
    const oldCheckpoint = events.emitAsync('session:cookies:import', {
      userId: 'race-user',
      context: contextA,
    });
    await oldStarted;
    await events.emitAsync('session:created', { userId: 'race-user', context: contextB });
    await events.emitAsync('session:cookies:import', {
      userId: 'race-user',
      context: contextB,
    });
    releaseOld();
    await oldCheckpoint;

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'race-user');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('current-b');
  });

  test('env var CAMOFOX_PROFILE_DIR overrides pluginConfig', async () => {
    const envDir = path.join(tmpDir, 'env-override');
    const orig = process.env.CAMOFOX_PROFILE_DIR;
    process.env.CAMOFOX_PROFILE_DIR = envDir;
    try {
      await register(mockApp, ctx, { profileDir: '/should/not/use' });
      expect(ctx.log).toHaveBeenCalledWith('info', 'persistence plugin enabled', { profileDir: envDir });
    } finally {
      if (orig === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
      else process.env.CAMOFOX_PROFILE_DIR = orig;
    }
  });
});
