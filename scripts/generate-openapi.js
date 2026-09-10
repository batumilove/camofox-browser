#!/usr/bin/env node

/**
 * Generate openapi.json from JSDoc annotations in server.js.
 * Run: node scripts/generate-openapi.js
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import swaggerJsdoc from 'swagger-jsdoc';
import { swaggerDefinition } from '../lib/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const spec = swaggerJsdoc({
  definition: swaggerDefinition,
  apis: [join(root, 'server.js'), join(root, 'plugins', 'persistence', 'index.js')],
});

const serialized = JSON.stringify(spec, null, 2) + '\n';
const outputs = [
  join(root, 'openapi.json'),
  join(root, 'docs', 'openapi.json'),
];
for (const output of outputs) writeFileSync(output, serialized);
console.log(`Wrote ${Object.keys(spec.paths).length} paths to ${outputs.length} OpenAPI artifacts`);
