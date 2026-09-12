/**
 * Unit tests for popup registration rollback.
 *
 * When a synchronous listener failure (e.g. a tab:created plugin throwing)
 * escapes popup registration, the just-published popupTabState must be
 * removed from the tab group (and the group deleted when empty) before the
 * popup page is closed — otherwise the session keeps a phantom tab that
 * inflates counts and blocks future tabs via capacity limits.
 */

import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const popupHandler = source.match(/function attachPopupHandler[\s\S]*?\n}\n/)?.[0] ?? '';

describe('popup registration rollback', () => {
  test('attachPopupHandler exists and publishes to a tab group', () => {
    expect(popupHandler).not.toBe('');
    expect(popupHandler).toContain("popupGroup.set(popupTabId, popupTabState)");
  });

  test('registration failure removes the published popup state before closing the page', () => {
    // The registration body (from popupGroup.set through the recursive
    // attachPopupHandler call) must be guarded by a catch that rolls back
    // the exact published state.
    const setIndex = popupHandler.indexOf('popupGroup.set(popupTabId, popupTabState)');
    expect(setIndex).toBeGreaterThan(-1);
    const afterSet = popupHandler.slice(setIndex);
    const catchIndex = afterSet.indexOf('} catch');
    expect(catchIndex).toBeGreaterThan(-1);
    const catchBody = afterSet.slice(catchIndex);
    // rollback must delete the exact tab id from the group
    expect(catchBody).toMatch(/popupGroup\.delete\(popupTabId\)/);
    // and remove the group entirely when it becomes empty
    expect(catchBody).toMatch(/popupGroup\.size === 0[\s\S]*?tabGroups\.delete\(popupGroupKey\)/);
    // rollback must precede the page close
    const deleteIndex = catchBody.indexOf('popupGroup.delete(popupTabId)');
    const closeIndex = catchBody.indexOf('safePageClose(popupPage');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(deleteIndex);
  });

  test('popup page close failure on the rollback path is swallowed, not rethrown', () => {
    const setIndex = popupHandler.indexOf('popupGroup.set(popupTabId, popupTabState)');
    const catchBody = popupHandler.slice(setIndex).slice(popupHandler.slice(setIndex).indexOf('} catch'));
    const closeMatch = catchBody.match(/safePageClose\(popupPage[^)]*\)[\s\S]{0,40}/);
    expect(closeMatch).not.toBeNull();
    expect(closeMatch[0]).toMatch(/\.catch\(\(\) => \{\}\)|\.catch\(\(\) =>\s*\{\}\)/);
  });

  test('every operation after reservation acquisition is covered by the releaseReservation finally', () => {
    // From a successful reserveTab() to the end of the handler, a throw in
    // any synchronous step (makeTabId, createTabState, getTabGroup, set)
    // must still run releaseReservation() exactly once.
    const reserveIndex = popupHandler.indexOf('capacityReservations.reserveTab(');
    expect(reserveIndex).toBeGreaterThan(-1);
    const rejectIndex = popupHandler.indexOf('if (!releaseReservation)');
    expect(rejectIndex).toBeGreaterThan(reserveIndex);
    const afterReject = popupHandler.slice(rejectIndex);
    const outerTryIndex = afterReject.indexOf('try {');
    expect(outerTryIndex).toBeGreaterThan(-1);
    // the outer try must begin before any registration work
    const makeTabIdIndex = afterReject.indexOf('fly.makeTabId()');
    expect(makeTabIdIndex).toBeGreaterThan(outerTryIndex);
    // and the final finally of the handler must release the reservation
    const finallys = [...afterReject.matchAll(/finally \{/g)].map((m) => m.index);
    expect(finallys.length).toBeGreaterThan(0);
    const lastFinally = afterReject.slice(finallys[finallys.length - 1]);
    expect(lastFinally).toMatch(/releaseReservation\(\)/);
    // no code path exits the handler between the rejection block and the outer try
    const rejectBlockEnd = afterReject.search(/\n    }\n/);
    expect(rejectBlockEnd).toBeGreaterThan(-1);
    const between = afterReject.slice(rejectBlockEnd, outerTryIndex);
    expect(between).not.toMatch(/return/);
  });
});
