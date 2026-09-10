import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const BROWSER_PROCESS_RE = /camoufox-bin|\/usr\/bin\/Xvfb\b/;

function readProcess(procRoot, pid) {
  const status = fs.readFileSync(`${procRoot}/${pid}/status`, 'utf8');
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
  // The comm field is parenthesized and may itself contain spaces or `)`, so
  // fields cannot be found with a plain whitespace split. starttime is field
  // 22 overall, or index 19 in the suffix beginning with field 3 (state).
  const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) throw new Error(`invalid proc stat for ${pid}`);
  const startTime = stat.slice(commEnd + 2).trim().split(/\s+/)[19];
  if (startTime === undefined) throw new Error(`missing starttime for ${pid}`);
  const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
  return { pid: Number(pid), ppid, startTime, cmdline };
}

/** Snapshot browser/Xvfb descendants owned by one server process. */
export function snapshotOwnedBrowserProcesses(rootPid, procRoot = '/proc', ownedRootPid = null) {
  if (process.platform !== 'linux' && procRoot === '/proc') return [];
  const processes = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try { processes.push(readProcess(procRoot, entry)); } catch { /* process vanished */ }
  }

  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!descendants.has(proc.pid) && descendants.has(proc.ppid)) {
        descendants.add(proc.pid);
        changed = true;
      }
    }
  }
  if (ownedRootPid !== null && ownedRootPid !== undefined) {
    const ownedRoot = Number(ownedRootPid);
    if (ownedRoot === Number(rootPid) || !descendants.has(ownedRoot)) return [];
    const owned = new Set([ownedRoot]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const proc of processes) {
        if (!owned.has(proc.pid) && owned.has(proc.ppid)) {
          owned.add(proc.pid);
          grew = true;
        }
      }
    }
    return processes.filter(proc => owned.has(proc.pid));
  }
  return processes.filter(proc => descendants.has(proc.pid) && BROWSER_PROCESS_RE.test(proc.cmdline));
}

export function profilePathsFromProcessSnapshot(snapshot) {
  const profiles = new Set();
  for (const { cmdline = '' } of snapshot) {
    const args = cmdline.split('\0');
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      let profile;
      if (arg === '-profile' || arg === '--profile') profile = args[index + 1];
      else if (arg.startsWith('-profile=') || arg.startsWith('--profile=')) profile = arg.slice(arg.indexOf('=') + 1);
      if (profile) profiles.add(path.resolve(profile));
    }
  }
  return profiles;
}

/** Return only snapshot members that are still the same OS processes. */
export function survivingOwnedBrowserProcesses(snapshot, procRoot = '/proc') {
  return snapshot.filter(proc => {
    try { return readProcess(procRoot, proc.pid).startTime === proc.startTime; } catch { return false; }
  });
}

const PIDFD_SIGNAL_SCRIPT = String.raw`
import os, signal as sig, sys
pid = int(sys.argv[1])
expected = sys.argv[2]
signum = getattr(sig, sys.argv[3])
fd = os.pidfd_open(pid)
with open(f'/proc/{pid}/stat', 'r', encoding='utf-8') as handle:
    suffix = handle.read().rsplit(') ', 1)[1].split()
if suffix[19] != expected:
    raise SystemExit(3)
sig.pidfd_send_signal(fd, signum)
`;

/** Signal only the exact captured process generation. */
export function signalOwnedProcess(identity, signalName = 'SIGKILL', {
  procRoot = '/proc',
  signal,
} = {}) {
  let current;
  try { current = readProcess(procRoot, identity.pid); } catch { return false; }
  if (current.startTime !== identity.startTime) return false;

  if (signal) {
    signal(identity.pid, signalName);
    return true;
  }

  if (process.platform === 'linux' && procRoot === '/proc') {
    const result = spawnSync('python3', [
      '-c', PIDFD_SIGNAL_SCRIPT, String(identity.pid), identity.startTime, signalName,
    ], { stdio: 'ignore' });
    return result.status === 0;
  }

  process.kill(identity.pid, signalName);
  return true;
}
