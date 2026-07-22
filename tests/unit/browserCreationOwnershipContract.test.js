const { readFileSync } = process.getBuiltinModule('fs');
const { join } = process.getBuiltinModule('path');

const read = path => readFileSync(join(process.cwd(), path), 'utf8');

describe('browser creation ownership source contract', () => {
  test('server and plugins do not call raw Playwright context/page factories', () => {
    const guarded = [
      'server.js',
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
    expect(server).toContain("cleanup: page => closeOwnedPage(page, 'tab_creation_abort', effectiveSession)");
    expect(server).toContain("await closeOwnedPage(found.tabState.page, 'tab_delete', session)");
    expect(server).toContain("await closeOwnedPage(tabState.page, 'tab_group_delete', session)");
    expect(server).toContain("void closeOwnedPage(tabState.page, 'tab_inactivity_reaper', session)");
    expect(server).toContain("cleanupLatePage: page => closeOwnedPage(page, 'late_page_recovery')");
    expect(server).toContain('return Boolean(cleaned || orphanPageCleanup.owns(page))');
    expect(server).toContain('const ownerEpoch = session?.browserGeneration ?? null');
    expect(server).not.toContain('ownerEpoch: browserGeneration');
  });

  test('launch publication is generation gated and timeouts invalidate ownership', () => {
    const source = read('server.js');
    expect(source).toContain('assertBrowserLaunchPublishable(launchSlot)');
    expect(source).toContain('invalidateBrowserLaunch(slot, error)');
    expect(source).toContain('candidateBrowser._camofoxGeneration = launchSlot.id');
    expect(source).not.toContain('browserLaunchPromise');
  });
});
