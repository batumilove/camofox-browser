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

  test('server wires POST /tabs through admission and serializes admission errors', () => {
    expect(serverSrc).toContain("from './lib/tab-admission.js'");
    expect(serverSrc).toMatch(/app\.post\('\/tabs'[\s\S]*tabAdmission\.run\(/);
    expect(serverSrc).toMatch(/TabAdmissionError[\s\S]*Retry-After/);
  });
});
