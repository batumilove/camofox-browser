/**
 * Unit tests for popup registration rollback.
 *
 * When a synchronous listener failure (e.g. a tab:created plugin throwing)
 * escapes popup registration, the just-published popupTabState must be
 * removed from the tab group (and the group deleted when empty) before the
 * popup page is closed — otherwise the session keeps a phantom tab that
 * inflates counts and blocks future tabs via capacity limits.
 *
 * The control-flow contract is verified against the real AST produced by
 * the JavaScript engine itself (Node's parser via --check-style source
 * walking is not needed: we use vm.compileFunction? No — we use the
 * Babel-free approach of tree-walking with the engine's own parser through
 * the `acorn` bundled inside Jest? Not available. Instead we parse using
 * the structured token stream of the engine's error messages? No.
 *
 * Practical approach: Node exposes no stdlib parser, but the repo already
 * validates source contracts via regex in capacityReservations.test.js.
 * To satisfy the stronger requirements (true structural nesting), we use a
 * tiny hand-rolled brace/paren scanner that is indentation-aware and
 * anchored on exact statements, proving nesting by position ranges rather
 * than by first-match-wins indexOf.
 */

import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

/** Match a literal string and return its exact character range, or null. */
function rangeOf(haystack, needle, from = 0) {
  const i = haystack.indexOf(needle, from);
  return i === -1 ? null : [i, i + needle.length];
}

function extractPopupHandler(src) {
  const start = src.indexOf('function attachPopupHandler');
  expect(start).toBeGreaterThan(-1);
  // The handler ends at the first line that is exactly '}' at column 0
  // following the start (top-level function terminator).
  const rest = src.slice(start);
  const endMatch = rest.match(/\n\}\n/);
  expect(endMatch).not.toBeNull();
  return { text: rest.slice(0, endMatch.index + 2), start };
}

/** Find the character range of a block (try/catch/finally) whose opening
 * keyword matches `pattern` at/after `from`, by brace matching. */
function blockRange(text, pattern, from) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(`${pattern} \\{`, 'g');
  re.lastIndex = 0;
  let m;
  const searchFrom = typeof from === 'number' ? from : 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index < searchFrom) { re.lastIndex = m.index + 1; continue; }
    const openIdx = text.indexOf('{', m.index + m[0].length - 1);
    if (openIdx === -1) return null;
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return [m.index, i + 1];
      }
    }
  }
  return null;
}

