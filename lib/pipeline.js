// LeadFinder — the pipeline orchestration + spine writes.
//
// Flow per item (build brief §1): raw item -> extract fields (checkpoint 1) ->
// score deterministically against the tenant's ACTIVE criteria -> evidence +
// qualification (checkpoint 2) -> route green/amber/red -> persist the full
// audit spine (per-component scores, the criteria_version that scored it, the
// routing reason, evidence flags). Everything is tenant-scoped by newsroom_id.

import crypto from 'node:crypto';
import pool from './pool.js';
import { scoreTender, STARTER_CRITERIA } from './scoring.js';
import { extractTenderFields, extractEvidence } from './extract.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// green auto-qualifies; amber to the review queue; red rejected (build brief §7).
function bandToStatus(band) {
  return band === 'green' ? 'qualified' : band === 'amber' ? 'needs_review' : 'rejected';
}

// ── criteria config (tenant-owned, versioned, per-entity) ────────────────────
// Load the tenant's ACTIVE criteria version + its weight rows into the shape the
// scorer expects. `entity` keeps the two scored things apart: 'tender' (the
// original pipeline) and 'company' (plan v2 — the lead). One active per entity.
export async function getActiveCriteria(newsroomId, entity = 'tender') {
  const { rows: [ver] } = await pool.query(
    `SELECT id, version, thresholds FROM leadfinder.criteria_versions
      WHERE newsroom_id = $1 AND entity = $2 AND status = 'active' ORDER BY version DESC LIMIT 1`,
    [newsroomId, entity]
  );
  if (!ver) return null;
  const { rows: weights } = await pool.query(
    `SELECT component, weight::float AS weight, source, rule
       FROM leadfinder.criteria_weights WHERE criteria_version_id = $1`,
    [ver.id]
  );
  return { version_id: ver.id, version: ver.version, thresholds: ver.thresholds || {}, weights };
}

// Bootstrap a tenant with starter criteria (active) if they have none for the
// entity. The user then tunes it in-app; tuning creates new versions. Versions
// are monotonic per tenant ACROSS entities (UNIQUE (newsroom_id, version)), so
// the next version is MAX+1, not a hardcoded 1.
export async function ensureStarterCriteria(newsroomId, createdBy = null, {
  entity = 'tender', starter = STARTER_CRITERIA, notes = 'Starter criteria (auto-seeded) — tune in LeadFinder',
} = {}) {
  const existing = await getActiveCriteria(newsroomId, entity);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mx] } = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS v FROM leadfinder.criteria_versions WHERE newsroom_id = $1', [newsroomId]);
    const { rows: [ver] } = await client.query(
      `INSERT INTO leadfinder.criteria_versions (newsroom_id, version, entity, status, thresholds, notes, created_by, activated_at)
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, NOW())
       RETURNING id, version, thresholds`,
      [newsroomId, mx.v + 1, entity, JSON.stringify(starter.thresholds), notes, createdBy]
    );
    for (const w of starter.weights) {
      await client.query(
        `INSERT INTO leadfinder.criteria_weights (criteria_version_id, component, weight, source, rule)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ver.id, w.component, w.weight, w.source || 'prior', JSON.stringify(w.rule)]
      );
    }
    await client.query('COMMIT');
    return getActiveCriteria(newsroomId, entity);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Get-or-create a source for the tenant (the CLI uses an 'upload' source).
export async function ensureSource(newsroomId, { name, kind = 'upload', location = null, origin = 'seed' }) {
  const { rows: [found] } = await pool.query(
    `SELECT id FROM leadfinder.sources WHERE newsroom_id = $1 AND name = $2 LIMIT 1`,
    [newsroomId, name]
  );
  if (found) return found.id;
  const { rows: [created] } = await pool.query(
    `INSERT INTO leadfinder.sources (newsroom_id, name, kind, location, origin)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [newsroomId, name, kind, location, origin]
  );
  return created.id;
}

