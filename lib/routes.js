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
import {
  sweepCompaniesForTenant, importClientList, CALL_SHEET_FORM, ensureCompanyCriteria,
} from './companies.js';
import { proposeCompanyReweight } from './reweight.js';
import { mountMcp, mountMcpKeyRoutes } from './mcp.js';

const MAX_MB = parseInt(process.env.UPLOAD_MAX_MB, 10) || 100;
const upload = multer({
  dest: path.join(os.tmpdir(), 'leadfinder-uploads'),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

export function mountAppRoutes(app, getHost, readUser = null) {
  const router = Router();

  // ── Tenancy — resolved HERE, not from the runtime host. ────────────────────
  // The runtime (through v0.15.0) scopes hosted tenants to the JWT user id
  // ("account == newsroom in the pilot"), which is right for Nodes that own
  // their own node_<slug> tables and wrong for this one: every leadfinder table
  // FKs public.newsrooms(id), and the data the tracker wrote lives under the
  // real newsroom UUID. So we resolve the newsroom the way the tracker does —
  // JWT newsroom_id if the token carries it, else a team_members lookup — and
  // fail closed for non-admins, exactly like server/lib/tenancy.js. The lite
  // (local) host has the same problem in miniature: its id is the string
  // "local", not a UUID, so local mode resolves LEADFINDER_TENANT (a newsroom
  // slug, the CLI convention) or falls back to the office newsroom.
  // getHost stays in the signature for the runtime's other services (store,
  // ai); it just no longer decides tenancy.
  const OFFICE_NEWSROOM_ID = '00000000-0000-0000-0000-000000000001';
  const userCache = new Map();   // jwt user id -> { id, newsroomId, name, email }
  let localTenantId = null;      // resolved once per process in local mode

  router.use(async (req, res, next) => {
    try {
      if (readUser) {
        const u = readUser(req);
        if (!u) return res.status(401).json({ message: 'Not signed in.' });
        let entry = userCache.get(u.id);
        if (!entry) {
          const { rows: [m] } = await pool.query(
            'SELECT newsroom_id, name, email FROM public.team_members WHERE id = $1', [u.id]);
          const newsroomId = u.newsroom_id || m?.newsroom_id || null;
          if (!newsroomId && u.role !== 'admin') {
            // Fail closed — a mis-configured business user must never fall
            // through onto another tenant's data.
            return res.status(403).json({ message: 'No tenant resolved for this account — contact your Be AI Ready consultant.' });
          }
          entry = {
            id: u.id,
            newsroomId: newsroomId || OFFICE_NEWSROOM_ID,   // admins may dogfood on office
            name: m?.name || null,
            email: m?.email || u.email || null,
          };
          userCache.set(u.id, entry);
        }
        req._lf = entry;
      } else {
        if (!localTenantId) {
          const slug = process.env.LEADFINDER_TENANT || null;
          if (slug) {
            const { rows: [nr] } = await pool.query('SELECT id FROM public.newsrooms WHERE slug = $1', [slug]);
            if (!nr) return res.status(500).json({ message: `LEADFINDER_TENANT '${slug}' not found in newsrooms.` });
            localTenantId = nr.id;
          } else {
            localTenantId = OFFICE_NEWSROOM_ID;
          }
        }
        req._lf = { id: null, newsroomId: localTenantId, name: null, email: null };
      }
      next();
    } catch (err) {
      console.error('[lf/tenancy]', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  const tenant = (req) => {
    const id = req._lf?.newsroomId;
    if (!id) throw new Error('No newsroom resolved for this request.');
    return id;
  };
  const person = (req) => req._lf || {};

  // Who am I — the UI uses this to say "claimed by you" and stamp decisions.
  router.get('/whoami', (req, res) => {
    const p = person(req);
    res.json({ id: p.id, name: p.name, email: p.email });
  });

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

  // ── Config B: criteria (versioned, per-entity — a tune creates a new ───────
  // active version for THAT entity; the other entity's active version stands).
  const entityOf = (req) => (String((req.query?.entity ?? req.body?.entity) || 'tender') === 'company' ? 'company' : 'tender');

  router.get('/criteria', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      res.json(entityOf(req) === 'company'
        ? await ensureCompanyCriteria(newsroomId)
        : await ensureStarterCriteria(newsroomId, null));
    } catch (err) { console.error('[lf/criteria]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/criteria', async (req, res) => {
    const client = await pool.connect();
    try {
      const newsroomId = tenant(req);
      const entity = entityOf(req);
      const { thresholds, weights } = req.body || {};
      if (!Array.isArray(weights) || !weights.length) return res.status(400).json({ message: 'weights are required' });
      await client.query('BEGIN');
      const { rows: [mx] } = await client.query(
        'SELECT COALESCE(MAX(version),0) AS v FROM leadfinder.criteria_versions WHERE newsroom_id = $1', [newsroomId]);
      await client.query(
        `UPDATE leadfinder.criteria_versions SET status = 'archived' WHERE newsroom_id = $1 AND entity = $2 AND status = 'active'`,
        [newsroomId, entity]);
      const { rows: [ver] } = await client.query(
        `INSERT INTO leadfinder.criteria_versions (newsroom_id, version, entity, status, thresholds, notes, activated_at)
         VALUES ($1,$2,$3,'active',$4::jsonb,$5,NOW()) RETURNING id, version`,
        [newsroomId, mx.v + 1, entity, JSON.stringify(thresholds || {}), req.body.notes || 'Tuned in LeadFinder']);
      for (const w of weights) {
        await client.query(
          `INSERT INTO leadfinder.criteria_weights (criteria_version_id, component, weight, source, rule)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [ver.id, String(w.component).slice(0, 60), Number(w.weight) || 1.0,
           w.source === 'learned' ? 'learned' : 'prior', JSON.stringify(w.rule || {})]);
      }
      await client.query('COMMIT');
      res.status(201).json(await getActiveCriteria(newsroomId, entity));
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

      // A client list is more than a document — it is the dedupe data. Import
      // it into cms_accounts on arrival; failure to parse never fails the
      // upload (the file is stored either way, and the error says why).
      let imported = null;
      if (docType === 'client_list') {
        imported = await importClientList({ newsroomId, documentId: doc.id, filePath });
        if (imported?.imported > 0) {
          await pool.query(`UPDATE leadfinder.documents SET status = 'applied' WHERE id = $1`, [doc.id]);
        }
      }

      res.status(201).json({ ...doc, has_text: !!text, supersedes: mx.v || null, imported });
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

  // ── Companies — the call list (plan v2: the company IS the lead) ───────────
  const OUTCOME_STAGES = ['claimed', 'called', 'meeting', 'converted', 'lost', 'retained_90d', 'retained_12m'];

  router.get('/companies', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { band, grade_band, q, include_suppressed } = req.query;
      const clauses = ['c.newsroom_id = $1']; const params = [newsroomId];
      if (!include_suppressed) clauses.push('c.suppressed_as_existing = false');
      if (band)       { params.push(band);       clauses.push(`c.band = $${params.length}`); }
      if (grade_band) { params.push(grade_band); clauses.push(`c.grade_band = $${params.length}`); }
      if (q)          { params.push(`%${String(q).toLowerCase()}%`); clauses.push(`c.normalised_name LIKE $${params.length}`); }
      const { rows: companies } = await pool.query(
        `SELECT c.id, c.name, c.cidb_grading, c.cidb_grade, c.grade_band, c.cidb_status, c.cidb_expiry,
                c.cidb_lookup_status, c.province, c.contacts,
                c.total_score, c.band, c.status, c.routing_reason, c.current_stage,
                c.suppressed_as_existing, c.claimed_by, c.claimed_by_name, c.claimed_at,
                c.first_seen_at, c.last_signal_at,
                (SELECT COUNT(*) FROM leadfinder.company_signals s WHERE s.company_id = c.id)::int AS signals
           FROM leadfinder.companies c
          WHERE ${clauses.join(' AND ')}
          ORDER BY c.total_score DESC NULLS LAST, c.last_signal_at DESC NULLS LAST
          LIMIT 200`, params);
      // The headline counters: "N found, M already yours, K to call."
      const { rows: [counters] } = await pool.query(
        `SELECT COUNT(*)::int AS found,
                COUNT(*) FILTER (WHERE suppressed_as_existing)::int AS suppressed,
                COUNT(*) FILTER (WHERE NOT suppressed_as_existing
                                   AND (current_stage IS NULL OR current_stage IN ('claimed','called')))::int AS to_call,
                COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '7 days')::int AS new_7d
           FROM leadfinder.companies WHERE newsroom_id = $1`, [newsroomId]);
      res.json({ counters, companies });
    } catch (err) { console.error('[lf/companies]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.get('/companies/:id', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { rows: [c] } = await pool.query(
        `SELECT c.*, a.name AS cms_match_name
           FROM leadfinder.companies c
           LEFT JOIN leadfinder.cms_accounts a ON a.id = c.cms_match_id
          WHERE c.id = $1 AND c.newsroom_id = $2`, [req.params.id, newsroomId]);
      if (!c) return res.status(404).json({ message: 'Not found' });
      const { rows: signals } = await pool.query(
        `SELECT kind, value, occurred_at, evidence_note FROM leadfinder.company_signals
          WHERE company_id = $1 ORDER BY occurred_at DESC NULLS LAST LIMIT 50`, [c.id]);
      const { rows: reviews } = await pool.query(
        `SELECT answers, decision, reason, decided_at FROM leadfinder.company_reviews
          WHERE company_id = $1 ORDER BY decided_at DESC LIMIT 10`, [c.id]);
      const { rows: outcomes } = await pool.query(
        `SELECT stage, reason, note, recorded_at FROM leadfinder.company_outcomes
          WHERE company_id = $1 ORDER BY recorded_at ASC`, [c.id]);
      res.json({ ...c, signals, reviews, outcomes });
    } catch (err) { console.error('[lf/company]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // First to claim owns it — the fix for "there's no rule of thumb". The WHERE
  // claimed_at IS NULL makes two simultaneous claims race safely: one wins, the
  // other gets a 409 naming the winner.
  router.post('/companies/:id/claim', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const p = person(req);
      const name = p.name || p.email || (req.body?.name ? String(req.body.name).slice(0, 120) : 'someone');
      const { rows } = await pool.query(
        `UPDATE leadfinder.companies
            SET claimed_by = $3, claimed_by_name = $4, claimed_at = NOW(),
                current_stage = COALESCE(current_stage, 'claimed'), updated_at = NOW()
          WHERE id = $1 AND newsroom_id = $2 AND claimed_at IS NULL
          RETURNING id`,
        [req.params.id, newsroomId, p.id, name]);
      if (!rows.length) {
        const { rows: [c] } = await pool.query(
          `SELECT claimed_by_name FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`,
          [req.params.id, newsroomId]);
        if (!c) return res.status(404).json({ message: 'Not found' });
        return res.status(409).json({ message: `Already claimed by ${c.claimed_by_name || 'a colleague'}.` });
      }
      await pool.query(
        `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, recorded_by)
         VALUES ($1, $2, 'claimed', $3)`, [newsroomId, req.params.id, p.id]);
      res.json({ ok: true, claimed_by_name: name });
    } catch (err) { console.error('[lf/claim]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/companies/:id/unclaim', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE leadfinder.companies
            SET claimed_by = NULL, claimed_by_name = NULL, claimed_at = NULL,
                current_stage = CASE WHEN current_stage = 'claimed' THEN NULL ELSE current_stage END,
                updated_at = NOW()
          WHERE id = $1 AND newsroom_id = $2 AND claimed_at IS NOT NULL`,
        [req.params.id, tenant(req)]);
      if (!rowCount) return res.status(404).json({ message: 'Not found or not claimed' });
      res.json({ ok: true });
    } catch (err) { console.error('[lf/unclaim]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // The call sheet, captured in-app. Answers are stored verbatim (JSONB); an
  // optional decision routes the company; the sheet itself is the vetting
  // record Karen described. Posting one implies a call happened.
  router.get('/call-sheet-form', (_req, res) => res.json(CALL_SHEET_FORM));

  router.post('/companies/:id/call-sheet', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      if (!(await inTenant('companies', req.params.id, newsroomId))) return res.status(404).json({ message: 'Not found' });
      const p = person(req);
      const { answers, decision, reason } = req.body || {};
      if (!answers || typeof answers !== 'object') return res.status(400).json({ message: 'answers are required' });
      if (decision && !['accept', 'reject'].includes(decision)) return res.status(400).json({ message: 'decision must be accept or reject' });
      await pool.query(
        `INSERT INTO leadfinder.company_reviews (newsroom_id, company_id, answers, decision, reason, decided_by)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
        [newsroomId, req.params.id, JSON.stringify(answers), decision || null, reason || null, p.id]);
      // Advancing to 'called' also writes the ladder row — otherwise the
      // history reads claimed → meeting with the call itself missing.
      const { rows: [adv] } = await pool.query(
        `UPDATE leadfinder.companies
            SET current_stage = CASE WHEN current_stage IS NULL OR current_stage = 'claimed' THEN 'called' ELSE current_stage END,
                status = CASE WHEN $3 = 'accept' THEN 'qualified' WHEN $3 = 'reject' THEN 'rejected' ELSE status END,
                updated_at = NOW()
          WHERE id = $1 AND newsroom_id = $2
          RETURNING (xmax != 0 AND current_stage = 'called') AS advanced_to_called`,
        [req.params.id, newsroomId, decision || null]);
      if (adv?.advanced_to_called) {
        await pool.query(
          `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, note, recorded_by)
           SELECT $1, $2, 'called', 'via call sheet', $3
            WHERE NOT EXISTS (SELECT 1 FROM leadfinder.company_outcomes WHERE company_id = $2 AND stage = 'called')`,
          [newsroomId, req.params.id, p.id]);
      }
      res.status(201).json({ ok: true });
    } catch (err) { console.error('[lf/call-sheet]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // The outcome ladder — one row per step; the whole history is kept. The
  // reweighting target is retained, not converted, so the ladder runs past the
  // sale to retained_90d / retained_12m.
  router.post('/companies/:id/outcome', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      if (!(await inTenant('companies', req.params.id, newsroomId))) return res.status(404).json({ message: 'Not found' });
      const { stage, reason, note } = req.body || {};
      if (!OUTCOME_STAGES.includes(stage)) return res.status(400).json({ message: `stage must be one of: ${OUTCOME_STAGES.join(', ')}` });
      await pool.query(
        `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, reason, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newsroomId, req.params.id, stage, reason || null, note || null, person(req).id]);
      await pool.query(
        `UPDATE leadfinder.companies SET current_stage = $3, updated_at = NOW() WHERE id = $1 AND newsroom_id = $2`,
        [req.params.id, newsroomId, stage]);
      res.status(201).json({ ok: true });
    } catch (err) { console.error('[lf/company-outcome]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // On-demand CIDB register lookup (enrichment Tier 0) — also the renewal
  // check for a company already matched. One list request against the portal.
  router.post('/companies/:id/cidb', async (req, res) => {
    try {
      const { cidbLookupById } = await import('./cidb.js');
      res.json(await cidbLookupById(req.params.id, tenant(req)));
    } catch (err) {
      console.error('[lf/cidb]', err);
      res.status(500).json({ message: err.message || 'CIDB lookup failed.' });
    }
  });

  // Resolve the possible-match state: a person picks one stored candidate
  // ({crs_number}) or dismisses the queue ({dismiss:true}). This is the only
  // way an ambiguous register match ever attaches.
  router.post('/companies/:id/cidb/resolve', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      if (!(await inTenant('companies', req.params.id, newsroomId))) return res.status(404).json({ message: 'Not found' });
      const { crs_number, dismiss } = req.body || {};
      if (!dismiss && !crs_number) return res.status(400).json({ message: 'Send crs_number to attach a candidate, or dismiss:true to clear the queue.' });
      const p = person(req);
      const { resolveCidbCandidate } = await import('./cidb.js');
      res.json(await resolveCidbCandidate(req.params.id, newsroomId, {
        crsNumber: crs_number || null,
        dismiss: !!dismiss,
        resolvedBy: p.name || p.email || 'unknown',
      }));
    } catch (err) {
      console.error('[lf/cidb-resolve]', err);
      res.status(500).json({ message: err.message || 'Could not resolve the CIDB candidate.' });
    }
  });

  // On-demand enrichment — the web-researched profile, stored on the row.
  router.post('/companies/:id/enrich', async (req, res) => {
    try {
      const { enrichCompany } = await import('./enrich.js');
      res.json(await enrichCompany(req.params.id, tenant(req)));
    } catch (err) {
      console.error('[lf/enrich]', err);
      res.status(500).json({ message: err.message || 'Enrichment failed.' });
    }
  });

  // Manual company sweep — fetch awards sources, upsert, suppress, score.
  router.post('/companies/run', async (req, res) => {
    try { res.json(await sweepCompaniesForTenant(tenant(req))); }
    catch (err) { console.error('[lf/companies/run]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // The company learning loop: outcomes in → weight proposal out. Propose-only;
  // applying = saving the proposal through POST /criteria?entity=company, which
  // is the same human gate every criteria change goes through.
  router.get('/companies/reweight/proposal', async (req, res) => {
    try { res.json(await proposeCompanyReweight(tenant(req))); }
    catch (err) { console.error('[lf/companies/reweight]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Reweight proposal (propose-only, human-gated) ──────────────────────────
  router.get('/reweight/proposal', async (req, res) => {
    try { res.json(await proposeReweight(tenant(req))); }
    catch (err) { console.error('[lf/reweight]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // ── Manual run: fetch the tenant's active sources now + process ────────────
  // Tender sources feed the extract→score pipeline; awards sources feed the
  // company sweep. Both run, so one button refreshes the whole morning.
  router.post('/run', async (req, res) => {
    try {
      const newsroomId = tenant(req);
      const { rows: sources } = await pool.query(
        `SELECT * FROM leadfinder.sources
          WHERE newsroom_id = $1 AND active = true AND approved = true
            AND kind <> 'etenders_awards'`, [newsroomId]);
      const items = []; const notes = [];
      for (const s of sources) {
        const r = await fetchSource(s);
        items.push(...r.items.map((g) => ({ ...g, sourceId: s.id })));
        if (r.note) notes.push(`${s.name}: ${r.note}`);
        await markSourceFetch(s.id, { error: r.error, unwired: r.unwired });
      }
      const companies = await sweepCompaniesForTenant(newsroomId);
      notes.push(...companies.notes);
      if (!items.length && !companies.signals_new) {
        return res.json({ ran: false, notes, companies, message: 'No new items from active sources. Upload a tender to see it scored.' });
      }
      const tenders = items.length ? await runPipeline({ newsroomId, sourceId: null, items }) : null;
      res.json({ ran: true, ...(tenders || {}), companies, notes });
    } catch (err) { console.error('[lf/run]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  // MCP key management rides inside the cookie-authed API (a signed-in user
  // mints keys for their own tenant only).
  mountMcpKeyRoutes(router, tenant, person);

  app.use('/api', router);

  // The MCP front door mounts OUTSIDE the cookie boundary — its Bearer key is
  // the auth AND the tenancy (Claude.ai / ChatGPT connectors have no tracker
  // cookie). See lib/mcp.js.
  mountMcp(app);
}

export default mountAppRoutes;
