import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runBoundedShutdownPhases } from '../../lib/shutdown-budget.js';

const serverSource = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

describe('bounded shutdown phases', () => {
  test('starts checkpointing after the settle budget even when draining hangs', async () => {
    const settleGate = Promise.withResolvers();
    const checkpoint = jest.fn(async () => {});
    const onPhaseTimeout = jest.fn();

    await runBoundedShutdownPhases({
      settle: () => settleGate.promise,
      checkpoint,
      settleBudgetMs: 10,
      checkpointBudgetMs: 20,
      onPhaseTimeout,
    });

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(onPhaseTimeout).toHaveBeenCalledWith('settle');
    settleGate.resolve();
  });

  test('bounds a hung checkpoint phase', async () => {
    const checkpointGate = Promise.withResolvers();
    const onPhaseTimeout = jest.fn();

    await runBoundedShutdownPhases({
      settle: async () => {},
      checkpoint: () => checkpointGate.promise,
      settleBudgetMs: 20,
      checkpointBudgetMs: 10,
      onPhaseTimeout,
    });

    expect(onPhaseTimeout).toHaveBeenCalledWith('checkpoint');
    checkpointGate.resolve();
  });

  test('server reserves bounded shutdown time for checkpoint hooks', () => {
    const shutdown = serverSource.match(/async function gracefulShutdown[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(shutdown).toMatch(/runBoundedShutdownPhases\(\{/);
    expect(shutdown).toMatch(/settle: \(\) => Promise\.all/);
    expect(shutdown).toMatch(/checkpoint: \(\) => pluginEvents\.emitAsync\('server:shutdown'/);
  });
});
