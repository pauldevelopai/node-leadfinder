// LeadFinder — the tender pipeline, now a thin configuration of the shared
// Opportunity Finder engine.
//
// Refit 2026-08-19. What moved into @developai/grounded-opportunity-engine:
// the dedup→extract→score→evidence→route→persist sequence, the run/digest
// bookkeeping, the criteria machinery and the source telemetry. What stays
// here: the LeadFinder ENTITY SPEC (which schema, table, columns and flags),
// the seed criteria (scoring.js), the extraction prompts (extract.js), and the
// legacy function names the rest of this Node imports.
//
// Verified before the swap: 1,118 real L2B records (150 companies + 968
// tenders) scored identically through the old local implementation and the
// engine — zero mismatches on total, band, routing reason and every
// per-component score. No schema change, no data change, no behaviour change.
//
// TWO DELIBERATE NON-DELEGATIONS, both documented rather than silently forked:
//
//   1. `markSourceFetch` stays local. The engine's version has no `partial`
//      flag, and the nightly budget cap depends on it: a capped night must
//      withhold the high-water advance WITHOUT recording an error, so
//      tomorrow re-walks the window and picks up the deferred items. Using the
//      engine's version would advance the marker on a capped night and skip
//      those items permanently — silent data loss. Lifting `partial` into the
//      engine is the right next step (it is a general ingestion concern);
//      until the engine carries it, this stays here.
//
//   2. `extract.js` is untouched. The engine's extractor factories are
//      equivalent machinery but send a different user-content header
//      ("SOURCE TEXT:" vs LeadFinder's "TENDER NOTICE:"). Extraction prompts
//      are domain config for a live client system, so changing them for no
//      functional gain is not worth the risk. Agreed with the engine session.

import pool from './pool.js';
import {
  createPipeline,
  ensureSource as engineEnsureSource,
  getActiveCriteria as engineGetActiveCriteria,
  ensureStarterCriteria as engineEnsureStarterCriteria,
} from '@developai/grounded-opportunity-engine';
import { scoreTender, STARTER_CRITERIA } from './scoring.js';
import { extractTenderFields, extractEvidence } from './extract.js';

const SCHEMA = 'leadfinder';
const STARTER_NOTES = 'Starter criteria (auto-seeded) — tune in LeadFinder';

// ── the LeadFinder entity spec ───────────────────────────────────────────────
const pipeline = createPipeline({
  pool,
  schema: SCHEMA,
  entity: 'tender',
  table: 'tenders',
  flags: { table: 'tender_flags', fk: 'tender_id' },
  rawEntityFk: 'tender_id',
  runsBandColumns: { green: 'tenders_green', amber: 'tenders_amber', red: 'tenders_red' },
  columns: [
    { col: 'reference_no', from: 'reference_no' },
    { col: 'issuing_body', from: 'issuing_body' },
    { col: 'title', from: 'title' },
    { col: 'closing_date', from: (e) => e.closing_date || null },
    { col: 'estimated_value', from: 'estimated_value' },
    { col: 'cidb_grade', from: 'cidb_grade' },
  ],
  starterCriteria: STARTER_CRITERIA,
  starterNotes: STARTER_NOTES,
  extractFields: extractTenderFields,
  extractEvidence,
  presentResult: (e) => ({ reference_no: e.reference_no, title: e.title }),
});

// ── the legacy surface, preserved exactly ───────────────────────────────────
// routes.js, nightly.js, companies.js and mcp.js import these names; the
// signatures and return shapes are unchanged from before the refit.

export const getActiveCriteria = (newsroomId, entity = 'tender') =>
  engineGetActiveCriteria(pool, SCHEMA, newsroomId, entity);

// `opts` spreads LAST so companies.js's { entity: 'company', starter:
// STARTER_COMPANY_CRITERIA, notes } override still wins.
export const ensureStarterCriteria = (newsroomId, createdBy = null, opts = {}) =>
  engineEnsureStarterCriteria(pool, SCHEMA, newsroomId, {
    entity: 'tender', starter: STARTER_CRITERIA, notes: STARTER_NOTES, createdBy, ...opts,
  });

export const ensureSource = (newsroomId, def) => engineEnsureSource(pool, SCHEMA, newsroomId, def);

// Local, not delegated — see note 1 at the top of this file. A successful pull
// stamps last_success_at; an error records it; an unwired stub does neither;
// `partial` (the nightly budget cap) withholds the advance without an error so
// the window is re-walked tomorrow.
export async function markSourceFetch(sourceId, { error = null, unwired = false, partial = false } = {}) {
  if (!sourceId) return;
  await pool.query(
    `UPDATE ${SCHEMA}.sources
        SET last_run_at = NOW(),
            last_success_at = CASE WHEN $2 THEN NOW() ELSE last_success_at END,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [sourceId, !error && !unwired && !partial, error]
  );
}

// The engine returns `entity_id`; LeadFinder's callers expect `tender_id`.
export const ingestTender = async (args) => {
  const r = await pipeline.ingestItem(args);
  return r.duplicate ? r : { ...r, tender_id: r.entity_id };
};

// The engine returns `results`; LeadFinder's callers expect `tenders`.
export const runPipeline = async (args) => {
  const out = await pipeline.runPipeline(args);
  return { ...out, tenders: out.results };
};
