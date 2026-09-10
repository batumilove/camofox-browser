const { readFileSync } = process.getBuiltinModule('fs');
const { join } = process.getBuiltinModule('path');

const read = path => readFileSync(join(process.cwd(), path), 'utf8');

describe('browser creation ownership source contract', () => {
  test('server and plugins isolate raw Playwright context/page factories behind ownership wrappers', () => {
    const server = read('server.js');
    expect(server).not.toMatch(/\.newContext\s*\(/);
    expect(server.match(/\.newPage\s*\(/g)).toHaveLength(1);
    expect(server).toContain('async function createLeasedPage(session)');

    const guarded = [
      'plugins/youtube/index.js',
      'plugins/persistence/index.js',
    ];
    for (const path of guarded) {
      const source = read(path);
      expect(source).not.toMatch(/\.newContext\s*\(/);
      expect(source).not.toMatch(/\.newPage\s*\(/);
    }
  });

  test('raw page factory remains isolated behind recovery ownership', () => {
    const source = read('lib/new-page-recovery.js');
    expect(source.match(/\.newPage\s*\(/g)).toHaveLength(1);
    expect(source).toContain('reserveRawCreation');
    expect(source).toContain('cleanupLatePage');
  });

  test('generic resource creation invokes only a selected owned method', () => {
    const source = read('lib/bounded-resource-creation.js');
    expect(source).toContain('target?.[method]');
    expect(source).toContain('lease.settle?.()');
    expect(source).toContain('Always observe the raw settlement');
  });

  test('managed removal paths transfer failed closes to owned cleanup', () => {
    const server = read('server.js');
    expect(server).toContain("await closeOwnedPage(resource.page, 'tab_creation_abort', effectiveSession)");
    expect(server).toContain('releasePageLease(effectiveSession, resource.lease)');
    expect(server).toContain("await closeOwnedPage(found.tabState.page, 'tab_delete', session)");
    expect(server).toContain("await closeOwnedPage(tabState.page, 'tab_group_delete', session)");
    expect(server).toContain("void closeOwnedPage(tabState.page, 'tab_inactivity_reaper', session)");
    expect(server).toContain("cleanupLatePage: page => closeOwnedPage(page, 'late_page_recovery')");
    expect(server).toContain('return Boolean(cleaned || orphanPageCleanup.owns(page))');
    expect(server).toContain('browserGeneration: pageBrowser?._camofoxGeneration ?? null');
    expect(server).not.toContain("closeBrowserFully(`unowned_page:");
    expect(server).toContain('const ownerEpoch = session?.browserGeneration ?? null');
    expect(server).not.toContain('ownerEpoch: browserGeneration');
  });

  test('session publication and teardown require completed hooks and verified ownership', () => {
    const server = read('server.js');
    const hookIdx = server.indexOf("await pluginEvents.emitAsync('session:created'");
    const browserCheckIdx = server.indexOf('if (browser !== b || !b.isConnected())', hookIdx);
    const publishIdx = server.indexOf('sessions.set(key, created)', hookIdx);
    expect(hookIdx).toBeGreaterThan(-1);
    expect(browserCheckIdx).toBeGreaterThan(hookIdx);
    expect(publishIdx).toBeGreaterThan(browserCheckIdx);

    const closeStart = server.indexOf('async function closeSessionImpl');
    const closeEnd = server.indexOf('async function closeAllSessions', closeStart);
    const closeSection = server.slice(closeStart, closeEnd);
    const proofCheckIdx = closeSection.indexOf("terminationProof?.terminated !== true || !proofMatchesOwner");
    const deleteIdx = closeSection.indexOf('deleteSessionMappingIfCurrent');
    expect(proofCheckIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(proofCheckIdx);

    expect(server).toContain('proof?.terminated === true && proofMatchesOwner');
    expect(server).toContain("raw page creation ownership retained after unverified teardown");
    expect(server).toContain('scheduleSessionCloseRetry(userId, session, options)');
    expect(server).toContain('closingSessions.delete(session)');
  });

  test('graceful shutdown closes session creation before snapshotting published sessions', () => {
    const server = read('server.js');
    const shutdownStart = server.indexOf('async function gracefulShutdown');
    const shutdownEnd = server.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdownSection = server.slice(shutdownStart, shutdownEnd);
    const creationBarrier = shutdownSection.indexOf('await sessionCreationCoordinator.shutdown(');
    const sessionSnapshot = shutdownSection.indexOf('await closeAllSessions(');

    expect(creationBarrier).toBeGreaterThan(-1);
    expect(sessionSnapshot).toBeGreaterThan(creationBarrier);
  });

  test('browser restart barriers session creation before snapshot and relaunch', () => {
    const server = read('server.js');
    const restartStart = server.indexOf('async function restartBrowser');
    const restartEnd = server.indexOf('function getTotalTabCount', restartStart);
    const restartSection = server.slice(restartStart, restartEnd);
    const creationBarrier = restartSection.indexOf('await sessionCreationCoordinator.barrier(');
    const sessionSnapshot = restartSection.indexOf('await closeAllSessions(');
    const browserClose = restartSection.indexOf('await closeBrowserFully(');
    const browserRelaunch = restartSection.indexOf('await ensureBrowser()');

    expect(creationBarrier).toBeGreaterThan(-1);
    expect(sessionSnapshot).toBeGreaterThan(creationBarrier);
    expect(browserClose).toBeGreaterThan(sessionSnapshot);
    expect(browserRelaunch).toBeGreaterThan(browserClose);
  });

  test('raw creation retry stays registry-owned and verified retirement releases page leases', () => {
    const server = read('server.js');
    const pageDeadlineStart = server.indexOf('async function handleRawPageCreationDeadline');
    const pageDeadlineEnd = server.indexOf('const rawPageCreations', pageDeadlineStart);
    const pageDeadlineSection = server.slice(pageDeadlineStart, pageDeadlineEnd);
    const browserDeadlineStart = server.indexOf('async function handleRawBrowserOwnerDeadline');
    const browserDeadlineEnd = server.indexOf('async function handleRawContextOwnerDeadline', browserDeadlineStart);
    const browserDeadlineSection = server.slice(browserDeadlineStart, browserDeadlineEnd);

    expect(pageDeadlineSection).toContain("code: 'raw_page_creation_teardown_unverified'");
    expect(browserDeadlineSection).toContain("code: 'raw_browser_creation_teardown_unverified'");
    expect(pageDeadlineSection).not.toContain('setTimeout(');
    expect(browserDeadlineSection).not.toContain('setTimeout(');
    expect(server).toContain('reserveRawCreation: (activeSession, label, { onRetire } = {})');
    expect(server).toContain('onRetire,');
    expect(read('lib/new-page-recovery.js')).toContain('onRetire: () => releasePageLease(activeSession, lease)');
  });

  test('popup adoption is bound to its originating context and generation', () => {
    const server = read('server.js');
    expect(server).toContain('function attachPopupHandler(page, userId, sessionKey, ownerSession)');
    expect(server).toContain('popupOwnerIsCurrent({');
    expect(server).toContain('currentSession: sessions.get(key)');
    expect(server).toContain("closeOwnedPage(popupPage, 'popup_owner_unavailable', ownerSession)");
  });

  test('candidate and stale-session teardown remain generation and process scoped', () => {
    const server = read('server.js');
    const candidateStart = server.indexOf('async function closeLaunchCandidateWithin');
    const candidateEnd = server.indexOf('function attachBrowserCleanup', candidateStart);
    const candidateSection = server.slice(candidateStart, candidateEnd);
    expect(candidateSection).toContain('snapshotOwnedBrowserProcesses(process.pid)');
    expect(candidateSection).toContain('subtractProcessSnapshots');
    expect(candidateSection).toContain('candidateProcessTerminationProven');
    expect(candidateSection).toContain('_camofoxOwnershipSnapshotCaptured');
    expect(candidateSection).toContain('_camofoxOwnedProcesses');
    expect(candidateSection).toContain('refreshOwnedRegistry(registry)');
    expect(candidateSection).toContain('verifyStableOwnedTermination(registry)');
    expect(candidateSection).toContain('const ownershipMonitor = setInterval');
    expect(candidateSection).not.toContain('owned.length > 0');
    expect(server).toContain('candidateBrowser._camofoxOwnedProcesses.some(isCamoufoxProcess)');
    expect(candidateSection).toContain('survivors: stableProof.survivors');
    expect(candidateSection).not.toContain('_forceKillProcessTree(pid');
    expect(server).not.toContain("process.kill(-pid, 'SIGKILL')");
    expect(server).toContain('closeLaunchCandidateUntilVerified(candidateBrowser');
    expect(server).toContain('browser?._camofoxGeneration === session.browserGeneration');
    expect(server).toContain("'stale_session_context_close_timeout'");
  });

  test('launch publication is generation gated and timeouts invalidate ownership', () => {
    const source = read('server.js');
    expect(source).toContain('assertBrowserLaunchPublishable(launchSlot)');
    expect(source).toContain('invalidateBrowserLaunch(slot, error)');
    expect(source).toContain('candidateBrowser._camofoxGeneration = launchSlot.id');
    expect(source).not.toContain('browserLaunchPromise');
  });

  test('unsettled launch and stale session owners block replacement publication', () => {
    const source = read('server.js');
    const noBrowserStart = source.indexOf('if (!b) {', source.indexOf('async function _closeBrowserFullyImpl'));
    const noBrowserEnd = source.indexOf('\n  clearBrowserIdleTimer();', noBrowserStart);
    const noBrowserSection = source.slice(noBrowserStart, noBrowserEnd);
    expect(noBrowserSection.indexOf('await launchSlot.settlement')).toBeGreaterThan(-1);
    expect(noBrowserSection.indexOf('await launchSlot.settlement')).toBeLessThan(
      noBrowserSection.indexOf('snapshotOwnedBrowserProcesses(process.pid)'),
    );
    expect(noBrowserSection).not.toContain('retireBrowserLaunchSlot(launchSlot)');

    const publishedCloseStart = source.indexOf('clearBrowserIdleTimer();', noBrowserEnd);
    const publishedCloseEnd = source.indexOf('async function _forceKillBrowserProcesses', publishedCloseStart);
    const publishedCloseSection = source.slice(publishedCloseStart, publishedCloseEnd);
    expect(publishedCloseSection).toContain('const ownershipMonitor = setInterval');
    expect(publishedCloseSection).toContain('verifyStableOwnedTermination(registry)');
    expect(publishedCloseSection).toContain('const terminated = ownershipCaptured && !connected && processProof.terminated');
    expect(publishedCloseSection).toContain('unresolvedBrowserOwnership = retainedOwnership');
    expect(source).toContain("closeBrowserFully('unresolved_browser_ownership')");

    const deadStart = source.indexOf("log('warn', 'session context dead, recreating'");
    const deadEnd = source.indexOf('\n    }\n  }', deadStart);
    const deadSection = source.slice(deadStart, deadEnd);
    expect(deadSection).toContain('const terminationProof = await destroySession');
    expect(deadSection).toContain('sessions.get(key) === session');
    expect(deadSection).toContain("code: 'session_reset_incomplete'");

    const publishStart = source.indexOf("await pluginEvents.emitAsync('session:created'");
    const publishEnd = source.indexOf('sessions.set(key, created)', publishStart);
    const prePublishSection = source.slice(publishStart, publishEnd);
    expect(prePublishSection).toContain('const incumbentSession = sessions.get(key)');
    expect(prePublishSection).toContain('incumbentSession !== created');

    const launchAttemptStart = source.indexOf('for (let attempt = 1; attempt <= maxAttempts; attempt++)');
    const launchAttemptEnd = source.indexOf('candidateBrowser = await firefox.launch(options)', launchAttemptStart);
    const launchAttemptSection = source.slice(launchAttemptStart, launchAttemptEnd);
    expect(launchAttemptSection.indexOf('const ownershipBaseline = snapshotOwnedBrowserProcesses(process.pid)')).toBeGreaterThan(-1);
    expect(launchAttemptSection.indexOf('const ownershipBaseline = snapshotOwnedBrowserProcesses(process.pid)')).toBeLessThan(
      launchAttemptSection.indexOf('pluginCtx.createVirtualDisplay()'),
    );
    expect(source).toContain('closeLaunchAttemptWithoutBrowserUntilVerified(\n          ownershipBaseline');
  });
});
