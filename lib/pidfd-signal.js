import { spawnSync } from 'child_process';

// Open pidfd first, then verify the generation through /proc before signaling.
// If the numeric PID was reused before pidfd_open, startTime mismatches and the
// stable descriptor is never signaled. If it exits afterward, pidfd remains
// bound to the original process generation.
const PIDFD_SIGNAL_SCRIPT = String.raw`
import os, signal, sys
pid = int(sys.argv[1])
expected = sys.argv[2]
sig = int(sys.argv[3])
try:
    fd = os.pidfd_open(pid, 0)
except ProcessLookupError:
    raise SystemExit(3)
except (AttributeError, PermissionError, OSError):
    raise SystemExit(5)
try:
    try:
        stat = open('/proc/%d/stat' % pid, 'r', encoding='utf-8').read()
    except FileNotFoundError:
        raise SystemExit(3)
    end = stat.rfind(')')
    if end < 0:
        raise SystemExit(5)
    fields = stat[end + 2:].split()
    if len(fields) <= 19:
        raise SystemExit(5)
    if fields[19] != expected:
        raise SystemExit(4)
    try:
        signal.pidfd_send_signal(fd, sig, None, 0)
    except ProcessLookupError:
        raise SystemExit(3)
    except (AttributeError, PermissionError, OSError):
        raise SystemExit(5)
finally:
    os.close(fd)
`;

const SIGNAL_NUMBERS = {
  SIGKILL: 9,
  SIGTERM: 15,
};

/** Signal only the exact captured Linux process generation via pidfd. */
export function signalCapturedProcess(identity, signalName = 'SIGKILL') {
  if (process.platform !== 'linux') {
    throw new Error('generation-bound process signaling requires Linux pidfd');
  }
  if (!identity?.pid || identity.startTime === undefined) return false;
  const signalNumber = SIGNAL_NUMBERS[signalName];
  if (!signalNumber) throw new Error(`unsupported pidfd signal: ${signalName}`);

  const result = spawnSync('python3', [
    '-c',
    PIDFD_SIGNAL_SCRIPT,
    String(identity.pid),
    String(identity.startTime),
    String(signalNumber),
  ], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 3 || result.status === 4) return false;
  throw new Error(`pidfd signaling failed (status ${result.status}): ${(result.stderr || '').trim()}`);
}
