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

  test('launch publication is generation gated and timeouts invalidate ownership', () => {
    const source = read('server.js');
    expect(source).toContain('assertBrowserLaunchPublishable(launchSlot)');
    expect(source).toContain('invalidateBrowserLaunch(slot, error)');
    expect(source).toContain('candidateBrowser._camofoxGeneration = launchSlot.id');
    expect(source).not.toContain('browserLaunchPromise');
  });
});
