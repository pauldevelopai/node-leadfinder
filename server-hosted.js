/**
 * server-hosted.js — the ONLINE (multi-tenant) entry for LeadFinder.
 *
 * createHostedServer provides tracker-cookie auth, a per-request newsroom-scoped
 * host, the standard /api route map and the GROUNDED chrome. We add LeadFinder's
 * routes via mountRoutes, adopt our tables via ensureSchema, and run the nightly
 * source sweep. index.js is the LOCAL mirror.
 *
 * Env (box .env, never committed): JWT_SECRET (must match the tracker's),
 * ANTHROPIC_API_KEY, DATABASE_URL (the shared box Postgres — the same database
 * the tracker uses, which is what lets this Node adopt the existing leadfinder
 * tables and their data). Optional: PORT, MODEL, UPLOAD_MAX_MB.
 */

import './lib/load-env.js';   // MUST be first — .env before lib/pool.js builds the pool at import time
process.env.GROUNDED_HOSTED = '1';
process.env.AI_PROVIDER = 'anthropic';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import cron from 'node-cron';
import { createHostedServer } from '@developai/grounded-node-runtime';
import { ensureSchema } from './lib/schema.js';
import { mountAppRoutes } from './lib/routes.js';
import { sweepAllTenants } from './lib/nightly.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

await createHostedServer({
  slug: 'leadfinder',
  productName: 'LeadFinder',
  handlers: {},
  ensureSchema,
  // readUser gives routes the verified JWT identity — tenancy is resolved
  // in-Node (see lib/routes.js) because the runtime's hostFor pins the tenant
  // to the user id, which is wrong for tables FK'd to public.newsrooms.
  mountRoutes: (app, { hostFor, readUser }) => mountAppRoutes(app, hostFor, readUser),
  nodeVersion: pkg.version,
  staticDir: join(__dirname, 'public'),
});

// Nightly (03:00) sweep of every tenant's active sources — the job that makes
// the morning digest exist. Process-local (single pm2 process), so one scheduler
// per instance is correct.
cron.schedule('0 3 * * *', async () => {
  try {
    const r = await sweepAllTenants();
    if (r.tenants) console.log(`[leadfinder nightly] tenants=${r.tenants} new=${r.itemsNew} green=${r.green} amber=${r.amber}`);
  } catch (e) { console.error('[leadfinder nightly]', e.message); }
});
