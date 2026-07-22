import { jest } from '@jest/globals';
import { createOwnedResource, withTemporaryResource } from '../../lib/bounded-resource-creation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('bounded resource creation', () => {
  test('pre-aborted signals do not acquire leases or invoke factories', async () => {
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    const target = { newPage: jest.fn() };
    const acquire = jest.fn();
    await expect(createOwnedResource({
      target,
      method: 'newPage',
      signals: [controller.signal],
      acquire,
    })).rejects.toBe(reason);
    expect(acquire).not.toHaveBeenCalled();
    expect(target.newPage).not.toHaveBeenCalled();
  });

  test('a timed-out raw result is observed, cleaned, and only then releases ownership', async () => {
    jest.useFakeTimers();
    try {
      const raw = deferred();
      const settle = jest.fn();
      const cleanup = jest.fn(async () => {});
      const creating = createOwnedResource({
        target: { newPage: () => raw.promise },
        method: 'newPage',
        timeoutMs: 25,
        acquire: () => ({ settle }),
        cleanup,
        label: 'test page',
      });
      const rejected = expect(creating).rejects.toMatchObject({ code: 'resource_creation_timeout' });
      await jest.advanceTimersByTimeAsync(25);
      await rejected;
      expect(settle).not.toHaveBeenCalled();
      const late = { id: 'late-page' };
      raw.resolve(late);
      await flush();
      expect(cleanup).toHaveBeenCalledWith(late);
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('temporary resources release raw-creation ownership before bounded operation cleanup', async () => {
    const calls = [];
    const resource = { id: 'temporary' };
    const result = await withTemporaryResource({
      target: { newPage: async () => resource },
      method: 'newPage',
      acquire: () => ({ settle: () => calls.push('settle') }),
      cleanup: async value => calls.push(`cleanup:${value.id}`),
    }, async value => {
      calls.push(`operate:${value.id}`);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toEqual(['settle', 'operate:temporary', 'cleanup:temporary']);
  });

  test('caller abort rejects promptly and late settlement is still disposed', async () => {
    const raw = deferred();
    const controller = new AbortController();
    const cleanup = jest.fn(async () => {});
    const settle = jest.fn();
    const creating = createOwnedResource({
      target: { newContext: () => raw.promise },
      method: 'newContext',
      signals: [controller.signal],
      acquire: () => ({ settle }),
      cleanup,
    });
    const reason = new Error('client disconnected');
    controller.abort(reason);
    await expect(creating).rejects.toBe(reason);
    raw.resolve({ id: 'late-context' });
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
