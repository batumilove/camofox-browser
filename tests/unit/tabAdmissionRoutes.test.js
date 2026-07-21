import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

let serverUrl;
let testSiteUrl;
const users = new Set();

async function postJson(path, body) {
  if (body.userId) users.add(body.userId);
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.json(),
  };
}

async function createTab(userId, url, sessionKey = 'default') {
  return postJson('/tabs', { userId, sessionKey, url });
}

async function openLegacyTab(userId, url, listItemId = 'default') {
  return postJson('/tabs/open', { userId, listItemId, url });
}

beforeAll(async () => {
  await startTestSite();
  testSiteUrl = getTestSiteUrl();
  await startServer(0, {
    MAX_TABS_PER_SESSION: '2',
    MAX_TABS_GLOBAL: '2',
    TAB_ADMISSION_MAX_ACTIVE: '2',
    TAB_ADMISSION_MAX_ACTIVE_PER_USER: '2',
    TAB_ADMISSION_QUEUE_LIMIT: '1',
    HANDLER_TIMEOUT_MS: '10000',
  });
  serverUrl = getServerUrl();
}, 60000);

afterEach(async () => {
  for (const userId of users) {
    await fetch(`${serverUrl}/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => {});
  }
  users.clear();
});

afterAll(async () => {
  await stopServer();
  await stopTestSite();
}, 30000);

describe('tab admission route integration', () => {
  test('global saturation without a recyclable tab returns coded 429 and Retry-After', async () => {
    expect((await createTab('owner', `${testSiteUrl}/pageA`, 'one')).status).toBe(200);
    expect((await createTab('owner', `${testSiteUrl}/pageB`, 'two')).status).toBe(200);

    const rejected = await createTab('new-user', `${testSiteUrl}/pageA`);
    expect(rejected).toMatchObject({
      status: 429,
      retryAfter: '2',
      body: {
        code: 'tab_admission_global_limit',
        retryAfter: 2,
      },
    });
  }, 60000);

  test('two concurrent creates at N-1 atomically reserve one growth and one recycle slot', async () => {
    const seed = await createTab('concurrent', `${testSiteUrl}/pageA`, 'seed');
    expect(seed.status).toBe(200);

    const results = await Promise.all([
      createTab('concurrent', `${testSiteUrl}/slow?ms=500`, 'next-1'),
      createTab('concurrent', `${testSiteUrl}/slow?ms=500`, 'next-2'),
    ]);

    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.every(result => result.body.tabId)).toBe(true);
    const list = await fetch(`${serverUrl}/tabs?userId=concurrent`).then(response => response.json());
    expect(list.tabs).toHaveLength(2);
    expect(list.tabs.map(tab => tab.tabId).sort()).toEqual(results.map(result => result.body.tabId).sort());
    const recycledSnapshot = await fetch(`${serverUrl}/tabs/${seed.body.tabId}/snapshot?userId=concurrent`);
    expect(recycledSnapshot.status).toBe(410);
    for (const result of results) {
      const snapshot = await fetch(`${serverUrl}/tabs/${result.body.tabId}/snapshot?userId=concurrent`);
      expect(snapshot.status).toBe(200);
    }
  }, 60000);

  test('legacy tab-open route shares the bounded queue and machine-readable overflow contract', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      openLegacyTab('legacy-burst', `${testSiteUrl}/slow?ms=500`, `legacy-${index}`)));

    const successes = results.filter(result => result.status === 200);
    const rejected = results.filter(result => result.status === 429);
    expect(successes).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.retryAfter).toBe('2');
      expect(result.body).toMatchObject({
        code: 'tab_admission_queue_full',
        retryAfter: 2,
      });
    }
  }, 60000);
});
