// LeadFinder — the MCP front door (Model Context Protocol, JSON-RPC 2.0).
//
// The vision's access layer: LeadFinder is a CONNECTOR, not only an app. A rep
// adds it to Claude.ai (or any MCP client — ChatGPT's connectors speak the same
// protocol) with a Bearer key and works the whole loop conversationally:
// "which grade-6 leads came in this week?" → "claim Tincol for me" → "log that
// the meeting converted". The outcome tools matter most — they are how the
// learning loop gets fed from wherever the rep actually is.
//
// Follows the tracker's policy-mcp.js pattern exactly (proven against the
// Claude.ai HTTP+SSE connector): GET = SSE stream with server/info + ping,
// POST = JSON-RPC (initialize / tools/list / tools/call). Auth is a per-tenant
// Bearer key, SHA-256-hashed at rest (leadfinder.mcp_keys); the key IS the
// tenancy — every tool call is scoped to the key's newsroom. Every call is
// logged to leadfinder.mcp_usage (usage counts are Foundation evidence).
//
// No public unauthenticated endpoint here, deliberately: unlike the policy
// corpus, this data is a client's commercial lead pipeline (Wall 1).

import { Router } from 'express';
import crypto from 'node:crypto';
import pool from './pool.js';
import { sweepCompaniesForTenant, CALL_SHEET_FORM, importClientRows } from './companies.js';
import { storeDocumentText } from './documents.js';
import { proposeCompanyReweight } from './reweight.js';
import { getActiveCriteria } from './pipeline.js';
import { enrichCompany, saveProfile } from './enrich.js';

const OUTCOME_STAGES = ['claimed', 'called', 'meeting', 'converted', 'lost', 'retained_90d', 'retained_12m'];

