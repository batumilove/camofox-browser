import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  candidateProcessTerminationProven,
  isCamoufoxProcess,
  mergeProcessSnapshots,
  readProcessIdentity,
  refreshOwnedProcessSnapshot,
  sameProcessIdentity,
  snapshotOwnedBrowserProcesses,
  subtractProcessSnapshots,
  survivingOwnedBrowserProcesses,
} from '../../lib/process-ownership.js';

function statLine(pid, ppid, startTime, comm = 'test', pgrp = pid) {
  const fields = ['S', String(ppid), String(pgrp), ...Array(16).fill('0'), String(startTime)];
  return `${pid} (${comm}) ${fields.join(' ')}`;
}

function proc(root, pid, ppid, cmdline, startTime = '10', comm = 'test', pgrp = pid) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\ttest\nPPid:\t${ppid}\n`);
  fs.writeFileSync(path.join(dir, 'stat'), statLine(pid, ppid, startTime, comm, pgrp));
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
}

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

test('refresh captures later and reparented members of the exact browser process group', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/usr/bin/Xvfb\0:10');
  proc(root, 102, 100, '/cache/camoufox-bin\0-foreground', '20', 'camoufox', 102);
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  expect(snapshot.some(isCamoufoxProcess)).toBe(true);
  expect(isCamoufoxProcess(snapshot.find(item => item.pid === 101))).toBe(false);

  proc(root, 103, 1, '/cache/camoufox-bin\0-content', '30', 'camoufox-content', 102);
  proc(root, 202, 1, '/cache/camoufox-bin\0-unrelated', '40', 'camoufox', 202);
  const refreshed = refreshOwnedProcessSnapshot(snapshot, root);
  expect(refreshed.map(item => item.pid)).toEqual([101, 102, 103]);
  expect(mergeProcessSnapshots(snapshot, refreshed).map(item => `${item.pid}:${item.startTime}`))
    .toEqual(['101:10', '102:20', '103:30']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refresh rejects a reused process-group leader generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 102, 100, '/cache/camoufox-bin\0-foreground', '20', 'camoufox', 102);
  const registry = snapshotOwnedBrowserProcesses(100, root);

  fs.rmSync(path.join(root, '102'), { recursive: true, force: true });
  proc(root, 102, 1, '/cache/camoufox-bin\0-unrelated-leader', '99', 'camoufox', 102);
  proc(root, 103, 102, '/cache/camoufox-bin\0-unrelated-child', '100', 'camoufox', 102);
  expect(refreshOwnedProcessSnapshot(registry, root)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('incomplete proc scans throw instead of proving an empty owner set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  const broken = path.join(root, '101');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'stat'), 'malformed');
  fs.writeFileSync(path.join(broken, 'cmdline'), '/cache/camoufox-bin');
  expect(() => snapshotOwnedBrowserProcesses(100, root)).toThrow('invalid proc stat');
  fs.rmSync(root, { recursive: true, force: true });
});

test('only captured descendants survive reparenting; unrelated PID 1 browsers do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  proc(root, 202, 1, '/cache/camoufox-bin', '20');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);

  fs.writeFileSync(path.join(root, '101', 'status'), 'Name:\ttest\nPPid:\t1\n');

  expect(snapshot.map(p => p.pid)).toEqual([101]);
  expect(survivingOwnedBrowserProcesses(snapshot, root).map(p => p.pid)).toEqual([101]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pid reuse is not mistaken for an owned survivor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  fs.writeFileSync(path.join(root, '101', 'stat'), statLine(101, 100, '99'));
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

test('captured root identity proves an absent original process without adopting PID reuse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 101, 1, '/cache/camoufox-bin', '42');
  const captured = readProcessIdentity(101, root);
  expect(sameProcessIdentity(captured, root)).toBe(true);
  expect(candidateProcessTerminationProven({
    ownershipCaptured: true,
    identity: captured,
    connected: false,
    survivors: [captured],
  }, root)).toBe(false);

  fs.rmSync(path.join(root, '101'), { recursive: true, force: true });
  expect(sameProcessIdentity(captured, root)).toBe(false);
  expect(candidateProcessTerminationProven({
    ownershipCaptured: true,
    identity: captured,
    connected: false,
    survivors: [],
  }, root)).toBe(true);

  proc(root, 101, 1, '/unrelated/process', '99');
  expect(sameProcessIdentity(captured, root)).toBe(false);
  expect(candidateProcessTerminationProven({
    ownershipCaptured: true,
    identity: captured,
    connected: false,
    survivors: [],
  }, root)).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot subtraction keeps only exact new PID/start-time identities', () => {
  const baseline = [
    { pid: 10, startTime: '1' },
    { pid: 20, startTime: '2' },
  ];
  const current = [
    { pid: 10, startTime: '1' },
    { pid: 20, startTime: '9' },
    { pid: 30, startTime: '3' },
  ];
  expect(subtractProcessSnapshots(current, baseline)).toEqual([current[1], current[2]]);
});

test('missing process identity is reported as null and proves only a captured absence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  expect(readProcessIdentity(999, root)).toBeNull();
  expect(candidateProcessTerminationProven({
    ownershipCaptured: true,
    identity: null,
    connected: false,
    survivors: [],
  }, root)).toBe(true);
  expect(candidateProcessTerminationProven({
    ownershipCaptured: false,
    identity: null,
    connected: false,
    survivors: [],
  }, root)).toBe(false);
  expect(candidateProcessTerminationProven({
    ownershipCaptured: true,
    identity: null,
    connected: true,
    survivors: [],
  }, root)).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});
