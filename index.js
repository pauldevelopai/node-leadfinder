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

// appSlug, not slug — v0.14's createLiteHost throws on the latter. (The lite
// host's tenancy is unused here anyway: routes resolve LEADFINDER_TENANT.)
const host = createLiteHost({ appSlug: 'leadfinder', nodeVersion: pkg.version });

// v0.14's LOCAL createServer has no mountRoutes option (only the hosted entry
// does) — it silently ignored the one this file used to pass, which is why
// local mode never actually served the LeadFinder API. It does return the
// express app, so the routes mount after the fact; Express is happy to take
// routes post-listen, and /api/* doesn't collide with the static mount.
const app = createServer({
  slug: 'leadfinder',
  displayName: 'LeadFinder',
  host,
  handlers: {},
  nodeVersion: pkg.version,
  staticDir: join(__dirname, 'public'),
});
mountAppRoutes(app, () => host);
