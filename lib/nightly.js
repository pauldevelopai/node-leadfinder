/**
 * nightly.js — the overnight sweep.
 *
 * Ported from the tracker's server/db/scripts/leadfinder-nightly.js. For every
 * tenant with active, approved sources: fetch, run the pipeline, log a run. The
 * morning digest is just the most recent run plus its ranked output, so this is
 * the job that makes the product exist.
 */

import pool from './pool.js';
import { fetchSource } from './fetch.js';
import { runPipeline, markSourceFetch } from './pipeline.js';

export async function sweepAllTenants() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT newsroom_id FROM leadfinder.sources WHERE active = true AND approved = true`);

  const tally = { tenants: 0, itemsNew: 0, green: 0, amber: 0, red: 0, errors: 0 };
  for (const { newsroom_id: newsroomId } of tenants) {
    try {
      const { rows: sources } = await pool.query(
        `SELECT * FROM leadfinder.sources
          WHERE newsroom_id = $1 AND active = true AND approved = true`, [newsroomId]);

      const items = [];
      for (const s of sources) {
        const r = await fetchSource(s);
        items.push(...r.items.map((g) => ({ ...g, sourceId: s.id })));
        await markSourceFetch(s.id, { error: r.error, unwired: r.unwired });
      }
      if (!items.length) continue;

      const out = await runPipeline({ newsroomId, sourceId: null, items });
      tally.tenants++;
      tally.itemsNew += out.digest.new;
      tally.green += out.digest.green;
      tally.amber += out.digest.amber;
      tally.red += out.digest.red;
    } catch (e) {
      tally.errors++;
      console.error(`[leadfinder nightly] tenant ${newsroomId}:`, e.message);
    }
  }
  return tally;
}

export default sweepAllTenants;
