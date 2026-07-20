import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

describe('Tab capacity admission', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { MAX_TABS_PER_SESSION: '5', MAX_TABS_GLOBAL: '50' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('POST /tabs rejects at the per-session limit without recycling an existing tab', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      // Fill up to the limit (5)
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      await expect(client.createTab(`${testSiteUrl}/pageB`)).rejects.toMatchObject({
        status: 429,
        data: { code: 'tab_admission_user_limit', retryAfter: 2 },
      });

      const snap = await client.getSnapshot(tabs[0]);
      expect(snap.url).toContain('/pageA');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('repeated overflow requests remain bounded and do not evict admitted tabs', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      for (let i = 0; i < 7; i++) {
        await expect(client.createTab(`${testSiteUrl}/pageB`)).rejects.toMatchObject({ status: 429 });
      }
      const snap = await client.getSnapshot(tabs[0]);
      expect(snap.url).toContain('/pageA');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('overflow does not recycle even the least-used tab', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      // Interact with tabs[1] through tabs[4] to increase their toolCalls
      for (let i = 1; i < 5; i++) {
        await client.getSnapshot(tabs[i]);
      }

      await expect(client.createTab(`${testSiteUrl}/pageB`)).rejects.toMatchObject({ status: 429 });

      await expect(client.getSnapshot(tabs[0])).resolves.toBeDefined();
      await expect(client.getSnapshot(tabs[1])).resolves.toBeDefined();
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('navigate returns 404 for unknown tab (no auto-create)', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      // Navigate with a non-existent tabId -- should return stale-tab error
      const fakeTabId = 'nonexistent-tab-id';
      try {
        await client.navigate(fakeTabId, `${testSiteUrl}/pageC`);
        fail('Should have thrown 404');
      } catch (err) {
        expect(err.status).toBe(404);
      }
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('different users can each use their full per-session limit', async () => {
    const client1 = createClient(serverUrl);
    const client2 = createClient(serverUrl);
    try {
      // User 1 fills their session
      for (let i = 0; i < 5; i++) {
        const result = await client1.createTab(`${testSiteUrl}/pageA`);
        expect(result.tabId).toBeDefined();
      }

      // User 2 should also be able to create tabs (global limit is 50)
      for (let i = 0; i < 5; i++) {
        const result = await client2.createTab(`${testSiteUrl}/pageB`);
        expect(result.tabId).toBeDefined();
      }
    } finally {
      await client1.cleanup();
      await client2.cleanup();
    }
  }, 120000);
});