// ── Key management (mounted under /api, cookie-authed by the tenancy layer) ──
export function mountMcpKeyRoutes(router, tenant, person) {
  router.get('/mcp-keys', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, label, is_active, last_used_at, created_at
           FROM leadfinder.mcp_keys WHERE newsroom_id = $1 ORDER BY created_at DESC`, [tenant(req)]);
      res.json(rows);
    } catch (err) { console.error('[lf/mcp-keys]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.post('/mcp-keys', async (req, res) => {
    try {
      const label = String(req.body?.label || '').trim().slice(0, 200);
      if (!label) return res.status(400).json({ message: 'label is required — say whose key this is' });
      const key = `lf_${crypto.randomBytes(24).toString('base64url')}`;
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      const { rows: [row] } = await pool.query(
        `INSERT INTO leadfinder.mcp_keys (newsroom_id, key_hash, label, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id, label, created_at`,
        [tenant(req), hash, label, person(req).id]);
      // The plaintext appears exactly once, here. It is not stored.
      res.status(201).json({ ...row, key, note: 'Copy this key now — it is shown once and never stored.' });
    } catch (err) { console.error('[lf/mcp-keys/post]', err); res.status(500).json({ message: 'Internal server error' }); }
  });

  router.delete('/mcp-keys/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE leadfinder.mcp_keys SET is_active = false WHERE id = $1 AND newsroom_id = $2`,
        [req.params.id, tenant(req)]);
      if (!rowCount) return res.status(404).json({ message: 'Not found' });
      res.json({ ok: true, note: 'Key revoked. Connectors using it stop working on their next call.' });
    } catch (err) { console.error('[lf/mcp-keys/del]', err); res.status(500).json({ message: 'Internal server error' }); }
  });
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_leads',
    description: 'The call list: companies actively bidding on and winning public work, ranked by fit against your criteria. Filter by CIDB grade band (6+ / 2-5 / 1 — the territory split), routing band (green/amber/red), or a name search. Existing clients are suppressed. When presenting results, don\'t just list names: each row says whether a researched profile exists (enriched) and shows the website when known — for the leads the user cares about, follow up with get_company and present the full picture (evidence, who to approach, fit, objections). For promising leads with no profile yet, research them yourself with your own web search and store the findings with save_profile.',
    inputSchema: { type: 'object', properties: {
      grade_band: { type: 'string', enum: ['6+', '2-5', '1'], description: 'CIDB territory band' },
      band: { type: 'string', enum: ['green', 'amber', 'red'], description: 'Routing band' },
      q: { type: 'string', description: 'Company name contains…' },
      unclaimed_only: { type: 'boolean', description: 'Only companies nobody has claimed yet' },
      limit: { type: 'number', description: 'Max results (default 20, cap 50)' },
    }, required: [] },
  },
  {
    name: 'get_company',
    description: 'Everything on one company: score with per-component reasons, every signal with its evidence quote (what they bid on/won, when, for whom, value), claim state, call-sheet history, the outcome ladder — and the researched profile (enrichment) when one exists: website, what they do, offices, headcount, revenue (or the honest reason it is unpublished), WHO TO APPROACH with any published contacts, why they would benefit from a tender-intelligence subscription, and why they might resist. When presenting a lead to the user, use ALL of it: link the website, name the approach person, give the fit reasons AND the objections, and say plainly which facts are unverified (the profile is AI-drafted from web sources, each with its source URL). If enrichment is null, say the company has not been researched yet — then research it yourself with your own web search and store it with save_profile (free), rather than reaching for enrich_company (which costs the operator API credit).',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string', description: 'UUID from search_leads' },
      name: { type: 'string', description: 'Exact-ish company name, if you have no id' },
    }, required: [] },
  },
  {
    name: 'save_profile',
    description: 'THE PREFERRED WAY TO RESEARCH A LEAD — free for the operator. When a user wants the full picture on a company (or asks you to research one): use YOUR OWN web search to research it — their website, what they actually do, offices, headcount, annual revenue if PUBLISHED (when it is not, say why: private South African companies are not required to publish financials — CIDB grade and tender award values are the honest size proxies), who to approach (role and name) with any PUBLISHED contact details, why they would benefit from a tender-intelligence subscription (tie it to their bidding evidence from get_company), and why they might resist (cash flow, an existing competitor subscription, bids rarely). Then store it here so the whole team benefits and future questions answer instantly. Hard rules: never invent a fact, a name, a number or a contact — a fact you could not verify is null with a reason in the matching note field; provide the source URL for every claim in sources[]. Saved profiles are marked ai-drafted until a person verifies them.',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string', description: 'UUID from search_leads / get_company' },
      profile: { type: 'object', description: 'Keys: website, summary (required), offices, employees, employees_note, revenue, revenue_note, approach (array of {who, why, contact}), why_l2b_fit, likely_objections, sources (array of URLs — required when facts are present)' },
    }, required: ['company_id', 'profile'] },
  },
  {
    name: 'enrich_company',
    description: 'Server-side fallback research — SPENDS THE OPERATOR\'S API credit and takes 2–3 minutes, so prefer doing the research yourself and storing it with save_profile (free). Use this only when the user explicitly asks for server-side enrichment or you have no web access of your own. Same output shape and honesty rules as save_profile.',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string', description: 'UUID from search_leads' },
    }, required: ['company_id'] },
  },
  {
    name: 'claim_company',
    description: 'Claim a company before calling it — first to claim owns it, so two reps never chase the same lead. Fails (with the claimer\'s name) if someone already has it.',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string' },
      claimed_by_name: { type: 'string', description: 'Who is claiming (your name)' },
    }, required: ['company_id', 'claimed_by_name'] },
  },
  {
    name: 'log_call_sheet',
    description: 'Record the vetting call: contact position, financial decision authority, viability, new commercial projects, current provider. This is the qualification record — and training data for the learning loop. Optionally verdict accept/reject.',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string' },
      answers: { type: 'object', description: `Keys: ${CALL_SHEET_FORM.map((f) => f.key).join(', ')}` },
      decision: { type: 'string', enum: ['accept', 'reject'] },
      reason: { type: 'string' },
    }, required: ['company_id', 'answers'] },
  },
  {
    name: 'log_outcome',
    description: 'THE FEEDBACK LOOP. Log where a lead stands: claimed → called → meeting → converted → lost (give the reason) → retained_90d → retained_12m. Every step logged teaches LeadFinder which leads were worth finding — after ~50 decided outcomes it proposes reweighted criteria (a human approves before anything changes).',
    inputSchema: { type: 'object', properties: {
      company_id: { type: 'string' },
      stage: { type: 'string', enum: OUTCOME_STAGES },
      reason: { type: 'string', description: 'Required in spirit for "lost" — why' },
      note: { type: 'string' },
    }, required: ['company_id', 'stage'] },
  },
  {
    name: 'get_criteria',
    description: 'The active scoring criteria for companies — components, weights, thresholds, version. What "ranked by fit" actually means, in the open.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_learning_status',
    description: 'How close the learning loop is to proposing new weights: decided outcomes so far vs needed, and the current proposal when there is one (propose-only — a human activates it).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'import_client_list',
    description: 'WHEN A USER DROPS THEIR CLIENT LIST INTO THE CHAT (spreadsheet, CSV, or pasted names): read it, extract one row per client, and send the rows here. The moment they land, matching companies are suppressed from the call list — the response tells you how many prospects were removed as existing clients ("N imported, M suppressed"), which is the number to report back. Each row: name (required); reg_no, cidb_reg_no, vat_no, email, phone, province, package, status (all optional but each one makes the matching more reliable). Re-sending is safe — rows merge by company name. Max 500 rows per call; for bigger lists send several calls and say which chunk you\'re on.',
    inputSchema: { type: 'object', properties: {
      rows: { type: 'array', description: 'One object per client company', items: { type: 'object' } },
      filename: { type: 'string', description: 'The original file\'s name, for the record' },
      note: { type: 'string', description: 'e.g. "chunk 2 of 3", or where the list came from' },
    }, required: ['rows'] },
  },
  {
    name: 'save_document',
    description: 'WHEN A USER DROPS ANY OTHER DOCUMENT INTO THE CHAT for LeadFinder — their qualification criteria, call sheet, tender-briefing site list, a leads or contacts spreadsheet — read it and relay the full content here as text. It is stored versioned in the team\'s document library (prior versions kept, nothing edited) and becomes readable by every future conversation via read_document. For client lists use import_client_list instead — that one also activates suppression. doc_type: one of criteria | call_sheet | briefing_portals | churn_reasons | other.',
    inputSchema: { type: 'object', properties: {
      doc_type: { type: 'string', enum: ['criteria', 'call_sheet', 'briefing_portals', 'churn_reasons', 'other'] },
      filename: { type: 'string' },
      content: { type: 'string', description: 'The document\'s full text content (tables as CSV or markdown)' },
      note: { type: 'string' },
    }, required: ['doc_type', 'content'] },
  },
  {
    name: 'list_documents',
    description: 'The documents the team has uploaded to LeadFinder — criteria sheets, call sheets, client lists, tender-briefing site lists, spreadsheets of leads or contacts, anything sent in via the app\'s Documents tab. List them, then read_document for content. (Client lists are also auto-imported for existing-client suppression the moment they arrive.) When a user asks a question their own uploaded material could answer — "what are our criteria?", "is X on the client list?", "which sites did we say we search?" — check here.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_document',
    description: 'Read the extracted text of one uploaded document, for answers grounded in the client\'s own material. If has_text is false the file stored fine but no text could be pulled out (a scan or image) — say so rather than guessing its contents.',
    inputSchema: { type: 'object', properties: {
      document_id: { type: 'string', description: 'UUID from list_documents' },
    }, required: ['document_id'] },
  },
  {
    name: 'run_sweep',
    description: 'Pull the sources now instead of waiting for tonight: harvests new company signals from the eTenders awards feed, refreshes client suppression, rescores. Slow (the feed takes minutes) — prefer the overnight run.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool implementations (every one scoped by newsroomId from the key) ───────
async function toolSearchLeads(newsroomId, args) {
  const clauses = ['c.newsroom_id = $1', 'c.suppressed_as_existing = false'];
  const params = [newsroomId];
  if (args.grade_band) { params.push(args.grade_band); clauses.push(`c.grade_band = $${params.length}`); }
  if (args.band)       { params.push(args.band);       clauses.push(`c.band = $${params.length}`); }
  if (args.q)          { params.push(`%${String(args.q).toLowerCase()}%`); clauses.push(`c.normalised_name LIKE $${params.length}`); }
  if (args.unclaimed_only) clauses.push('c.claimed_at IS NULL');
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.cidb_grading, c.grade_band, c.province, c.total_score, c.band,
            c.routing_reason, c.current_stage, c.claimed_by_name, c.last_signal_at,
            (c.enriched_at IS NOT NULL) AS enriched, c.enrichment->>'website' AS website,
            (SELECT COUNT(*) FROM leadfinder.company_signals s WHERE s.company_id = c.id)::int AS signals
       FROM leadfinder.companies c WHERE ${clauses.join(' AND ')}
      ORDER BY c.total_score DESC NULLS LAST, c.last_signal_at DESC NULLS LAST LIMIT ${limit}`, params);
  const { rows: [k] } = await pool.query(
    `SELECT COUNT(*)::int AS found, COUNT(*) FILTER (WHERE suppressed_as_existing)::int AS suppressed
       FROM leadfinder.companies WHERE newsroom_id = $1`, [newsroomId]);
  return { counters: { found: k.found, already_clients: k.suppressed, returned: rows.length }, leads: rows };
}

async function toolGetCompany(newsroomId, args) {
  let row;
  if (args.company_id) {
    ({ rows: [row] } = await pool.query(
      `SELECT * FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`, [args.company_id, newsroomId]));
  } else if (args.name) {
    ({ rows: [row] } = await pool.query(
      `SELECT * FROM leadfinder.companies WHERE newsroom_id = $1 AND normalised_name LIKE $2
        ORDER BY total_score DESC NULLS LAST LIMIT 1`,
      [newsroomId, `%${String(args.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}%`]));
  }
  if (!row) throw { code: -32602, message: 'Company not found — search_leads first, or check the name.' };
  const [signals, reviews, outcomes] = await Promise.all([
    pool.query(`SELECT kind, value, occurred_at, evidence_note FROM leadfinder.company_signals
                 WHERE company_id = $1 ORDER BY occurred_at DESC NULLS LAST LIMIT 30`, [row.id]),
    pool.query(`SELECT answers, decision, reason, decided_at FROM leadfinder.company_reviews
                 WHERE company_id = $1 ORDER BY decided_at DESC LIMIT 5`, [row.id]),
    pool.query(`SELECT stage, reason, note, recorded_at FROM leadfinder.company_outcomes
                 WHERE company_id = $1 ORDER BY recorded_at ASC`, [row.id]),
  ]);
  const { fields, ...pub } = row;
  return { ...pub, scoring_inputs: fields, signals: signals.rows, call_sheets: reviews.rows, outcome_history: outcomes.rows };
}

async function toolClaim(newsroomId, args) {
  const name = String(args.claimed_by_name || '').trim().slice(0, 120);
  if (!name) throw { code: -32602, message: 'claimed_by_name is required — a claim needs an owner.' };
  const { rows } = await pool.query(
    `UPDATE leadfinder.companies
        SET claimed_by_name = $3, claimed_at = NOW(),
            current_stage = COALESCE(current_stage, 'claimed'), updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2 AND claimed_at IS NULL RETURNING id, name`, [args.company_id, newsroomId, name]);
  if (!rows.length) {
    const { rows: [c] } = await pool.query(
      `SELECT name, claimed_by_name FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`,
      [args.company_id, newsroomId]);
    if (!c) throw { code: -32602, message: 'Company not found.' };
    throw { code: -32000, message: `${c.name} is already claimed by ${c.claimed_by_name || 'a colleague'}.` };
  }
  await pool.query(
    `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, note)
     VALUES ($1,$2,'claimed',$3)`, [newsroomId, args.company_id, `claimed by ${name} via MCP`]);
  return { ok: true, claimed: rows[0].name, by: name };
}

async function toolLogCallSheet(newsroomId, args) {
  if (!args.answers || typeof args.answers !== 'object') throw { code: -32602, message: 'answers object is required.' };
  if (args.decision && !['accept', 'reject'].includes(args.decision)) throw { code: -32602, message: 'decision must be accept or reject.' };
  const { rows: [c] } = await pool.query(
    `SELECT id, current_stage FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`, [args.company_id, newsroomId]);
  if (!c) throw { code: -32602, message: 'Company not found.' };
  await pool.query(
    `INSERT INTO leadfinder.company_reviews (newsroom_id, company_id, answers, decision, reason)
     VALUES ($1,$2,$3::jsonb,$4,$5)`,
    [newsroomId, c.id, JSON.stringify(args.answers), args.decision || null, args.reason || null]);
  await pool.query(
    `UPDATE leadfinder.companies
        SET current_stage = CASE WHEN current_stage IS NULL OR current_stage = 'claimed' THEN 'called' ELSE current_stage END,
            status = CASE WHEN $3 = 'accept' THEN 'qualified' WHEN $3 = 'reject' THEN 'rejected' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`, [c.id, newsroomId, args.decision || null]);
  if (!c.current_stage || c.current_stage === 'claimed') {
    await pool.query(
      `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, note)
       SELECT $1, $2, 'called', 'via call sheet (MCP)'
        WHERE NOT EXISTS (SELECT 1 FROM leadfinder.company_outcomes WHERE company_id = $2 AND stage = 'called')`,
      [newsroomId, c.id]);
  }
  return { ok: true, recorded: Object.keys(args.answers).length + ' answers', decision: args.decision || 'none' };
}

async function toolLogOutcome(newsroomId, args) {
  if (!OUTCOME_STAGES.includes(args.stage)) throw { code: -32602, message: `stage must be one of: ${OUTCOME_STAGES.join(', ')}` };
  const { rows: [c] } = await pool.query(
    `SELECT id, name FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`, [args.company_id, newsroomId]);
  if (!c) throw { code: -32602, message: 'Company not found.' };
  await pool.query(
    `INSERT INTO leadfinder.company_outcomes (newsroom_id, company_id, stage, reason, note)
     VALUES ($1,$2,$3,$4,$5)`, [newsroomId, c.id, args.stage, args.reason || null, args.note || null]);
  await pool.query(
    `UPDATE leadfinder.companies SET current_stage = $3, updated_at = NOW() WHERE id = $1 AND newsroom_id = $2`,
    [c.id, newsroomId, args.stage]);
  const loop = await proposeCompanyReweight(newsroomId);
  return { ok: true, company: c.name, stage: args.stage,
           learning_loop: loop.ready ? 'Enough data — a reweight proposal is available (get_learning_status).' : loop.note };
}

async function toolGetCriteria(newsroomId) {
  const criteria = await getActiveCriteria(newsroomId, 'company');
  if (!criteria) return { note: 'No company criteria yet — the first sweep seeds a starter version.' };
  return criteria;
}

async function toolListDocuments(newsroomId) {
  const { rows } = await pool.query(
    `SELECT id, doc_type, version, filename, note, uploaded_at,
            (superseded_at IS NULL) AS current, (extracted_text IS NOT NULL) AS has_text
       FROM leadfinder.documents WHERE newsroom_id = $1 ORDER BY doc_type, version DESC`, [newsroomId]);
  return { documents: rows, note: rows.length ? undefined : 'Nothing uploaded yet — documents arrive via the app\'s Documents tab.' };
}

async function toolReadDocument(newsroomId, args) {
  const { rows: [d] } = await pool.query(
    `SELECT id, doc_type, version, filename, note, uploaded_at, superseded_at, extracted_text
       FROM leadfinder.documents WHERE id = $1 AND newsroom_id = $2`, [args.document_id, newsroomId]);
  if (!d) throw { code: -32602, message: 'Document not found — list_documents first.' };
  const text = d.extracted_text || null;
  const CAP = 30000;
  return {
    ...d,
    extracted_text: text ? text.slice(0, CAP) : null,
    truncated: !!(text && text.length > CAP),
    has_text: !!text,
    reading_note: text ? undefined : 'Stored, but no text could be extracted (likely a scan or image).',
  };
}

async function toolImportClientList(newsroomId, args) {
  const rows = Array.isArray(args.rows) ? args.rows : [];
  if (!rows.length) throw { code: -32602, message: 'rows[] is required — one object per client, name at minimum.' };
  if (rows.length > 500) throw { code: -32602, message: 'Max 500 rows per call — send the list in chunks and note which chunk this is.' };
  const doc = await storeDocumentText({
    newsroomId, docType: 'client_list',
    filename: args.filename || 'client-list-via-connector.json',
    text: JSON.stringify(rows, null, 1),
    note: args.note || 'Relayed through the connector from a file dropped in chat',
  });
  const result = await importClientRows(newsroomId, rows, doc.id);
  return {
    ...result, document_version: doc.version,
    message: `${result.imported} client(s) imported (${result.skipped} rows skipped for no name). ` +
             `${result.suppressed_now} prospect(s) newly suppressed from the call list as existing clients.`,
  };
}

async function toolSaveDocument(newsroomId, args) {
  const content = String(args.content || '');
  if (!content.trim()) throw { code: -32602, message: 'content is required — the document\'s full text.' };
  if (content.length > 200000) throw { code: -32602, message: 'Content over 200k characters — upload the file in the LeadFinder app\'s Documents tab instead.' };
  const doc = await storeDocumentText({
    newsroomId, docType: args.doc_type, filename: args.filename,
    text: content, note: args.note || 'Relayed through the connector from a file dropped in chat',
  });
  return { ...doc, message: `Stored as ${doc.doc_type} v${doc.version}${doc.supersedes ? ` (supersedes v${doc.supersedes}, history kept)` : ''}. Readable by the whole team via read_document.` };
}

const dispatch = {
  search_leads:        toolSearchLeads,
  import_client_list:  toolImportClientList,
  save_document:       toolSaveDocument,
  list_documents:      toolListDocuments,
  read_document:       toolReadDocument,
  get_company:         toolGetCompany,
  save_profile:        (nid, args) => saveProfile(args.company_id, nid, args.profile),
  enrich_company:      (nid, args) => enrichCompany(args.company_id, nid),
  claim_company:       toolClaim,
  log_call_sheet:      toolLogCallSheet,
  log_outcome:         toolLogOutcome,
  get_criteria:        toolGetCriteria,
  get_learning_status: (nid) => proposeCompanyReweight(nid),
  run_sweep:           (nid) => sweepCompaniesForTenant(nid),
};

// ── The endpoint ──────────────────────────────────────────────────────────────
const SERVER_INFO = { name: 'LeadFinder', version: '0.2.0' };

async function requireKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Authorization: Bearer <key> required. Keys are minted in LeadFinder (or ask your Be AI Ready consultant).' });
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { rows: [k] } = await pool.query(
      `SELECT id, newsroom_id FROM leadfinder.mcp_keys WHERE key_hash = $1 AND is_active = true`, [hash]);
    if (!k) return res.status(403).json({ error: 'Invalid or revoked key.' });
    pool.query(`UPDATE leadfinder.mcp_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]).catch(() => {});
    req.mcpKey = k;
    next();
  } catch (err) { console.error('[lf/mcp/auth]', err); res.status(500).json({ error: 'Auth check failed' }); }
}