// Record a source's fetch-attempt telemetry — called by the nightly job and the
// manual /run right after fetchSource. A successful pull stamps last_success_at
// and clears last_error; an error records it; an unwired stub does neither (it
// never pulled). last_run_at always advances. The items_new/items_seen counters
// are bumped separately by runPipeline, which is the only place that knows
// new-vs-duplicate per source.
export async function markSourceFetch(sourceId, { error = null, unwired = false } = {}) {
  if (!sourceId) return;
  await pool.query(
    `UPDATE leadfinder.sources
        SET last_run_at = NOW(),
            last_success_at = CASE WHEN $2 THEN NOW() ELSE last_success_at END,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [sourceId, !error && !unwired, error]
  );
}

// ── ingest one tender: extract -> score -> evidence -> route -> persist ──────
// Fill blanks in the extraction from fields the SOURCE stated outright (OCDS
// hints). Only ever fills a null/"Not stated" — a value the extractor found in
// the notice always wins, so this can't overwrite a reading with a guess. The
// point is that a published field (e.g. the CIDB bar in `specialConditions`)
// should never depend on the model spotting it.
const BLANK = (v) => v == null || /^\s*(not stated|n\/?a|unknown|-)?\s*$/i.test(String(v));

function applyHints(extracted, hints) {
  if (!hints) return extracted;
  const out = { ...extracted };
  const filled = [];
  for (const [k, v] of Object.entries(hints)) {
    if (v == null || v === '') continue;
    if (BLANK(out[k])) { out[k] = v; filled.push(k); }
  }
  if (filled.length) out.hint_filled = filled;   // auditable: which fields came from the feed
  return out;
}

export async function ingestTender({ newsroomId, sourceId, text, criteria, externalId, url = null, hints = null }) {
  const extId = externalId || sha(text).slice(0, 32);

  // Raw item first (deduped per source). If it already exists, skip re-processing.
  const { rows: [raw] } = await pool.query(
    `INSERT INTO leadfinder.raw_items (newsroom_id, source_id, external_id, url, content, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (source_id, external_id) DO NOTHING
     RETURNING id`,
    [newsroomId, sourceId, extId, url, text]
  );
  if (!raw) return { duplicate: true, external_id: extId };

  // Checkpoint 1 — fields, then backfill anything the source stated outright.
  const extracted = applyHints(await extractTenderFields(text), hints);
  // Deterministic scoring against the tenant's criteria.
  const scoreResult = scoreTender(extracted, criteria);
  // Checkpoint 2 — evidence + qualification (never re-scores).
  const evidence = await extractEvidence(text, extracted, scoreResult);

  const status = bandToStatus(scoreResult.band);
  const { rows: [tender] } = await pool.query(
    `INSERT INTO leadfinder.tenders
       (newsroom_id, source_id, raw_item_id, reference_no, issuing_body, title, closing_date,
        estimated_value, cidb_grade, extracted, component_scores, total_score, criteria_version_id,
        band, routing_reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      newsroomId, sourceId, raw.id,
      extracted.reference_no, extracted.issuing_body, extracted.title,
      extracted.closing_date || null, extracted.estimated_value, extracted.cidb_grade,
      JSON.stringify(extracted), JSON.stringify(scoreResult.component_scores),
      scoreResult.total, criteria.version_id, scoreResult.band, scoreResult.routing_reason, status,
    ]
  );

  // Evidence flags (checkpoint 2) — plus the reviewer note as its own flag.
  const flags = [...evidence.flags];
  if (evidence.qualification_note) {
    flags.push({ flag_type: 'reviewer_note', severity: 2, confidence: 1.0, evidence_note: evidence.qualification_note });
  }
  for (const f of flags) {
    await pool.query(
      `INSERT INTO leadfinder.tender_flags (tender_id, flag_type, severity, confidence, evidence_note)
       VALUES ($1,$2,$3,$4,$5)`,
      [tender.id, f.flag_type, f.severity, f.confidence, f.evidence_note]
    );
  }

  await pool.query(
    `UPDATE leadfinder.raw_items SET status = 'extracted', tender_id = $2 WHERE id = $1`,
    [raw.id, tender.id]
  );

  return {
    tender_id: tender.id,
    band: scoreResult.band,
    total: scoreResult.total,
    status,
    reference_no: extracted.reference_no,
    title: extracted.title,
    routing_reason: scoreResult.routing_reason,
    flags: flags.length,
  };
}

// ── run the pipeline over a batch of items, logging a run for the digest ─────
export async function runPipeline({ newsroomId, sourceId, items, createdBy = null }) {
  const criteria = await ensureStarterCriteria(newsroomId, createdBy);

  const { rows: [run] } = await pool.query(
    `INSERT INTO leadfinder.runs (newsroom_id, source_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [newsroomId, sourceId]
  );

  const results = [];
  const tally = { seen: 0, new: 0, green: 0, amber: 0, red: 0, duplicate: 0, error: 0 };
  const perSource = {}; // sourceId -> { seen, new } for source-level telemetry
  for (const item of items) {
    tally.seen++;
    // A batched run (nightly / manual /run) passes sourceId:null and stamps each
    // item with its own sourceId — raw_items.source_id is NOT NULL, so honour the
    // per-item source and only fall back to the call-level one (the upload path).
    const sid = item.sourceId || sourceId;
    if (sid) (perSource[sid] ||= { seen: 0, new: 0 }).seen++;
    try {
      const r = await ingestTender({ newsroomId, sourceId: sid, criteria, text: item.text, externalId: item.externalId, url: item.url, hints: item.hints });
      if (r.duplicate) { tally.duplicate++; continue; }
      tally.new++;
      tally[r.band]++;
      if (sid) perSource[sid].new++;
      results.push(r);
    } catch (err) {
      tally.error++;
      results.push({ error: err.message, item: item.externalId || null });
    }
  }

  await pool.query(
    `UPDATE leadfinder.runs
        SET finished_at = NOW(), status = $2, items_seen = $3, items_new = $4,
            tenders_green = $5, tenders_amber = $6, tenders_red = $7, error = $8
      WHERE id = $1`,
    [run.id, tally.error && !tally.new ? 'error' : 'success', tally.seen, tally.new,
     tally.green, tally.amber, tally.red, tally.error ? `${tally.error} item error(s)` : null]
  );

  // Source-level counters (cumulative), so the Sources UI shows real "items seen /
  // new" per source rather than a stuck 0.
  for (const [sid, c] of Object.entries(perSource)) {
    await pool.query(
      `UPDATE leadfinder.sources SET items_seen = items_seen + $2, items_new = items_new + $3, updated_at = NOW() WHERE id = $1`,
      [sid, c.seen, c.new]
    );
  }

  return { run_id: run.id, criteria_version: criteria.version, digest: tally, tenders: results, perSource };
}
