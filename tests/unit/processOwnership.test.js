import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  refreshOwnedProcessSnapshot,
  signalOwnedProcess,
  snapshotOwnedProcessTreesByExecutable,
  snapshotOwnedBrowserProcesses,
  survivingOwnedBrowserProcesses,
  profilePathsFromProcessSnapshot,
  terminateOwnedProcess,
} from '../../lib/process-ownership.js';

function proc(root, pid, ppid, cmdline, startTime = '10', comm = 'test') {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\ttest\nPPid:\t${ppid}\n`);
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime}`);
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
}

test('profile path extraction accepts separate and equals-form profile arguments', () => {
  const profiles = profilePathsFromProcessSnapshot([
    { cmdline: '/cache/camoufox-bin\0-profile\0/tmp/playwright_firefoxdev_profile-live\0-foreground' },
    { cmdline: '/cache/camoufox-bin\0--profile=/tmp/camoufox-live' },
    { cmdline: '/cache/camoufox-bin\0-foreground' },
  ]);

  expect([...profiles]).toEqual([
    path.resolve('/tmp/playwright_firefoxdev_profile-live'),
    path.resolve('/tmp/camoufox-live'),
  ]);
});


test('cleanup snapshot never adopts another scoped server browser', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/usr/bin/Xvfb\0:10');
  proc(root, 102, 100, '/cache/camoufox-bin\0-foreground');
  proc(root, 200, 1, 'node\0server.js');
  proc(root, 201, 200, '/usr/bin/Xvfb\0:20');
  proc(root, 202, 200, '/cache/camoufox-bin\0-foreground');

  expect(snapshotOwnedBrowserProcesses(100, root).map(p => p.pid)).toEqual([101, 102]);
  expect(survivingOwnedBrowserProcesses(snapshotOwnedBrowserProcesses(100, root), root).map(p => p.pid))
    .toEqual([101, 102]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('explicit owned roots capture custom browser and Xvfb executable names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/opt/x11/Xvfb\0:10');
  proc(root, 102, 100, '/opt/custom/browser-enterprise\0--headless');
  proc(root, 103, 102, 'GeckoChildProcess\0-contentproc');
  proc(root, 104, 100, '/usr/bin/yt-dlp\0https://example.test');

  expect(snapshotOwnedBrowserProcesses(100, root, 101).map(p => p.pid)).toEqual([101]);
  expect(snapshotOwnedBrowserProcesses(100, root, 102).map(p => p.pid)).toEqual([102, 103]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch snapshots include only the exact executable tree, not concurrent helpers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/usr/bin/existing-helper');
  proc(root, 102, 100, '/opt/custom/browser-enterprise');
  proc(root, 103, 102, 'GeckoChildProcess\0-contentproc');
  proc(root, 104, 100, '/usr/bin/yt-dlp\0https://example.test');
  const launched = snapshotOwnedProcessTreesByExecutable(
    100,
    '/opt/custom/browser-enterprise',
    root,
  );

  expect(launched.map(p => p.pid)).toEqual([102, 103]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch snapshots exclude new children of a pre-existing matching tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/opt/custom/browser-enterprise', '10');
  const baseline = new Set(['101:10']);
  proc(root, 102, 100, '/opt/custom/browser-enterprise', '20');
  proc(root, 103, 102, 'GeckoChildProcess\0-contentproc', '30');
  proc(root, 104, 101, 'GeckoChildProcess\0-contentproc', '40');

  const launched = snapshotOwnedProcessTreesByExecutable(
    100,
    '/opt/custom/browser-enterprise',
    root,
    baseline,
  );

  expect(launched.map(p => p.pid)).toEqual([102, 103]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch snapshots fail closed for concurrent same-executable roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/opt/custom/browser-enterprise', '10');
  proc(root, 102, 100, '/opt/custom/browser-enterprise', '20');

  expect(snapshotOwnedProcessTreesByExecutable(
    100,
    '/opt/custom/browser-enterprise',
    root,
    new Set(),
  )).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('owned-process termination escalates TERM survivors with generation-safe signaling', () => {
  const identity = { pid: 101, startTime: '10' };
  const signals = [];
  let escalation;
  expect(terminateOwnedProcess(identity, {
    graceMs: 25,
    signalOwned: (processIdentity, signalName) => {
      signals.push([processIdentity, signalName]);
      return true;
    },
    setTimer: (callback, delay) => {
      escalation = callback;
      expect(delay).toBe(25);
      return { unref() {} };
    },
  })).toBe(true);
  expect(signals).toEqual([[identity, 'SIGTERM']]);
  escalation();
  expect(signals).toEqual([[identity, 'SIGTERM'], [identity, 'SIGKILL']]);
});

test('only captured descendants survive reparenting; unrelated PID 1 browsers do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  proc(root, 202, 1, '/cache/camoufox-bin', '20');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);

  fs.writeFileSync(path.join(root, '101', 'status'), 'Name:\ttest\nPPid:\t1\n');
  proc(root, 102, 101, 'GeckoChildProcess\0-contentproc', '30');

  expect(snapshot.map(p => p.pid)).toEqual([101]);
  expect(survivingOwnedBrowserProcesses(snapshot, root).map(p => p.pid)).toEqual([101]);
  expect(refreshOwnedProcessSnapshot(snapshot, root).map(p => p.pid)).toEqual([101, 102]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pid reuse is not mistaken for an owned survivor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  fs.writeFileSync(path.join(root, '101', 'stat'), '101 (test) S 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99');
  expect(survivingOwnedBrowserProcesses(snapshot, root)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('process start time parsing tolerates spaces and parentheses in comm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '42', 'Camoufox Worker (GPU)');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  expect(snapshot.map(p => [p.pid, p.startTime])).toEqual([[101, '42']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('generation-safe signaling refuses a reused numeric PID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/usr/bin/Xvfb\0:10', '10');
  const [identity] = snapshotOwnedBrowserProcesses(100, root);
  const signaled = [];

  expect(signalOwnedProcess(identity, 'SIGTERM', {
    procRoot: root,
    signal: (pid, name) => signaled.push([pid, name]),
  })).toBe(true);
  expect(signaled).toEqual([[101, 'SIGTERM']]);

  fs.writeFileSync(path.join(root, '101', 'stat'), '101 (test) S 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99');
  expect(signalOwnedProcess(identity, 'SIGKILL', {
    procRoot: root,
    signal: (pid, name) => signaled.push([pid, name]),
  })).toBe(false);
  expect(signaled).toEqual([[101, 'SIGTERM']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('server uses generation-safe signaling for browser and virtual-display cleanup', () => {
  const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const displayClass = source.match(/class DefaultVirtualDisplay[\s\S]*?\n}\n\nlet virtualDisplay/)?.[0] ?? '';
  const survivorCleanup = source.match(/async function _forceKillBrowserProcesses[\s\S]*?\n}\n/)?.[0] ?? '';
  const launchFailureCleanup = source.match(/await candidateBrowser\?\.close[\s\S]*?await _forceKillBrowserProcesses\('launch_attempt_failed'/)?.[0] ?? '';
  expect(displayClass).toContain('terminateOwnedProcess(');
  expect(survivorCleanup).toContain('signalOwnedProcess(');
  expect(launchFailureCleanup).not.toContain('snapshotOwnedProcessTreesByExecutable(');
  expect(displayClass).toMatch(/snapshotOwnedBrowserProcesses\(process\.pid, '\/proc', this\.proc\?\.pid\)/);
  expect(source).toMatch(/snapshotOwnedBrowserProcesses\(process\.pid, '\/proc', pid\)/);
  expect(source).toContain('snapshotOwnedProcessTreesByExecutable(');
  expect(source).toContain('VirtualDisplay: DefaultVirtualDisplay');
  expect(source).toMatch(/candidateBrowser\.close = async[\s\S]*?finally/);
  expect(source).toMatch(/tabAdmission\.shutdown\(\);[\s\S]*server\.close/);
  expect(source).toMatch(/if \(tabAdmission\.closed \|\| launchGeneration !== browserLaunchGeneration\)[\s\S]*?virtualDisplay = localVirtualDisplay/);
  expect(source).toMatch(/const tracked = launch\.finally[\s\S]*?browserLaunchPromise = tracked/);
  expect(source).toMatch(/return Promise\.race\(\[\s*browserLaunchPromise,[\s\S]*?Browser launch timeout/);
  expect(source).toMatch(/app\.post\('\/stop'[\s\S]*?const invalidatedLaunch = invalidateBrowserLaunch\(\)[\s\S]*?await invalidatedLaunch\?\.catch[\s\S]*?closeBrowserFully\('admin_stop'\)/);
  expect(source).toMatch(/tabAdmission\.shutdown\(\);[\s\S]*?const invalidatedLaunch = invalidateBrowserLaunch\(\)[\s\S]*?Promise\.all\(\[[\s\S]*?invalidatedLaunch\?\.catch/);
});