// Key-in-URL auth for clients whose connector UI cannot send a header.
// Claude.ai (and ChatGPT) custom connectors offer only "no auth" or full
// OAuth — a 401 from us sends them hunting for an OAuth sign-in service that
// doesn't exist ("Couldn't register with …'s sign-in service"). So each key
// also works as a path: /mcp/k/<key>. Trade-off, stated plainly: the key
// rides in the URL, so it lands in our own Caddy access log and in the
// client's stored connector config — acceptable for a per-person, revocable,
// tenant-scoped key; revoke it and the URL dies. The proper fix is an MCP
// OAuth authorization server (dynamic client registration + PKCE) — one
// build, runtime-side, shared with the policy MCP. Until then, this.
async function requireKeyParam(req, res, next) {
  const token = String(req.params.key || '').trim();
  if (!token) return res.status(401).json({ error: 'No key in URL.' });
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { rows: [k] } = await pool.query(
      `SELECT id, newsroom_id FROM leadfinder.mcp_keys WHERE key_hash = $1 AND is_active = true`, [hash]);
    if (!k) return res.status(403).json({ error: 'Invalid or revoked key.' });
    pool.query(`UPDATE leadfinder.mcp_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]).catch(() => {});
    req.mcpKey = k;
    next();
  } catch (err) { console.error('[lf/mcp/auth]', err); res.status(500).json({ error: 'Auth check failed' }); }
}

export function mountMcp(app) {
  const router = Router();

  const sseHandler = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({
      jsonrpc: '2.0', method: 'server/info',
      params: { ...SERVER_INFO,
        description: 'LeadFinder — ranked construction-industry leads from public procurement data, the claim system, the call sheet, and the outcome ladder that teaches it. Tools: ' + TOOLS.map((t) => t.name).join(', '),
        capabilities: { tools: {} } },
    })}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(heartbeat));
  };

  const rpcHandler = async (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};
    if (jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (method === 'initialize') {
      return res.json({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    }
    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      const fn = dispatch[name];
      const newsroomId = req.mcpKey.newsroom_id;
      let ok = true;
      try {
        if (!fn) throw { code: -32601, message: `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}` };
        const result = await fn(newsroomId, args);
        return res.json({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          isError: false } });
      } catch (err) {
        ok = false;
        const isRpc = err.code !== undefined;
        return res.json({ jsonrpc: '2.0', id,
          error: isRpc ? { code: err.code, message: err.message } : { code: -32603, message: err.message || 'Internal error' } });
      } finally {
        // Usage is evidence (vision layer 4) — logged whatever the outcome.
        pool.query(
          `INSERT INTO leadfinder.mcp_usage (newsroom_id, key_id, tool, args, ok) VALUES ($1,$2,$3,$4::jsonb,$5)`,
          [newsroomId, req.mcpKey.id, String(name || 'unknown').slice(0, 60), JSON.stringify(args || {}), ok]
        ).catch(() => {});
      }
    }
    // MCP keep-alive: a ping request expects an empty result, not an error —
    // answering -32601 makes some clients mark the server unhealthy.
    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(204).send();
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  };

  // Header auth (API clients, Claude Code, anything that can send a header)…
  router.get('/', requireKey, sseHandler);
  router.post('/', requireKey, rpcHandler);
  // …and keyed-URL auth (claude.ai / ChatGPT connector UIs — see note above).
  router.get('/k/:key', requireKeyParam, sseHandler);
  router.post('/k/:key', requireKeyParam, rpcHandler);

  // Nothing under /mcp may ever fall through to the host app's SPA or login
  // redirect. Connector UIs probe OAuth discovery paths relative to the MCP
  // URL (/.well-known/oauth-* and friends); if those get a 200-HTML page or a
  // 302, the client believes a sign-in service exists and tries to register
  // against it — "Couldn't register with LeadFinder's sign-in service". A
  // clean 404 tells it plainly: there is no OAuth here.
  router.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/mcp', router);
}

export default mountMcp;
