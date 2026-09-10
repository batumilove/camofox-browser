/**
 * Tests for auto-generated OpenAPI spec.
 *
 * Verifies:
 *  1. Every server.js route appears in the spec (no drift)
 *  2. No stale routes in the spec that aren't in server.js
 *  3. Spec structure is valid OpenAPI 3.0.x
 *  4. info.version matches package.json
 *  5. Every operation has responses and tags
 *  6. Enriched routes have proper metadata
 */

import { jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import swaggerJsdoc from 'swagger-jsdoc';
import { mountDocs, swaggerDefinition } from '../../lib/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', '..', 'server.js');
const persistencePluginPath = join(__dirname, '..', '..', 'plugins', 'persistence', 'index.js');
const serverSrc = readFileSync(serverPath, 'utf8');
const persistencePluginSrc = readFileSync(persistencePluginPath, 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

// Build spec from core and lifecycle-sensitive plugin routes
const spec = swaggerJsdoc({
  definition: swaggerDefinition,
  apis: [serverPath, persistencePluginPath],
});

/**
 * Extract all app.get/post/delete routes from server.js source.
 * Returns Set of "METHOD /path" strings (Express format with :params).
 */
function parseServerRoutes(source) {
  const routes = new Set();
  const re = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return routes;
}

const serverRoutes = new Set([
  ...parseServerRoutes(serverSrc),
  ...parseServerRoutes(persistencePluginSrc),
]);

describe('OpenAPI spec', () => {
  test('is valid OpenAPI 3.0.x shape', () => {
    expect(spec.openapi).toMatch(/^3\.0\.\d+$/);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('camofox-browser');
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
    expect(spec.components).toBeDefined();
  });

  test('info.version matches package.json', () => {
    expect(spec.info.version).toBe(pkg.version);
  });

  test('every server.js route appears in the spec', () => {
    const missing = [];
    for (const route of serverRoutes) {
      const [method, expressPath] = route.split(' ');
      const oaPath = expressPath.replace(/:(\w+)/g, '{$1}');
      const pathObj = spec.paths[oaPath];
      if (!pathObj || !pathObj[method.toLowerCase()]) {
        missing.push(route);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no stale routes in spec that are not in server.js', () => {
    const stale = [];
    for (const [oaPath, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (method.startsWith('x-')) continue; // skip extensions
        const expressPath = oaPath.replace(/\{(\w+)\}/g, ':$1');
        const key = `${method.toUpperCase()} ${expressPath}`;
        if (!serverRoutes.has(key)) {
          stale.push(key);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  test('spec covers at least 30 routes from server.js', () => {
    expect(serverRoutes.size).toBeGreaterThanOrEqual(30);

    let covered = 0;
    for (const route of serverRoutes) {
      const [method, expressPath] = route.split(' ');
      const oaPath = expressPath.replace(/:(\w+)/g, '{$1}');
      if (spec.paths[oaPath]?.[method.toLowerCase()]) covered++;
    }
    expect(covered).toBe(serverRoutes.size);
  });

  test('every operation has at least one response', () => {
    const noResponses = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method.startsWith('x-')) continue;
        if (!op.responses || Object.keys(op.responses).length === 0) {
          noResponses.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(noResponses).toEqual([]);
  });

  test('every operation has at least one tag', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method.startsWith('x-')) continue;
        expect(op.tags?.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('parameterized routes have path parameters', () => {
    const navOp = spec.paths['/tabs/{tabId}/navigate']?.post;
    expect(navOp).toBeDefined();
    const tabIdParam = navOp.parameters?.find(p => p.name === 'tabId' && p.in === 'path');
    expect(tabIdParam).toBeDefined();
    expect(tabIdParam.required).toBe(true);
    expect(tabIdParam.schema.type).toBe('string');
  });

  test('POST /tabs has request body and proper tag', () => {
    const createTab = spec.paths['/tabs']?.post;
    expect(createTab).toBeDefined();
    expect(createTab.summary).toBe('Create a new tab');
    expect(createTab.tags).toContain('Tabs');
    expect(createTab.requestBody).toBeDefined();
    expect(createTab.requestBody.content['application/json']).toBeDefined();
  });

  test('tab creation routes document machine-readable 429 and Retry-After', () => {
    for (const path of ['/tabs', '/tabs/open']) {
      const response = spec.paths[path]?.post?.responses?.['429'];
      expect(response).toBeDefined();
      expect(response.headers?.['Retry-After']).toBeDefined();
      expect(response.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/TabAdmissionError');
    }
  });

  test('lifecycle-sensitive create and reset routes document 409 and 503', () => {
    const operations = [
      spec.paths['/tabs']?.post,
      spec.paths['/tabs/open']?.post,
      spec.paths['/sessions/{userId}']?.delete,
      spec.paths['/sessions/{userId}/storage_state']?.delete,
    ];
    for (const operation of operations) {
      expect(operation).toBeDefined();
      expect(operation.responses?.['409']).toBeDefined();
      expect(operation.responses?.['503']).toBeDefined();
    }
  });

  test('legacy routes are marked deprecated', () => {
    const legacyPaths = {
      '/act': 'post',
      '/navigate': 'post',
      '/snapshot': 'get',
      '/tabs/open': 'post',
    };
    for (const [path, method] of Object.entries(legacyPaths)) {
      const op = spec.paths[path]?.[method];
      expect(op).toBeDefined();
      expect(op.deprecated).toBe(true);
    }
  });

  test('Error schema is defined in components', () => {
    expect(spec.components.schemas.Error).toBeDefined();
    expect(spec.components.schemas.Error.required).toContain('error');
  });

  test('tags include well-known categories', () => {
    const tagNames = spec.tags.map(t => t.name);
    for (const expected of ['System', 'Tabs', 'Navigation', 'Interaction', 'Content', 'Sessions', 'Legacy', 'Browser']) {
      expect(tagNames).toContain(expected);
    }
  });

  test('security scheme BearerAuth is defined', () => {
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.BearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  test('cookie import route has security requirement', () => {
    const op = spec.paths['/sessions/{userId}/cookies']?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual([{ BearerAuth: [] }]);
  });

  test('$ref references resolve to existing component schemas', () => {
    const schemaNames = Object.keys(spec.components?.schemas || {});
    const refs = [];
    JSON.stringify(spec, (key, val) => {
      if (key === '$ref' && typeof val === 'string') refs.push(val);
      return val;
    });

    const unresolved = refs.filter(ref => {
      const match = ref.match(/^#\/components\/schemas\/(.+)$/);
      return match && !schemaNames.includes(match[1]);
    });
    expect(unresolved).toEqual([]);
  });

  test('openapi.json in repo root and docs are up to date', () => {
    let committed;
    let docsCommitted;
    try {
      committed = JSON.parse(readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'));
      docsCommitted = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8'));
    } catch {
      throw new Error('OpenAPI artifacts not found -- run: npm run generate-openapi');
    }
    expect(committed).toEqual(spec);
    expect(docsCommitted).toEqual(spec);
  });

  test('mountDocs resolves route sources independently of process cwd', () => {
    const originalCwd = process.cwd();
    const unrelated = mkdtempSync(join(tmpdir(), 'camofox-openapi-cwd-'));
    try {
      process.chdir(unrelated);
      const app = {
        get: jest.fn(),
        use: jest.fn(),
      };
      const mounted = mountDocs(app);
      expect(Object.keys(mounted.paths || {}).length).toBeGreaterThanOrEqual(30);
      expect(mounted.paths['/tabs']?.post).toBeDefined();
      expect(mounted.paths['/sessions/{userId}/storage_state']?.delete).toBeDefined();
    } finally {
      process.chdir(originalCwd);
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  test('package allowlist ships committed spec and docs assets', () => {
    expect(pkg.files).toContain('openapi.json');
    expect(pkg.files).toContain('docs/');
  });
});
