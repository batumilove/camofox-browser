async function runWithin(operation, timeoutMs) {
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(operation).then(
      () => ({ timedOut: false }),
      error => ({ timedOut: false, error }),
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (result.error) throw result.error;
  return result.timedOut;
}

export async function runBoundedShutdownPhases({
  settle,
  checkpoint,
  settleBudgetMs = 2500,
  checkpointBudgetMs = 5500,
  onPhaseTimeout = () => {},
}) {
  if (await runWithin(settle, settleBudgetMs)) onPhaseTimeout('settle');
  if (await runWithin(checkpoint, checkpointBudgetMs)) onPhaseTimeout('checkpoint');
}
