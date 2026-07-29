/**
 * index.js — the LOCAL (single-newsroom) entry for LeadFinder.
 *
 * The downloaded-and-run mirror of server-hosted.js: same routes, same engine,
 * same tables — one newsroom instead of many, and no tracker cookie to verify.
 * createServer + createLiteHost is the standard local pattern.
 */

import './lib/load-env.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, createLiteHost } from '@developai/grounded-node-runtime';
import { ensureSchema } from './lib/schema.js';
import { mountAppRoutes } from './lib/routes.js';
import pool from './lib/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

await ensureSchema(pool);

const host = createLiteHost({ slug: 'leadfinder' });

await createServer({
  slug: 'leadfinder',
  productName: 'LeadFinder',
  host,
  handlers: {},
  mountRoutes: (app) => mountAppRoutes(app, () => host),
  nodeVersion: pkg.version,
  staticDir: join(__dirname, 'public'),
});
