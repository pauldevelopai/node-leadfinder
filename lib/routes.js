/**
 * routes.js — LeadFinder's own API, mounted by both entries:
 *   Local  (index.js):         mountAppRoutes(app, () => host)
 *   Hosted (server-hosted.js): mountAppRoutes(app, hostFor)   // per-request host
 *
 * Ported from the tracker's server/routes/beaiready-leadfinder.js. Two things
 * changed in the move, both because the runtime already does them:
 *
 *   * tenancy — the tracker resolved the newsroom itself via resolveNewsroomId().
 *     createHostedServer verifies the tracker_token cookie and hands us a
 *     newsroom-scoped host per request, so the tenant comes from getHost(req)
 *     rather than being looked up. Wall 1 is enforced by the runtime, not here.
 *   * uploads — the tracker used its own multer middleware and document-processor.
 *     Those are now lib/document-processor.js and a local multer instance, so the
 *     Node has no dependency on the tracker's server code.
 *
 * Everything else — the digest, the review queue, outcomes, sources, criteria,
 * the document intake — is the same logic against the same tables.
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import multer from 'multer';
import pool from './pool.js';
import { extractText } from './document-processor.js';
import {
  runPipeline, ensureSource, ensureStarterCriteria, getActiveCriteria, ingestTender, markSourceFetch,
} from './pipeline.js';
import { fetchSource } from './fetch.js';
import { proposeReweight } from './reweight.js';
import { DOCUMENT_CATALOGUE, buildChecklist } from './documents.js';

const MAX_MB = parseInt(process.env.UPLOAD_MAX_MB, 10) || 100;
const upload = multer({
  dest: path.join(os.tmpdir(), 'leadfinder-uploads'),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

export function mountAppRoutes(app, getHost) {
  const router = Router();

  // The runtime's host carries the resolved newsroom. One helper so no route
  // reaches past it — this is the tenancy boundary for the whole Node.
  const tenant = (req) => {
    const host = getHost(req);
    const id = host?.newsroomId || host?.newsroom?.id;
    if (!id) throw new Error('No newsroom on this request — the runtime should have rejected it.');
    return id;
  };

  const inTenant = async (table, id, newsroomId) => {
    const { rows: [r] } = await pool.query(
      `SELECT id FROM leadfinder.${table} WHERE id = $1 AND newsroom_id = $2`, [id, newsroomId]);
    return !!r;
  };

  // ── Morning digest ────────────────────────────────────────────────────────
  router.get('/digest', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { rows: [run] } = await pool.query(
        `SELECT id, started_at, finished_at, items_seen, items_new, tenders_green, tenders_amber, tenders_red, status
           FROM leadfinder.runs WHERE newsroom_id = $1 ORDER BY started_at DESC LIMIT 1`, [newsroomId]);
      const { rows: leads } = await pool.query(
        `SELECT t.id, t.reference_no, t.issuing_body, t.title, t.closing_date, t.estimated_value,
                t.total_score, t.band, t.status, t.routing_reason,
                (SELECT COUNT(*) FROM leadfinder.tender_flags f WHERE f.tender_id = t.id) AS flags
           FROM leadfinder.tenders t
          WHERE t.newsroom_id = $1 AND t.band IN ('green','amber') AND t.status IN ('qualified','needs_review')
          ORDER BY t.total_score DESC NULLS LAST, t.closing_date ASC NULLS LAST LIMIT 100`, [newsroomId]);
      res.json({ run: run || null, leads });
    } catch (err) { console.error('[lf/digest]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Tenders ───────────────────────────────────────────────────────────────
  router.get('/tenders', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { band, status } = req.query;
      const clauses = ['newsroom_id = $1']; const params = [newsroomId];
      if (band)   { params.push(band);   clauses.push(`band = $${params.length}`); }
      if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
      const { rows } = await pool.query(
        `SELECT id, reference_no, issuing_body, title, closing_date, estimated_value, total_score, band, status, ingested_at
           FROM leadfinder.tenders WHERE ${clauses.join(' AND ')}
          ORDER BY total_score DESC NULLS LAST LIMIT 200`, params);
      res.json(rows);
    } catch (err) { console.error('[lf/tenders]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.get('/tenders/:id', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { rows: [t] } = await pool.query(
        'SELECT * FROM leadfinder.tenders WHERE id = $1 AND newsroom_id = $2', [req.params.id, newsroomId]);
      if (!t) return res.status(404).json({ message: 'Not found' });
      const { rows: flags } = await pool.query(
        'SELECT flag_type, severity, confidence, evidence_note FROM leadfinder.tender_flags WHERE tender_id = $1 ORDER BY severity DESC', [t.id]);
      const { rows: [decision] } = await pool.query(
        'SELECT decision, reason, decided_at FROM leadfinder.review_decisions WHERE tender_id = $1 ORDER BY decided_at DESC LIMIT 1', [t.id]);
      const { rows: [outcome] } = await pool.query(
        'SELECT outcome, converted, rating, note, recorded_at FROM leadfinder.lead_outcomes WHERE tender_id = $1 ORDER BY recorded_at DESC LIMIT 1', [t.id]);
      res.json({ ...t, flags, decision: decision || null, outcome: outcome || null });
    } catch (err) { console.error('[lf/tender]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/tenders/upload', upload.single('file'), async (req, res) => {
    const filePath = req.file?.path;
    try {
      const newsroomId = tenant(req);
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
      const text = await extractText(filePath, req.file.mimetype);
      if (!text || !text.trim()) return res.status(422).json({ message: 'Could not read any text from that file.' });
      const sourceId = await ensureSource(newsroomId, { name: 'Manual uploads', kind: 'upload', origin: 'human' });
      const criteria = await ensureStarterCriteria(newsroomId, null);
      res.status(201).json(await ingestTender({
        newsroomId, sourceId, criteria, text,
        externalId: `upload:${req.file.originalname}:${Date.now()}`, url: null,
      }));
    } catch (err) {
      console.error('[lf/upload]', err);
      res.status(500).json({ message: err.message || 'Could not process the document.' });
    } finally { if (filePath) fs.unlink(filePath, () => {}); }
  });

  router.post('/tenders/:id/review', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      if (!(await inTenant('tenders', req.params.id, newsroomId))) return res.status(404).json({ message: 'Not found' });
      const { decision, reason } = req.body || {};
      if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ message: 'decision must be accept or reject' });
      await pool.query(
        `INSERT INTO leadfinder.review_decisions (tender_id, newsroom_id, decision, reason) VALUES ($1,$2,$3,$4)`,
        [req.params.id, newsroomId, decision, reason || null]);
      await pool.query(`UPDATE leadfinder.tenders SET status = $2, updated_at = NOW() WHERE id = $1`,
        [req.params.id, decision === 'accept' ? 'qualified' : 'rejected']);
      res.json({ ok: true });
    } catch (err) { console.error('[lf/review]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/tenders/:id/outcome', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      if (!(await inTenant('tenders', req.params.id, newsroomId))) return res.status(404).json({ message: 'Not found' });
      const { outcome, converted, rating, note } = req.body || {};
      if (!outcome) return res.status(400).json({ message: 'outcome is required' });
      await pool.query(
        `INSERT INTO leadfinder.lead_outcomes (tender_id, newsroom_id, outcome, converted, rating, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, newsroomId, String(outcome).slice(0, 16),
         typeof converted === 'boolean' ? converted : null,
         Number.isInteger(rating) ? rating : null, note || null]);
      res.json({ ok: true });
    } catch (err) { console.error('[lf/outcome]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Config A: sources ─────────────────────────────────────────────────────
  router.get('/sources', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, kind, location, active, run_frequency_hours, origin, approved, rationale,
                last_run_at, last_success_at, last_error, items_new
           FROM leadfinder.sources WHERE newsroom_id = $1 ORDER BY created_at DESC`, [tenant(req)]);
      res.json(rows);
    } catch (err) { console.error('[lf/sources]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/sources', async (req, res) => {
    try {
      const { name, kind, location, run_frequency_hours, config } = req.body || {};
      if (!name || !kind) return res.status(400).json({ message: 'name and kind are required' });
      const { rows: [row] } = await pool.query(
        `INSERT INTO leadfinder.sources (newsroom_id, name, kind, location, run_frequency_hours, config, origin)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'human') RETURNING id`,
        [tenant(req), String(name).slice(0, 300), String(kind).slice(0, 20), location || null,
         parseInt(run_frequency_hours, 10) || 24, JSON.stringify(config || {})]);
      res.status(201).json(row);
    } catch (err) { console.error('[lf/sources/post]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.put('/sources/:id', async (req, res) => {
    try {
      const { name, location, active, run_frequency_hours, approved, config } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE leadfinder.sources SET
           name = COALESCE($3, name), location = COALESCE($4, location),
           active = COALESCE($5, active), run_frequency_hours = COALESCE($6, run_frequency_hours),
           approved = COALESCE($7, approved), config = COALESCE($8::jsonb, config), updated_at = NOW()
         WHERE id = $1 AND newsroom_id = $2 RETURNING id`,
        [req.params.id, tenant(req), name ?? null, location ?? null,
         typeof active === 'boolean' ? active : null,
         Number.isInteger(run_frequency_hours) ? run_frequency_hours : null,
         typeof approved === 'boolean' ? approved : null,
         config ? JSON.stringify(config) : null]);
      if (!rows.length) return res.status(404).json({ message: 'Not found' });
      res.json({ ok: true });
    } catch (err) { console.error('[lf/sources/put]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.delete('/sources/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM leadfinder.sources WHERE id = $1 AND newsroom_id = $2', [req.params.id, tenant(req)]);
      if (!rowCount) return res.status(404).json({ message: 'Not found' });
      res.json({ ok: true });
    } catch (err) { console.error('[lf/sources/del]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Config B: criteria (versioned — a tune creates a new active version) ──
  router.get('/criteria', async (req, res) => {
    try { res.json(await ensureStarterCriteria(tenant(req), null)); }
    catch (err) { console.error('[lf/criteria]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/criteria', async (req, res) => {
    const client = await pool.connect();
    try {
      const newsroomId = tenant(req);
      const { thresholds, weights } = req.body || {};
      if (!Array.isArray(weights) || !weights.length) return res.status(400).json({ message: 'weights are required' });
      await client.query('BEGIN');
      const { rows: [mx] } = await client.query(
        'SELECT COALESCE(MAX(version),0) AS v FROM leadfinder.criteria_versions WHERE newsroom_id = $1', [newsroomId]);
      await client.query(
        `UPDATE leadfinder.criteria_versions SET status = 'archived' WHERE newsroom_id = $1 AND status = 'active'`, [newsroomId]);
      const { rows: [ver] } = await client.query(
        `INSERT INTO leadfinder.criteria_versions (newsroom_id, version, status, thresholds, notes, activated_at)
         VALUES ($1,$2,'active',$3::jsonb,$4,NOW()) RETURNING id, version`,
        [newsroomId, mx.v + 1, JSON.stringify(thresholds || {}), req.body.notes || 'Tuned in LeadFinder']);
      for (const w of weights) {
        await client.query(
          `INSERT INTO leadfinder.criteria_weights (criteria_version_id, component, weight, source, rule)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [ver.id, String(w.component).slice(0, 60), Number(w.weight) || 1.0,
           w.source === 'learned' ? 'learned' : 'prior', JSON.stringify(w.rule || {})]);
      }
      await client.query('COMMIT');
      res.status(201).json(await getActiveCriteria(newsroomId));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[lf/criteria/post]', err); res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
  });

  // ── Document intake: what we need from the client, and what has arrived ────
  router.get('/documents', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, doc_type, version, superseded_at, filename, mime_type, size_bytes,
                note, status, uploaded_at, (extracted_text IS NOT NULL) AS has_text
           FROM leadfinder.documents WHERE newsroom_id = $1
          ORDER BY doc_type, version DESC`, [tenant(req)]);
      res.json(buildChecklist(rows));
    } catch (err) { console.error('[lf/documents]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/documents', upload.single('file'), async (req, res) => {
    const filePath = req.file?.path;
    const client = await pool.connect();
    try {
      const newsroomId = tenant(req);
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
      const docType = String(req.body.doc_type || 'other').slice(0, 40);

      let text = null;
      try {
        const t = await extractText(filePath, req.file.mimetype);
        if (t && t.trim()) text = t;
      } catch (e) { console.warn('[lf/documents] text extraction failed:', e.message); }

      await client.query('BEGIN');
      const { rows: [mx] } = await client.query(
        `SELECT COALESCE(MAX(version), 0) AS v FROM leadfinder.documents
          WHERE newsroom_id = $1 AND doc_type = $2`, [newsroomId, docType]);
      await client.query(
        `UPDATE leadfinder.documents SET superseded_at = NOW()
          WHERE newsroom_id = $1 AND doc_type = $2 AND superseded_at IS NULL`, [newsroomId, docType]);
      const { rows: [doc] } = await client.query(
        `INSERT INTO leadfinder.documents
           (newsroom_id, doc_type, version, filename, mime_type, size_bytes, storage_path, extracted_text, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, doc_type, version, filename, uploaded_at`,
        [newsroomId, docType, mx.v + 1, req.file.originalname, req.file.mimetype,
         req.file.size, filePath, text, req.body.note || null]);
      await client.query('COMMIT');
      res.status(201).json({ ...doc, has_text: !!text, supersedes: mx.v || null });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[lf/documents/post]', err);
      res.status(500).json({ message: err.message || 'Could not store that document.' });
    } finally { client.release(); }
  });

  router.get('/documents/:id', async (req, res) => {
    try {
      const { rows: [d] } = await pool.query(
        `SELECT id, doc_type, version, filename, mime_type, size_bytes, note, status,
                uploaded_at, superseded_at, extracted_text
           FROM leadfinder.documents WHERE id = $1 AND newsroom_id = $2`,
        [req.params.id, tenant(req)]);
      if (!d) return res.status(404).json({ message: 'Not found' });
      res.json(d);
    } catch (err) { console.error('[lf/document]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.get('/documents-needed', (_req, res) => res.json(DOCUMENT_CATALOGUE));

  // ── Reweight proposal (propose-only, human-gated) ──────────────────────────
  router.get('/reweight/proposal', async (req, res) => {
    try { res.json(await proposeReweight(tenant(req))); }
    catch (err) { console.error('[lf/reweight]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Manual run: fetch the tenant's active sources now + process ────────────
  router.post('/run', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { rows: sources } = await pool.query(
        `SELECT * FROM leadfinder.sources WHERE newsroom_id = $1 AND active = true AND approved = true`, [newsroomId]);
      const items = []; const notes = [];
      for (const s of sources) {
        const r = await fetchSource(s);
        items.push(...r.items.map((g) => ({ ...g, sourceId: s.id })));
        if (r.note) notes.push(`${s.name}: ${r.note}`);
        await markSourceFetch(s.id, { error: r.error, unwired: r.unwired });
      }
      if (!items.length) {
        return res.json({ ran: false, notes, message: 'No new items from active sources. Upload a tender to see it scored.' });
      }
      res.json({ ran: true, ...(await runPipeline({ newsroomId, sourceId: null, items })), notes });
    } catch (err) { console.error('[lf/run]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  app.use('/api', router);
}

export default mountAppRoutes;
