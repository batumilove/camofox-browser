import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '..', '..', 'server.js'), 'utf8');

test('POST /tabs JSDoc advertises both admission timeout codes and Retry-After', () => {
  const routeDoc = serverSrc.match(/\/\*\*[\s\S]*?@openapi[\s\S]*?\/tabs:[\s\S]*?\*\/\s*app\.post\('\/tabs'/)?.[0] ?? '';
  expect(routeDoc).toContain('tab_admission_wait_timeout');
  expect(routeDoc).toContain('tab_admission_operation_timeout');
  expect(routeDoc).toContain('tab_admission_wait_saturated');
  expect(routeDoc).toContain('tab_capacity_reached');
  expect(routeDoc).toContain('tab_admission_shutting_down');
  expect(routeDoc).toContain('browser_stopping');
  expect(routeDoc).toContain('session_closing');
  expect(routeDoc).toContain('admission_rejected');
  expect(routeDoc).toContain('browser_launch_timeout');
  expect(routeDoc).toContain('session_expired');
  expect(routeDoc).toMatch(/503:/);
  expect(routeDoc).toContain('Retry-After');
});
