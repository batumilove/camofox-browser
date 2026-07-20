import { describe, expect, test, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig', () => {
  test('prefers CAMOUFOX_EXECUTABLE for external Camoufox executable', () => {
    process.env.CAMOUFOX_EXECUTABLE = '/nix/store/camoufox/bin/camoufox';
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/ignored/camoufox';
    process.env.CAMOFOX_EXECUTABLE_PATH = '/also-ignored/camoufox';

    const config = loadConfig();

    expect(config.camoufoxExecutablePath).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE_PATH).toBe('/ignored/camoufox');
    expect(config.serverEnv.CAMOFOX_EXECUTABLE_PATH).toBe('/also-ignored/camoufox');
  });

  test('accepts compatibility executable env vars', () => {
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/compat/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/compat/camoufox');

    delete process.env.CAMOUFOX_EXECUTABLE_PATH;
    process.env.CAMOFOX_EXECUTABLE_PATH = '/legacy/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/legacy/camoufox');
  });

  test('configures browser RSS restart threshold', () => {
    delete process.env.BROWSER_RSS_RESTART_THRESHOLD_MB;
    expect(loadConfig().browserRssRestartThresholdMb).toBe(1500);

    process.env.BROWSER_RSS_RESTART_THRESHOLD_MB = '2048';
    expect(loadConfig().browserRssRestartThresholdMb).toBe(2048);
  });

  test('preserves zero browser idle timeout and falls back for invalid values', () => {
    delete process.env.BROWSER_IDLE_TIMEOUT_MS;
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = '0';
    expect(loadConfig().browserIdleTimeoutMs).toBe(0);
  });

  test('rejects zero, negative, and malformed admission limits safely', () => {
    process.env.HANDLER_TIMEOUT_MS = '0';
    process.env.MAX_CONCURRENT_PER_USER = '3oops';
    process.env.MAX_TABS_GLOBAL = '0';
    process.env.MAX_TABS_PER_SESSION = '-5';
    process.env.TAB_ADMISSION_MAX_ACTIVE = '0';
    process.env.TAB_ADMISSION_MAX_ACTIVE_PER_USER = '-2';
    process.env.TAB_ADMISSION_QUEUE_LIMIT = 'NaN';

    const config = loadConfig();

    expect(config.handlerTimeoutMs).toBe(30000);
    expect(config.maxConcurrentPerUser).toBe(3);
    expect(config.maxTabsGlobal).toBe(50);
    expect(config.maxTabsPerSession).toBe(10);
    expect(config.tabAdmissionMaxActive).toBe(4);
    expect(config.tabAdmissionMaxActivePerUser).toBe(2);
    expect(config.tabAdmissionQueueLimit).toBe(8);
  });

  test('accepts positive admission-control values', () => {
    process.env.HANDLER_TIMEOUT_MS = '1500';
    process.env.MAX_CONCURRENT_PER_USER = '4';
    process.env.MAX_TABS_GLOBAL = '12';
    process.env.MAX_TABS_PER_SESSION = '8';
    process.env.TAB_ADMISSION_MAX_ACTIVE = '6';
    process.env.TAB_ADMISSION_MAX_ACTIVE_PER_USER = '3';
    process.env.TAB_ADMISSION_QUEUE_LIMIT = '5';

    const config = loadConfig();

    expect(config.handlerTimeoutMs).toBe(1500);
    expect(config.maxConcurrentPerUser).toBe(4);
    expect(config.maxTabsGlobal).toBe(12);
    expect(config.maxTabsPerSession).toBe(8);
    expect(config.tabAdmissionMaxActive).toBe(6);
    expect(config.tabAdmissionMaxActivePerUser).toBe(3);
    expect(config.tabAdmissionQueueLimit).toBe(5);
    expect(config.serverEnv).toMatchObject({
      HANDLER_TIMEOUT_MS: '1500',
      MAX_CONCURRENT_PER_USER: '4',
      MAX_TABS_GLOBAL: '12',
      MAX_TABS_PER_SESSION: '8',
      TAB_ADMISSION_MAX_ACTIVE: '6',
      TAB_ADMISSION_MAX_ACTIVE_PER_USER: '3',
      TAB_ADMISSION_QUEUE_LIMIT: '5',
    });
  });

  test('forwards VNC env vars to server subprocess whitelist', () => {
    process.env.ENABLE_VNC = '1';
    process.env.VNC_RESOLUTION = '1280x720';
    process.env.VNC_PASSWORD = 'secret';
    process.env.VIEW_ONLY = '1';
    process.env.VNC_PORT = '5901';
    process.env.NOVNC_PORT = '6081';
    process.env.VNC_BIND = '0.0.0.0';

    const config = loadConfig();

    expect(config.pluginEnv).toEqual({ ENABLE_VNC: '1' });
    expect(config.serverEnv).toMatchObject({
      ENABLE_VNC: '1',
      VNC_RESOLUTION: '1280x720',
      VNC_PASSWORD: 'secret',
      VIEW_ONLY: '1',
      VNC_PORT: '5901',
      NOVNC_PORT: '6081',
      VNC_BIND: '0.0.0.0',
    });
  });
});
