/**
 * Persistence plugin for camofox-browser.
 *
 * Saves and restores per-user browser storage state (cookies + localStorage
 * + IndexedDB) across session restarts using Playwright's storageState API.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "persistence": {
 *         "enabled": true,
 *         "profileDir": "/data/profiles",
 *         "indexedDB": true
 *       }
 *     }
 *   }
 *
 * The profile directory can also be set via environment variable:
 *   CAMOFOX_PROFILE_DIR=/data/profiles
 *
 * Each userId gets a deterministic SHA256-hashed subdirectory under profileDir.
 * Storage state is checkpointed on cookie import, session close, and shutdown.
 * On session creation, saved state is restored into the new Playwright context
 * via the session:creating hook (mutates contextOptions.storageState).
 *
 * indexedDB (default: false): opt in to capturing all serializable IndexedDB
 * records in storageState(). This can preserve IndexedDB-backed logins, but
 * may make snapshots significantly larger and checkpoints slower.
 */

import fs from 'node:fs/promises';
import {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';
import { importBootstrapCookies } from '../../lib/cookies.js';

async function removeIfExists(p) {
  try {
    await fs.unlink(p);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;

  // Resolve profileDir: env var > plugin config > global config default (~/.camofox/profiles)
  const profileDir = process.env.CAMOFOX_PROFILE_DIR || pluginConfig.profileDir || config.profileDir;
  if (!profileDir) {
    log('warn', 'persistence plugin: no profileDir configured, plugin disabled');
    return;
  }

  // IndexedDB capture is opt-in because it may persist large amounts of
  // application data and make checkpoints significantly slower.
  const indexedDB = pluginConfig.indexedDB === true;
  ctx.persistenceStorageStateOptions = indexedDB ? { indexedDB: true } : undefined;

  const logger = {
    warn: (msg, fields = {}) => log('warn', msg, fields),
  };

  log('info', 'persistence plugin enabled', { profileDir, indexedDB });

  // Track active sessions and keep at most one running plus one latest pending
  // checkpoint per user. Resetting users skip new work until teardown completes.
  const activeSessions = new Map(); // userId -> context
  const checkpointQueues = new Map(); // userId -> { running, pending }
  const checkpointPromises = new Map(); // userId -> queue-drain promise (may outlive caller timeout)
  const resettingUsers = new Set();
  const checkpointEpochs = new Map();
  const publicationTails = new Map();
  const checkpointTimeoutMs = Number.isFinite(Number(pluginConfig.checkpointTimeoutMs))
    ? Math.max(1, Number(pluginConfig.checkpointTimeoutMs))
    : 5000;

  function withCheckpointTimeout(promise, userId, reason) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `storage checkpoint timed out after ${checkpointTimeoutMs}ms (${userId}, ${reason})`,
        )), checkpointTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function bumpCheckpointEpoch(userId) {
    const epoch = (checkpointEpochs.get(userId) || 0) + 1;
    checkpointEpochs.set(userId, epoch);
    return epoch;
  }

  async function withPublicationLock(userId, operation) {
    const previous = publicationTails.get(userId) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    publicationTails.set(userId, gate);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (publicationTails.get(userId) === gate) publicationTails.delete(userId);
    }
  }

  async function persistCheckpoint({ userId, context, reason, storageState, epoch }) {
    if (resettingUsers.has(userId)) return undefined;
    const result = await persistStorageState({
      profileDir,
      userId,
      context,
      storageState,
      shouldPublish: context
        ? () => !resettingUsers.has(userId)
          && (checkpointEpochs.get(userId) || 0) === epoch
          && activeSessions.get(userId) === context
        : () => !resettingUsers.has(userId) && (checkpointEpochs.get(userId) || 0) === epoch,
      publish: operation => withPublicationLock(userId, operation),
      logger,
      indexedDB,
    });
    if (result.persisted) {
      log('info', 'storage state persisted', { userId, reason, path: result.storageStatePath });
    }
    return result;
  }

  function startCheckpointDrain(userId, queue) {
    if (queue.running) return;
    queue.running = (async () => {
      while (queue.pending) {
        const request = queue.pending;
        queue.pending = null;
        try {
          const result = await persistCheckpoint(request);
          request.resolve(result);
        } catch (err) {
          request.reject(err);
        }
      }
    })().finally(() => {
      queue.running = null;
      checkpointPromises.delete(userId);
      if (queue.pending) startCheckpointDrain(userId, queue);
      else checkpointQueues.delete(userId);
    });
    checkpointPromises.set(userId, queue.running);
  }

  /**
   * Checkpoint storage state to disk for a userId. Bursts coalesce onto the
   * latest pending snapshot while preserving completion for every caller.
   */
  function checkpoint(userId, context, reason, storageState) {
    if ((!context && !storageState) || resettingUsers.has(userId)) return Promise.resolve();
    let queue = checkpointQueues.get(userId);
    if (!queue) {
      queue = { running: null, pending: null };
      checkpointQueues.set(userId, queue);
    }
    if (queue.pending) {
      queue.pending.context = context;
      queue.pending.reason = reason;
      queue.pending.storageState = storageState;
      queue.pending.epoch = checkpointEpochs.get(userId) || 0;
      return queue.pending.promise;
    }
    let resolveRequest;
    let rejectRequest;
    const completion = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const request = {
      userId,
      context,
      reason,
      storageState,
      epoch: checkpointEpochs.get(userId) || 0,
      promise: withCheckpointTimeout(completion, userId, reason),
      resolve: resolveRequest,
      reject: rejectRequest,
    };
    queue.pending = request;
    startCheckpointDrain(userId, queue);
    return request.promise;
  }

  // --- Lifecycle hooks ---

  // Before session context is created: inject storageState if we have one saved
  events.on('session:creating', async ({ userId, contextOptions }) => {
    if (resettingUsers.has(userId)) return;
    const storageStatePath = await withPublicationLock(userId, async () => {
      bumpCheckpointEpoch(userId);
      return loadPersistedStorageState(profileDir, userId, logger);
    });
    if (storageStatePath) {
      contextOptions.storageState = storageStatePath;
      log('info', 'restoring persisted storage state', { userId, storageStatePath });
    }
  });

  // After session is created: import bootstrap cookies if no persisted state,
  // and track the context for later checkpointing
  events.on('session:created', async ({ userId, context }) => {
    bumpCheckpointEpoch(userId);
    activeSessions.set(userId, context);

    // If no persisted state was restored, try bootstrap cookies
    const existingState = await loadPersistedStorageState(profileDir, userId, logger);
    if (!existingState) {
      const result = await importBootstrapCookies({
        cookiesDir: config.cookiesDir,
        context,
        logger,
      });
      if (result.imported > 0) {
        log('info', 'bootstrap cookies imported', { userId, count: result.imported, source: result.source });
        await checkpoint(userId, context, 'bootstrap_cookies');
      }
    }
  });

  // On cookie import: checkpoint
  events.on('session:cookies:import', async ({ userId }) => {
    const context = activeSessions.get(userId);
    if (context) {
      await checkpoint(userId, context, 'cookie_import');
    }
  });

  // When another plugin exports storage state, persist that exact snapshot so
  // the browser is serialized only once and the exported/checkpointed data match.
  events.on('session:storage:export', async ({ userId, context, storageState }) => {
    if (!context || activeSessions.get(userId) !== context || !storageState) return;
    await checkpoint(userId, context, 'storage_export', storageState);
  });

  // On session destroying (pre-close): checkpoint while context is still alive.
  // Teardown without the exact context identity is ambiguous and must not touch
  // a possibly newer replacement session.
  events.on('session:destroying', async ({ userId, context: eventContext, reason }) => {
    const trackedContext = activeSessions.get(userId);
    if (!eventContext || trackedContext !== eventContext) return;
    if (reason !== 'storage_reset') {
      await checkpoint(userId, eventContext, reason).catch(() => {});
    }
    if (activeSessions.get(userId) === eventContext) activeSessions.delete(userId);
  });

  // On session destroyed (post-close): cleanup only the exact tracked context.
  events.on('session:destroyed', async ({ userId, context }) => {
    if (context && activeSessions.get(userId) === context) activeSessions.delete(userId);
  });

  // On shutdown: checkpoint all remaining sessions
  events.on('server:shutdown', async () => {
    await Promise.allSettled([...activeSessions].map(([userId, context]) =>
      checkpoint(userId, context, 'shutdown')));
    activeSessions.clear();
  });

  app.delete('/sessions/:userId/storage_state', ctx.auth(), async (req, res) => {
    const userId = ctx.normalizeUserId(req.params.userId);
    if (resettingUsers.has(userId)) {
      return res.status(409).json({ error: 'storage state reset already in progress' });
    }

    resettingUsers.add(userId);
    try {
      const clearedLive = await ctx.destroySession(userId, { reason: 'storage_reset' });
      const removedPersisted = await withPublicationLock(userId, async () => {
        bumpCheckpointEpoch(userId);
        const { storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
        const removed = await removeIfExists(storageStatePath);
        await removeIfExists(metaPath);
        return removed;
      });

      log('info', 'session storage state reset', {
        reqId: req.reqId,
        userId,
        clearedLive,
        removedPersisted,
      });
      res.json({ ok: true, userId, clearedLive, removedPersisted });
    } catch (err) {
      log('error', 'storage state reset failed', { reqId: req.reqId, userId, error: err.message });
      res.status(500).json({ error: ctx.safeError(err) });
    } finally {
      resettingUsers.delete(userId);
    }
  });

  log('info', 'persistence plugin: registered DELETE /sessions/:userId/storage_state');
}
