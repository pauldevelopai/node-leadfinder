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
import { sweepCompaniesForTenant } from './companies.js';

export async function sweepAllTenants() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT newsroom_id FROM leadfinder.sources WHERE active = true AND approved = true`);

  const tally = { tenants: 0, itemsNew: 0, green: 0, amber: 0, red: 0, companiesNew: 0, signalsNew: 0, suppressed: 0, errors: 0 };
  for (const { newsroom_id: newsroomId } of tenants) {
    try {
      // Tender sources → the extract→score pipeline. Awards sources are the
      // company sweep's job, so they are excluded here (they produce company
      // signals, not notices — running them through extraction would be wrong
      // twice over).
      const { rows: sources } = await pool.query(
        `SELECT * FROM leadfinder.sources
          WHERE newsroom_id = $1 AND active = true AND approved = true
            AND kind <> 'etenders_awards'`, [newsroomId]);

      const items = [];
      for (const s of sources) {
        const r = await fetchSource(s);
        items.push(...r.items.map((g) => ({ ...g, sourceId: s.id })));
        await markSourceFetch(s.id, { error: r.error, unwired: r.unwired });
      }
      if (items.length) {
        const out = await runPipeline({ newsroomId, sourceId: null, items });
        tally.itemsNew += out.digest.new;
        tally.green += out.digest.green;
        tally.amber += out.digest.amber;
        tally.red += out.digest.red;
      }

      // The company sweep — awards harvest, suppression refresh, (re)scoring.
      const cd = await sweepCompaniesForTenant(newsroomId);
      tally.companiesNew += cd.companies_new;
      tally.signalsNew += cd.signals_new;
      tally.suppressed += cd.suppressed;
      for (const n of cd.notes) console.log(`[leadfinder nightly] ${newsroomId}: ${n}`);

      if (items.length || cd.signals_new) tally.tenants++;
    } catch (e) {
      tally.errors++;
      console.error(`[leadfinder nightly] tenant ${newsroomId}:`, e.message);
    }
  }
  return tally;
}

export default sweepAllTenants;
