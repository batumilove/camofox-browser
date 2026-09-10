import fs from 'fs';

const CAMOUFOX_PROCESS_RE = /camoufox-bin/;
const BROWSER_PROCESS_RE = /camoufox-bin|\/usr\/bin\/Xvfb\b/;

export function isCamoufoxProcess(processInfo) {
  return Boolean(processInfo && CAMOUFOX_PROCESS_RE.test(processInfo.cmdline || ''));
}

function parseStat(stat, pid) {
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) throw new Error(`invalid proc stat for ${pid}`);
  const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp) || startTime === undefined) {
    throw new Error(`missing process identity fields for ${pid}`);
  }
  return { pid: Number(pid), ppid, pgrp, startTime };
}

function readProcess(procRoot, pid) {
  const statPath = `${procRoot}/${pid}/stat`;
  const first = parseStat(fs.readFileSync(statPath, 'utf8'), pid);
  const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
  const second = parseStat(fs.readFileSync(statPath, 'utf8'), pid);
  if (first.startTime !== second.startTime || first.ppid !== second.ppid || first.pgrp !== second.pgrp) {
    throw Object.assign(new Error(`process identity changed while reading ${pid}`), {
      code: 'PROCESS_IDENTITY_CHANGED',
    });
  }
  return { ...second, cmdline };
}

function processVanished(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH';
}

/** Capture one process identity; null means the PID is absent, not unreadable. */
export function readProcessIdentity(pid, procRoot = '/proc') {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  try {
    return readProcess(procRoot, Number(pid));
  } catch (error) {
    if (processVanished(error)) return null;
    throw error;
  }
}

/** True only while the captured PID still has the exact original start time. */
export function sameProcessIdentity(identity, procRoot = '/proc') {
  if (!identity?.pid || identity.startTime === undefined) return false;
  const current = readProcessIdentity(identity.pid, procRoot);
  return Boolean(current && current.startTime === identity.startTime);
}

/** Return only process identities that were not present in the baseline snapshot. */
export function subtractProcessSnapshots(current, baseline = []) {
  const previous = new Set(baseline.map(proc => `${proc.pid}:${proc.startTime}`));
  return current.filter(proc => !previous.has(`${proc.pid}:${proc.startTime}`));
}

/** Union exact process identities without replacing an older PID generation. */
export function mergeProcessSnapshots(...snapshots) {
  const merged = new Map();
  for (const snapshot of snapshots) {
    for (const proc of snapshot || []) merged.set(`${proc.pid}:${proc.startTime}`, proc);
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

/** Exact proof that a captured candidate owner is gone and transport is closed. */
export function candidateProcessTerminationProven({
  ownershipCaptured,
  connected,
  survivors = [],
}) {
  return Boolean(ownershipCaptured && !connected && survivors.length === 0);
}

function listProcesses(procRoot) {
  const processes = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      processes.push(readProcess(procRoot, entry));
    } catch (error) {
      if (processVanished(error)) continue;
      // Permission, I/O, malformed, or inconsistent identity means the scan is
      // incomplete. Never convert that into a successful termination proof.
      throw error;
    }
  }
  return processes;
}

/** Snapshot browser/Xvfb descendants owned by one server process. */
export function snapshotOwnedBrowserProcesses(rootPid, procRoot = '/proc') {
  if (process.platform !== 'linux' && procRoot === '/proc') return [];
  const processes = listProcesses(procRoot);
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
  return processes.filter(proc => descendants.has(proc.pid) && BROWSER_PROCESS_RE.test(proc.cmdline));
}

/**
 * Refresh an exact candidate registry without adopting a reused PID or pgrp.
 * A group remains admissible only while its captured leader generation is
 * current, or an already-captured exact member proves that the leaderless
 * original group still exists.
 */
export function refreshOwnedProcessSnapshot(registry, procRoot = '/proc') {
  if (process.platform !== 'linux' && procRoot === '/proc') return registry;
  const processes = listProcesses(procRoot);
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const selected = new Map();

  for (const captured of registry) {
    const current = byPid.get(captured.pid);
    if (current?.startTime === captured.startTime) selected.set(current.pid, current);
  }

  const groups = new Map();
  for (const captured of registry.filter(isCamoufoxProcess)) {
    if (!Number.isInteger(captured.pgrp) || captured.pgrp <= 1) continue;
    const state = groups.get(captured.pgrp) || { leader: null, exactMemberAlive: false };
    if (captured.pid === captured.pgrp) state.leader = captured;
    if (selected.has(captured.pid)) state.exactMemberAlive = true;
    groups.set(captured.pgrp, state);
  }

  for (const [pgrp, state] of groups) {
    const currentLeader = byPid.get(pgrp);
    const leaderMatches = Boolean(
      state.leader && currentLeader && currentLeader.startTime === state.leader.startTime,
    );
    const leaderReused = Boolean(
      state.leader && currentLeader && currentLeader.startTime !== state.leader.startTime,
    );
    if (leaderReused || (!leaderMatches && !state.exactMemberAlive)) continue;
    for (const proc of processes) {
      if (isCamoufoxProcess(proc) && proc.pgrp === pgrp) selected.set(proc.pid, proc);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!selected.has(proc.pid) && selected.has(proc.ppid) && BROWSER_PROCESS_RE.test(proc.cmdline)) {
        selected.set(proc.pid, proc);
        changed = true;
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

/** Return only snapshot members that are still the same OS processes. */
export function survivingOwnedBrowserProcesses(snapshot, procRoot = '/proc') {
  return snapshot.filter(proc => {
    const current = readProcessIdentity(proc.pid, procRoot);
    return Boolean(current && current.startTime === proc.startTime);
  });
}
