import { spawn } from 'child_process';
import { once } from 'events';
import { readProcessIdentity } from '../../lib/process-ownership.js';
import { signalCapturedProcess } from '../../lib/pidfd-signal.js';

const linuxTest = process.platform === 'linux' ? test : test.skip;

linuxTest('pidfd signal kills only the captured process generation', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const identity = readProcessIdentity(child.pid);
  expect(identity).not.toBeNull();
  expect(signalCapturedProcess(identity, 'SIGKILL')).toBe(true);
  const [code, signal] = await once(child, 'exit');
  expect(code).toBeNull();
  expect(signal).toBe('SIGKILL');
});

linuxTest('pidfd signal rejects a mismatched captured generation', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const identity = readProcessIdentity(child.pid);
    expect(signalCapturedProcess({ ...identity, startTime: `${identity.startTime}9` })).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});
