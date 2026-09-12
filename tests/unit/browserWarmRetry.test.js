import { describe, expect, test } from '@jest/globals';
import {
  nextBrowserStopReason,
  shouldSuppressBrowserWarmRetry,
} from '../../lib/browser-warm-retry.js';

const intentionalStopReasons = new Set(['idle_shutdown', 'admin_stop']);

function suppress(overrides = {}) {
  return shouldSuppressBrowserWarmRetry({
    isStopping: false,
    retryGeneration: 7,
    currentGeneration: 7,
    lastStopReason: null,
    intentionalStopReasons,
    ...overrides,
  });
}

describe('browser warm retry suppression', () => {
  test('blocks scheduling while an admin stop is still settling', () => {
    expect(suppress({ isStopping: true })).toBe(true);
  });

  test('blocks a startup failure retry after a no-browser admin stop settles', () => {
    expect(suppress({ lastStopReason: 'admin_stop' })).toBe(true);
  });

  test('blocks an already-fired retry after launch generation invalidation', () => {
    expect(suppress({ currentGeneration: 8 })).toBe(true);
  });

  test('allows a current retry when no stop is active or recorded', () => {
    expect(suppress()).toBe(false);
  });
});

describe('browser stop reason coalescing', () => {
  test('promotes an in-flight unexpected close to admin_stop', () => {
    expect(nextBrowserStopReason({
      currentReason: 'browser_restart',
      incomingReason: 'admin_stop',
      closeInFlight: true,
      intentionalStopReasons,
    })).toBe('admin_stop');
  });

  test('does not downgrade an in-flight admin stop', () => {
    expect(nextBrowserStopReason({
      currentReason: 'admin_stop',
      incomingReason: 'browser_restart',
      closeInFlight: true,
      intentionalStopReasons,
    })).toBe('admin_stop');
  });

  test('a new close replaces a historical intentional reason', () => {
    expect(nextBrowserStopReason({
      currentReason: 'admin_stop',
      incomingReason: 'browser_restart',
      closeInFlight: false,
      intentionalStopReasons,
    })).toBe('browser_restart');
  });
});
