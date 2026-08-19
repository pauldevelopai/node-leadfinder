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
import { cidbSweepForTenant } from './cidb.js';

export async function sweepAllTenants() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT newsroom_id FROM leadfinder.sources WHERE active = true AND approved = true`);

  const tally = { tenants: 0, itemsNew: 0, green: 0, amber: 0, red: 0, companiesNew: 0, signalsNew: 0, suppressed: 0, cidbMatched: 0, errors: 0 };
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

      // THE NIGHTLY BUDGET (operator's hard ceiling: US$0.40/night).
      // Each genuinely new item costs two Haiku calls ≈ $0.008, so 45 items
      // ≈ $0.36 worst case. Items past the cap are DEFERRED, not dropped:
      // sources are marked partial (high-water marker doesn't advance), so
      // tomorrow re-walks the window; already-processed items dedupe out
      // before any model call. Loud in the log — never a silent cap.
      const NIGHT_CAP = parseInt(process.env.LEADFINDER_NIGHTLY_ITEM_CAP, 10) || 45;

      const fetched = [];
      for (const s of sources) {
        const r = await fetchSource(s);
        fetched.push({ source: s, result: r });
      }
      let items = fetched.flatMap(({ source, result }) =>
        result.items.map((g) => ({ ...g, sourceId: source.id })));
      const capped = items.length > NIGHT_CAP;
      if (capped) {
        console.log(`[leadfinder nightly] ${newsroomId}: budget cap — processing ${NIGHT_CAP} of ${items.length} items; ${items.length - NIGHT_CAP} deferred to tomorrow's re-walk.`);
        items = items.slice(0, NIGHT_CAP);
      }
      for (const { source, result } of fetched) {
        await markSourceFetch(source.id, { error: result.error, unwired: result.unwired, partial: capped });
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

      // CIDB Register fill (Tier 0, FREE — no model calls). Grade bands are the
      // first real differentiator on this homogeneous data. Self-disables when
      // CIDB_PER_SWEEP=0; kept 0 on the box until the live portal flow is
      // confirmed via the on-demand tool, then raised to fill nightly.
      try {
        const cidb = await cidbSweepForTenant(newsroomId);
        tally.cidbMatched += cidb.matched || 0;
        if (cidb.attempted) console.log(`[leadfinder nightly] ${newsroomId}: CIDB — ${cidb.matched} matched, ${cidb.possible} possible, ${cidb.none} none of ${cidb.attempted} checked.`);
        for (const n of cidb.notes) console.log(`[leadfinder nightly] ${newsroomId}: ${n}`);
      } catch (e) {
        console.error(`[leadfinder nightly] ${newsroomId}: CIDB sweep failed — ${e.message}`);
      }

      if (items.length || cd.signals_new) tally.tenants++;
    } catch (e) {
      tally.errors++;
      console.error(`[leadfinder nightly] tenant ${newsroomId}:`, e.message);
    }
  }
  return tally;
}

export default sweepAllTenants;
