import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const serverSrc = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

function functionSource(name, nextName) {
  const start = serverSrc.indexOf(`async function ${name}(`);
  const end = serverSrc.indexOf(`async function ${nextName}(`, start);
  return serverSrc.slice(start, end);
}

describe('lifecycle review gap contracts', () => {
  test('session startup completes trace and created hooks before publication', () => {
    const source = functionSource('getSession', 'createLeasedPage');
    const traceStart = source.indexOf('await context.tracing.start(');
    const createdHook = source.indexOf("await pluginEvents.emitAsync('session:created'");
    const publish = source.indexOf('sessions.set(key, created)', createdHook);

    expect(traceStart).toBeGreaterThan(-1);
    expect(createdHook).toBeGreaterThan(traceStart);
    expect(publish).toBeGreaterThan(createdHook);
    expect(source).toMatch(/tracing\.start[\s\S]*catch \(err\) \{[\s\S]*await context\.close\(\)[\s\S]*throw err/);
    expect(source).toMatch(/emitAsync\('session:created'[\s\S]*assertSessionCreationCurrent[\s\S]*sessions\.set\(key, created\)/);
  });

  test('failed page close retains bookkeeping and blocks recycling', () => {
    const safeClose = functionSource('safePageClose', 'restartBrowser');
    const recycle = functionSource('recycleOldestTab', 'destroySession');

    expect(safeClose).toContain('return false');
    expect(safeClose).toContain('return true');
    expect(recycle).toMatch(/if \(!await safePageClose\(oldestTab\.page\)\) return null/);
    expect(recycle.indexOf('safePageClose(oldestTab.page)')).toBeLessThan(recycle.indexOf('oldestGroup.delete(oldestTabId)'));
  });

  test('graceful shutdown suppresses retries and participates in stop coordination', () => {
    const start = serverSrc.indexOf('async function gracefulShutdown(');
    const end = serverSrc.indexOf("process.on('SIGTERM'", start);
    const source = serverSrc.slice(start, end);
    expect(source).toContain('clearBrowserWarmRetry()');
    expect(source).toContain("closeBrowserFully(`shutdown:${signal}`)");
    expect(source).toMatch(/browserStopCoordinator\.run\([\s\S]*closeBrowserFully/);
  });
});
