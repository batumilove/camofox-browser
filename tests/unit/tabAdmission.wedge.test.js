import { jest } from '@jest/globals';
import {
  TabAdmissionController,
  TabCapacityReservations,
  canReapEmptySession,
  releaseOnAbort,
  reservePendingTabCreation,
} from '../../lib/tab-admission.js';

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

describe('wedged-cleanup slot leakage (2026-09-09/10 incidents)', () => {
  test('operation timeout releases admission capacity even when the aborted operation never settles', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 4,
        maxActivePerUser: 1,
        maxPending: 8,
        operationTimeoutMs: 100,
      });

      // Four operations abort at the timeout but their promises NEVER settle
      // (hung Playwright cleanup — the exact incident signature).
      const hung = [0, 1, 2, 3].map(() => deferred());
      const firsts = hung.map((gate, i) =>
        controller.run(`user-${i}`, (signal) => {
          void signal;
          return gate.promise;
        }),
      );
      await flush();

      expect(controller.snapshot().active).toBe(4);

      const rejections = firsts.map((p) =>
        expect(p).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' }),
      );
      await jest.advanceTimersByTimeAsync(100);
      await Promise.all(rejections);

      // Capacity must be released even though the four timed-out operations
      // never settle. The 2026-09-09/10 incident produced this exact shape:
      // all four active slots stayed occupied and unrelated profiles received
      // tab_admission_wait_timeout until targeted stale-tab cleanup.
      const fifth = controller.run('recovery-user', async () => 'recovered');
      await flush();
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 0 });
      await expect(fifth).resolves.toBe('recovered');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('late settlement after slot reclamation does not corrupt counters', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 4,
        operationTimeoutMs: 50,
      });
      const gate = deferred();
      let settleLate;
      const first = controller.run('u1', (signal) => {
        settleLate = (error) => {
          void signal;
          error ? gate.reject(error) : gate.resolve('late');
        };
        return gate.promise;
      });
      const rejection = expect(first).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });
      await flush();
      await jest.advanceTimersByTimeAsync(50);
      await rejection;

      settleLate(null);
      await flush();
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });

      const second = controller.run('u2', async () => 'next');
      await expect(second).resolves.toBe('next');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('operation timeout also releases resident-capacity and pending-creation reservations', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 2,
        operationTimeoutMs: 50,
      });
      const capacity = new TabCapacityReservations({
        maxGlobal: 1,
        maxPerUser: 1,
        getGlobalCount: () => 0,
        getUserCount: () => 0,
      });
      const session = { tabGroups: new Map() };

      const timedOut = controller.run('wedged-user', async (signal) => {
        const releaseCapacity = releaseOnAbort(signal, capacity.reserve('wedged-user'));
        const releasePending = releaseOnAbort(signal, reservePendingTabCreation(session));
        try {
          await new Promise(() => {});
        } finally {
          releasePending();
          releaseCapacity();
        }
      });
      const rejection = expect(timedOut).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });
      await flush();
      expect(session._pendingTabCreations).toBe(1);
      await jest.advanceTimersByTimeAsync(50);
      await rejection;

      expect(session._pendingTabCreations).toBe(0);
      expect(canReapEmptySession(session)).toBe(true);
      const releaseNext = capacity.reserve('recovery-user');
      releaseNext();
    } finally {
      jest.useRealTimers();
    }
  });
});