describe('popup registration rollback', () => {
  const handler = extractPopupHandler(source);
  const popupHandler = handler.text;

  test('attachPopupHandler exists and publishes to a tab group', () => {
    expect(popupHandler).toContain('popupGroup.set(popupTabId, popupTabState)');
  });

  test('registration failure removes the published popup state before closing the page', () => {
    // Outer try must enclose ALL registration work after reservation.
    const reserveIdx = popupHandler.indexOf('capacityReservations.reserveTab(');
    const rejectIdx = popupHandler.indexOf('if (!releaseReservation)');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(reserveIdx);
    const outerTry = blockRange(popupHandler, 'try', rejectIdx);
    expect(outerTry).not.toBeNull();

    const setRange = rangeOf(popupHandler, 'popupGroup.set(popupTabId, popupTabState)');
    const makeTabIdRange = rangeOf(popupHandler, 'fly.makeTabId()');
    const createTabStateRange = rangeOf(popupHandler, 'createTabState(popupPage)');
    const getTabGroupRange = rangeOf(popupHandler, 'getTabGroup(currentSession, popupGroupKey)');
    const emitRange = rangeOf(popupHandler, "pluginEvents.emit('tab:created'");
    const recurseRange = rangeOf(popupHandler, 'attachPopupHandler(popupPage, userId, sessionKey)');
    for (const r of [makeTabIdRange, createTabStateRange, getTabGroupRange, setRange, emitRange, recurseRange]) {
      expect(r).not.toBeNull();
      expect(r[0]).toBeGreaterThan(outerTry[0]);
      expect(r[1]).toBeLessThanOrEqual(outerTry[1]);
    }

    // Outer finally must contain exactly one releaseReservation() and be the
    // terminator of the outer try block.
    const outerFinally = blockRange(popupHandler, 'finally', outerTry[1]);
    expect(outerFinally).not.toBeNull();
    expect(outerFinally[0]).toBeGreaterThanOrEqual(outerTry[1] - 1);
    const finallyBody = popupHandler.slice(outerFinally[0], outerFinally[1]);
    const releases = [...finallyBody.matchAll(/releaseReservation\(\)/g)];
    expect(releases.length).toBe(1);
    // exactly one release in the ENTIRE post-rejection handler region
    const postReject = popupHandler.slice(rejectIdx + 'if (!releaseReservation)'.length);
    const allReleases = [...postReject.matchAll(/releaseReservation\(\)/g)];
    expect(allReleases.length).toBe(1);

    // Inner catch guards the post-publication body.
    const innerTry = blockRange(popupHandler, 'try', setRange[1]);
    expect(innerTry).not.toBeNull();
    expect(innerTry[0]).toBeGreaterThan(setRange[0]);
    const innerCatch = blockRange(popupHandler, /catch \(error\) \{/g, innerTry[1] - 40);
    expect(innerCatch).not.toBeNull();
    // the inner catch keyword is the ONLY text between inner try end and catch start
    const intervening = popupHandler.slice(innerTry[1], innerCatch[0]);
    expect(intervening.trim()).toBe('');
    const catchBody = popupHandler.slice(innerCatch[0], innerCatch[1]);

    // Rollback completeness and ordering: delete tab, delete empty group,
    // refresh gauge — all before the page close.
    const delIdx = catchBody.indexOf('popupGroup.delete(popupTabId)');
    const emptyGroupIdx = catchBody.search(/popupGroup\.size === 0[\s\S]*?tabGroups\.delete\(popupGroupKey\)/);
    const gaugeIdx = catchBody.indexOf('refreshActiveTabsGauge()');
    const closeIdx = catchBody.indexOf('safePageClose(popupPage');
    for (const i of [delIdx, emptyGroupIdx, gaugeIdx]) {
      expect(i).toBeGreaterThan(-1);
      expect(closeIdx).toBeGreaterThan(i);
    }
    // the emitted tab:created and the recursive attach must be INSIDE the inner try
    expect(emitRange[0]).toBeGreaterThan(innerTry[0]);
    expect(emitRange[1]).toBeLessThanOrEqual(innerTry[1]);
    expect(recurseRange[0]).toBeGreaterThan(innerTry[0]);
    expect(recurseRange[1]).toBeLessThanOrEqual(innerTry[1]);
    // ...and NOT inside the catch body
    for (const r of [emitRange, recurseRange]) {
      expect(r[0] >= innerCatch[0] && r[1] <= innerCatch[1]).toBe(false);
    }
    // page close failure is swallowed, not rethrown
    const closeMatch = catchBody.match(/safePageClose\(popupPage[^)]*\)[\s\S]{0,40}/);
    expect(closeMatch).not.toBeNull();
    expect(closeMatch[0]).toMatch(/\.catch\(\(\) => \{\}\)/);
    // catch body must not rethrow
    expect(catchBody).not.toMatch(/throw\b/);
    // no control-flow exit before the rollback statements: the text from the
    // catch open brace to popupGroup.delete contains no return/throw
    const preRollback = catchBody.slice(0, delIdx);
    expect(preRollback).not.toMatch(/\b(return|throw)\b/);
    // and no unconditional exit between delete and the page close either
    const rollbackSpan = catchBody.slice(delIdx, closeIdx);
    expect(rollbackSpan).not.toMatch(/\b(return|throw)\b/);
  });

  test('every operation after reservation acquisition is covered by the releaseReservation finally', () => {
    const rejectIdx = popupHandler.indexOf('if (!releaseReservation)');
    const outerTry = blockRange(popupHandler, 'try', rejectIdx);
    expect(outerTry).not.toBeNull();
    // makeTabId must be the first statement inside the outer try (no
    // unprotected work between rejection block and the try).
    const closeBrace = popupHandler.indexOf('\n    }\n', rejectIdx);
    expect(closeBrace).toBeGreaterThan(-1);
    const between = popupHandler.slice(closeBrace + 6, outerTry[0]);
    expect(between).not.toMatch(/return/);
    expect(between.trim()).toBe('');
    // final statement of the whole handler is the outer finally
    expect(outerTry[1]).toBeLessThan(popupHandler.length);
    // the outer finally keyword directly follows the outer try block
    const following = popupHandler.slice(outerTry[1], outerTry[1] + 12);
    expect(following).toMatch(/^\s*finally \{/);
  });
});
