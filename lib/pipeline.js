// LeadFinder — the pipeline, now a thin configuration of the shared
// Opportunity Finder engine (@developai/grounded-opportunity-engine), which was
// extracted from this file and verified behaviourally identical (27,720
// differential scoring cases). The flow is unchanged (build brief §1): raw item
// -> extract fields (checkpoint 1) -> score deterministically against the
// tenant's ACTIVE criteria -> evidence + qualification (checkpoint 2) -> route
// green/amber/red -> persist the full audit spine. Everything is tenant-scoped
// by newsroom_id.
//
// This file keeps LeadFinder's ENTITY SPEC (schema, tables, first-class
// columns, the two AI checkpoints — extract.js is untouched) and re-exports the
// configured pipeline under the legacy names routes.js / nightly.js /
// companies.js already use. The callers did not change.

import pool from './pool.js';
import {
  createPipeline,
  ensureSource as engineEnsureSource,
  markSourceFetch as engineMarkSourceFetch,
  getActiveCriteria as engineGetActiveCriteria,
  ensureStarterCriteria as engineEnsureStarterCriteria,
} from '@developai/grounded-opportunity-engine';
import { STARTER_CRITERIA } from './scoring.js';
import { extractTenderFields, extractEvidence } from './extract.js';

const SCHEMA = 'leadfinder';

const pipeline = createPipeline({
  pool,
  schema: SCHEMA,
  entity: 'tender',
  table: 'tenders',
  flags: { table: 'tender_flags', fk: 'tender_id' },
  rawEntityFk: 'tender_id',
  // Legacy band-column names — this schema predates the engine standard
  // (new consumers use items_green/amber/red).
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
  starterNotes: 'Starter criteria (auto-seeded) — tune in LeadFinder',
  extractFields: extractTenderFields,
  extractEvidence,
  presentResult: (e) => ({ reference_no: e.reference_no, title: e.title }),
});

// ── legacy surface, preserved exactly ────────────────────────────────────────

// criteria config (tenant-owned, versioned, per-entity). `entity` keeps the two
// scored things apart: 'tender' (the original pipeline) and 'company' (plan v2
// — the lead). One active per entity.
export const getActiveCriteria = (newsroomId, entity = 'tender') =>
  engineGetActiveCriteria(pool, SCHEMA, newsroomId, entity);

// Bootstrap a tenant with starter criteria (active) if they have none for the
// entity — companies.js passes { entity: 'company', starter:
// STARTER_COMPANY_CRITERIA, notes: … } and the opts spread preserves that.
export const ensureStarterCriteria = (newsroomId, createdBy = null, opts = {}) =>
  engineEnsureStarterCriteria(pool, SCHEMA, newsroomId, {
    entity: 'tender',
    starter: STARTER_CRITERIA,
    notes: 'Starter criteria (auto-seeded) — tune in LeadFinder',
    createdBy,
    ...opts,
  });

// Get-or-create a source for the tenant (the CLI uses an 'upload' source).
export const ensureSource = (newsroomId, def) => engineEnsureSource(pool, SCHEMA, newsroomId, def);

// Source fetch telemetry — semantics unchanged (see the engine's sources.js).
export const markSourceFetch = (sourceId, opts) => engineMarkSourceFetch(pool, SCHEMA, sourceId, opts);

// ingest one tender: extract -> score -> evidence -> route -> persist.
export const ingestTender = async (args) => {
  const r = await pipeline.ingestItem(args);
  return r.duplicate ? r : { ...r, tender_id: r.entity_id };
};

// run the pipeline over a batch of items, logging a run for the digest.
export const runPipeline = async (args) => {
  const out = await pipeline.runPipeline(args);
  return { ...out, tenders: out.results };
};
