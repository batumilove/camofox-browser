import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, jest, test } from '@jest/globals';
import { TabAdmissionController, TabAdmissionError } from '../../lib/tab-admission.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '..', '..', 'server.js'), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

describe('POST /tabs admission recovery', () => {
  test('timed-out raw creations stay bounded across retries', async () => {
    const raw = deferred();
    const create = jest.fn(() => raw.promise);
    const admission = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxAbandoned: 1,
      waitTimeoutMs: 10,
      operationTimeoutMs: 10,
      retryAfter: 2,
    });

    const first = admission.run('user-a', create);
    await expect(first).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });

    for (let i = 0; i < 3; i += 1) {
      await expect(admission.run('user-a', create)).rejects.toMatchObject({
        code: 'tab_admission_abandoned_saturated',
        retryAfter: 2,
      });
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(admission.snapshot()).toMatchObject({ active: 0, abandoned: 1 });

    raw.resolve('late-page');
    await new Promise(resolve => setImmediate(resolve));
    expect(admission.snapshot()).toMatchObject({ active: 0, abandoned: 0 });
    await expect(admission.run('user-a', async () => 'ok')).resolves.toBe('ok');
  });

  test('429 errors carry a machine-readable code and Retry-After value', () => {
    const error = new TabAdmissionError('busy', {
      code: 'tab_admission_wait_timeout',
      retryAfter: 2,
    });
    expect(error).toMatchObject({ statusCode: 429, code: 'tab_admission_wait_timeout', retryAfter: 2 });
  });

  test('waiting requests stay bounded globally and per user', async () => {
    const raw = deferred();
    const admission = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxWaiting: 2,
      maxWaitingPerUser: 1,
      waitTimeoutMs: 1000,
      operationTimeoutMs: 1000,
    });
    const active = admission.run('user-a', () => raw.promise);
    await new Promise(resolve => setImmediate(resolve));
    const waitingA = admission.run('user-a', async () => 'a');

    await expect(admission.run('user-a', async () => 'overflow-user')).rejects.toMatchObject({
      code: 'tab_admission_wait_saturated',
    });
    const waitingB = admission.run('user-b', async () => 'b');
    await expect(admission.run('user-c', async () => 'overflow-global')).rejects.toMatchObject({
      code: 'tab_admission_wait_saturated',
    });
    expect(admission.snapshot().waiting).toBe(2);

    raw.resolve('active');
    await expect(active).resolves.toBe('active');
    await expect(waitingA).resolves.toBe('a');
    await expect(waitingB).resolves.toBe('b');
  });

  test('shutdown rejects queued/new work and waits for active raw work to settle', async () => {
    const raw = deferred();
    const admission = new TabAdmissionController({ maxActive: 1, waitTimeoutMs: 1000 });
    const active = admission.run('active', () => raw.promise);
    await new Promise(resolve => setImmediate(resolve));
    const waiting = admission.run('waiting', async () => 'never');

    admission.shutdown();
    await expect(waiting).rejects.toMatchObject({
      code: 'tab_admission_shutting_down',
      statusCode: 503,
    });
    await expect(admission.run('new', async () => 'never')).rejects.toMatchObject({
      code: 'tab_admission_shutting_down',
    });

    let settled = false;
    const drained = admission.waitForSettled().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    raw.resolve('done');
    await expect(active).resolves.toBe('done');
    await drained;
    expect(settled).toBe(true);
  });

  test('server wires POST /tabs through admission and serializes admission errors', () => {
    expect(serverSrc).toContain("from './lib/tab-admission.js'");
    expect(serverSrc).toMatch(/app\.post\('\/tabs'[\s\S]*tabAdmission\.run\(/);
    expect(serverSrc).toMatch(/TabAdmissionError[\s\S]*Retry-After/);
  });
});
