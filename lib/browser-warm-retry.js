export function shouldSuppressBrowserWarmRetry({
  isStopping,
  retryGeneration,
  currentGeneration,
  lastStopReason,
  intentionalStopReasons,
}) {
  return Boolean(isStopping)
    || retryGeneration !== currentGeneration
    || intentionalStopReasons.has(lastStopReason);
}

export function nextBrowserStopReason({
  currentReason,
  incomingReason,
  closeInFlight,
  intentionalStopReasons,
}) {
  if (!closeInFlight || intentionalStopReasons.has(incomingReason)) {
    return incomingReason;
  }
  return currentReason;
}
