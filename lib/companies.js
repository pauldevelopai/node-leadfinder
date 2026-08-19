// LeadFinder — the company entity (plan v2: the company IS the lead).
//
// A tender is a signal about a company. This module owns everything on the
// company side of that line: name normalisation (the dedupe key), the CIDB
// grade parse and territory banding, signal accumulation, deterministic
// scoring through the SAME engine tenders use, suppression against the
// client's own book (cms_accounts), and the client-list import.
//
// The design rules carry over unchanged:
//   * scoring is arithmetic — no model call anywhere in this file
//   * suppression is visible, never a silent merge — a suppressed company is
//     kept and counted ("31 already yours" is the headline number)
//   * starter criteria are honest guesses derived from the two 27 July calls,
//     clearly labelled; the client's real numbers replace them as a new version

import pool from './pool.js';
import { scoreTender } from './scoring.js';
import { ensureStarterCriteria, markSourceFetch } from './pipeline.js';
import { fetchCompanySignals } from './fetch.js';

// ── name normalisation — the dedupe key ─────────────────────────────────────
// Lowercase, punctuation → space, strip trailing legal-form tokens. Conservative
// on purpose: a false suppression hides a real lead, a missed dedupe only costs
// a duplicate row. "K&L Civils (Pty) Ltd" → "k and l civils".
const LEGAL_SUFFIXES = new Set(['pty', 'ltd', 'limited', 'proprietary', 'cc', 'inc', 'incorporated']);

export function normaliseName(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// ── CIDB grading parse + territory banding ──────────────────────────────────
// Real grading strings look like "CIDB 5CE", "PE 1CE, 1GB", "9ME", "grade 3".
// A company can hold several class gradings — the MAX level is what sizes them
// (Tegan: "that grading tells us how big of a company they are").
export function parseCidbGrading(s) {
  if (!s) return null;
  const str = String(s);
  const grades = [];
  for (const m of str.matchAll(/\b([1-9])\s*[A-Z]{2}\b/gi)) grades.push(parseInt(m[1], 10));
  const g = str.match(/\bgrade\s*([1-9])\b/i);
  if (g) grades.push(parseInt(g[1], 10));
  if (!grades.length) {
    const lone = str.match(/\b([1-9])\b/);
    if (lone) grades.push(parseInt(lone[1], 10));
  }
  return grades.length ? Math.max(...grades) : null;
}

// The territory split from the Tegan call: she and Connie take grade 6 and up,
// internal sales takes the 1s, the other AEs take everything between.
export function gradeBand(grade) {
  if (grade == null) return null;
  if (grade >= 6) return '6+';
  if (grade === 1) return '1';
  return '2-5';
}

// ── starter company criteria — SEED DATA, honestly labelled ─────────────────
// Derived from the two 27 July calls, not invented: active public bidding is
// the intent signal (Karen prospects around tender briefings), recency matters,
// award value proxies spend capacity (cash flow was named the churn driver),
// CIDB presence is the qualifier Tegan starts from, and a company nobody can
// contact isn't a lead. Every field is precomputed by computeCompanyFields, so
// the existing evaluators cover it — no new rule types needed.
// The client's real thresholds replace this as a new version when they land.
export const STARTER_COMPANY_CRITERIA = {
  thresholds: { green_min: 70, red_max: 35, hard_rules: [] },
  weights: [
    { component: 'activity_recent', weight: 2.5, source: 'prior',
      rule: { type: 'range', field: 'signal_count_180d', ideal_min: 2, ideal_max: Number.MAX_SAFE_INTEGER, hard_min: 0, missing_score: 0 } },
    { component: 'signal_recency', weight: 2.0, source: 'prior',
      rule: { type: 'range', field: 'days_since_last_signal', ideal_min: 0, ideal_max: 60, hard_max: 365, missing_score: 0.2 } },
    { component: 'award_value_fit', weight: 1.5, source: 'prior',
      rule: { type: 'range', field: 'award_value_180d', ideal_min: 100000, ideal_max: 20000000, hard_min: 0, hard_max: 100000000, missing_score: 0.4 } },
    { component: 'cidb_known', weight: 1.0, source: 'prior',
      rule: { type: 'range', field: 'has_cidb', ideal_min: 1, ideal_max: 1, hard_min: 0, missing_score: 0 } },
    { component: 'contactable', weight: 1.5, source: 'prior',
      rule: { type: 'range', field: 'has_contact', ideal_min: 1, ideal_max: 1, hard_min: 0, missing_score: 0 } },
  ],
};

export function ensureCompanyCriteria(newsroomId, createdBy = null) {
  return ensureStarterCriteria(newsroomId, createdBy, {
    entity: 'company',
    starter: STARTER_COMPANY_CRITERIA,
    notes: 'Starter company criteria (auto-seeded from the 27 Jul calls) — replaced by the client’s real thresholds when they land',
  });
}

// ── the call sheet, as a form definition ─────────────────────────────────────
// v1 is reconstructed from Karen's own description of her scoring sheet on the
// 27 July call — position, financial authority, viability, new commercial
// projects — plus the competitor question her call surfaced. Her verbatim sheet
// (doc_type 'call_sheet' in the document intake) supersedes this when it lands;
// like the document catalogue, the form lives in code so that swap is a diff.
export const CALL_SHEET_FORM = [
  { key: 'contact_name',             label: 'Who did you speak to?',                          type: 'text' },
  { key: 'contact_position',         label: 'Their position in the company',                  type: 'text' },
  { key: 'financial_decision_maker', label: 'Can they make financial decisions?',             type: 'yesno' },
  { key: 'company_activity',         label: 'What does the company do?',                      type: 'text' },
  { key: 'viable',                   label: 'Is the company viable for the service?',         type: 'yesno' },
  { key: 'new_commercial_projects',  label: 'Involved in new commercial projects?',           type: 'yesno' },
  { key: 'current_provider',         label: 'Already using a similar service? Which one?',    type: 'text' },
  { key: 'notes',                    label: 'Notes',                                          type: 'textarea' },
];

// ── upsert + signals ─────────────────────────────────────────────────────────
// Fill-nulls merge: a value we already hold always wins; a new observation only
// fills blanks. Contacts likewise — first contact list in stays until a human
// edits (crude, but it never destroys data; proper merge comes with real use).
export async function upsertCompany({ newsroomId, name, regNo = null, cidbRegNo = null, cidbGrading = null, province = null, domain = null, contacts = [] }) {
  const normalised = normaliseName(name);
  if (!normalised) return null;
  const grade = parseCidbGrading(cidbGrading);
  const { rows: [c] } = await pool.query(
    `INSERT INTO leadfinder.companies
       (newsroom_id, name, normalised_name, reg_no, cidb_reg_no, cidb_grading, cidb_grade, grade_band, province, domain, contacts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (newsroom_id, normalised_name) DO UPDATE SET
       reg_no       = COALESCE(leadfinder.companies.reg_no,       EXCLUDED.reg_no),
       cidb_reg_no  = COALESCE(leadfinder.companies.cidb_reg_no,  EXCLUDED.cidb_reg_no),
       cidb_grading = COALESCE(leadfinder.companies.cidb_grading, EXCLUDED.cidb_grading),
       cidb_grade   = COALESCE(leadfinder.companies.cidb_grade,   EXCLUDED.cidb_grade),
       grade_band   = COALESCE(leadfinder.companies.grade_band,   EXCLUDED.grade_band),
       province     = COALESCE(leadfinder.companies.province,     EXCLUDED.province),
       domain       = COALESCE(leadfinder.companies.domain,       EXCLUDED.domain),
       contacts     = CASE WHEN leadfinder.companies.contacts = '[]'::jsonb
                           THEN EXCLUDED.contacts ELSE leadfinder.companies.contacts END,
       updated_at   = NOW()
     RETURNING *, (xmax = 0) AS _created`,
    [newsroomId, String(name).trim(), normalised, regNo, cidbRegNo, cidbGrading, grade, gradeBand(grade), province, domain, JSON.stringify(contacts)]
  );
  return c;
}

// Idempotent: the (company_id, kind, external_id) unique constraint makes
// re-ingestion free, so an overlapping lookback window re-sees events cheaply.
export async function recordSignal(companyId, newsroomId, { kind, externalId = null, tenderId = null, sourceId = null, value = null, occurredAt = null, evidenceNote = null, raw = null }) {
  const { rows: [sig] } = await pool.query(
    `INSERT INTO leadfinder.company_signals
       (newsroom_id, company_id, kind, tender_id, source_id, external_id, value, occurred_at, evidence_note, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (company_id, kind, external_id) DO NOTHING
     RETURNING id`,
    [newsroomId, companyId, kind, tenderId, sourceId, externalId, value, occurredAt, evidenceNote, raw ? JSON.stringify(raw) : null]
  );
  if (sig) {
    await pool.query(
      `UPDATE leadfinder.companies
          SET last_signal_at = GREATEST(COALESCE(last_signal_at, 'epoch'::timestamptz), COALESCE($2, NOW())),
              updated_at = NOW()
        WHERE id = $1`,
      [companyId, occurredAt]
    );
  }
  return { inserted: !!sig };
}

// ── scoring ──────────────────────────────────────────────────────────────────
// Precompute the numeric fields the criteria read, then hand them to the SAME
// arithmetic engine that scores tenders. The fields are persisted on the row
// (companies.fields) so any score is auditable after the fact.
export async function computeCompanyFields(company) {
  const { rows: [s] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '180 days')::int              AS n180,
            SUM(value) FILTER (WHERE kind = 'award' AND occurred_at > NOW() - INTERVAL '180 days') AS v180,
            EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at))) / 86400.0                             AS days_since,
            -- Bid and (as far as the feed shows) did NOT win: tenderer signals
            -- whose ocid never produced an award signal for this company. The
            -- strongest prospect signal in the model — actively tendering,
            -- spending money on submissions, and losing, which is precisely the
            -- pain the client's product solves. "As far as the feed shows" is
            -- honest: an award published outside our window reduces this count
            -- the night it's seen.
            COUNT(*) FILTER (WHERE kind = 'tenderer'
              AND occurred_at > NOW() - INTERVAL '180 days'
              AND NOT EXISTS (
                SELECT 1 FROM leadfinder.company_signals a
                 WHERE a.company_id = company_signals.company_id AND a.kind = 'award'
                   AND a.raw->>'ocid' = company_signals.raw->>'ocid'))::int      AS lost180
       FROM leadfinder.company_signals WHERE company_id = $1`,
    [company.id]
  );
  const contacts = Array.isArray(company.contacts) ? company.contacts : [];
  return {
    signal_count_180d:      s?.n180 ?? 0,
    award_value_180d:       s?.v180 != null ? Number(s.v180) : null,
    days_since_last_signal: s?.days_since != null ? Math.round(Number(s.days_since)) : null,
    lost_bid_count_180d:    s?.lost180 ?? 0,
    has_cidb:               company.cidb_grade != null ? 1 : 0,
    has_contact:            contacts.length > 0 ? 1 : 0,
    cidb_grade:             company.cidb_grade,
  };
}

const bandToStatus = (band) => (band === 'green' ? 'qualified' : band === 'amber' ? 'needs_review' : 'rejected');

export async function scoreCompany(company, criteria) {
  const fields = await computeCompanyFields(company);
  const result = scoreTender(fields, criteria);
  // Suppression outranks the score: an existing client is never routed anywhere.
  const status = company.suppressed_as_existing ? 'suppressed' : bandToStatus(result.band);
  await pool.query(
    `UPDATE leadfinder.companies
        SET fields = $2::jsonb, component_scores = $3::jsonb, total_score = $4,
            criteria_version_id = $5, band = $6, routing_reason = $7, status = $8, updated_at = NOW()
      WHERE id = $1`,
    [company.id, JSON.stringify(fields), JSON.stringify(result.component_scores),
     result.total, criteria.version_id, result.band, result.routing_reason, status]
  );
  return { ...result, status };
}

// ── suppression against the client's book ───────────────────────────────────
// Exact matches only, on purpose: reg-no match is certain (1.0), normalised-name
// match is near-certain (0.9). Fuzzy "possible match" queues come later, with a
// human resolving them — never a silent merge. Returns how many got suppressed.
export async function suppressExistingClients(newsroomId) {
  const { rowCount: byReg } = await pool.query(
    `UPDATE leadfinder.companies c
        SET suppressed_as_existing = true, status = 'suppressed',
            cms_match_id = a.id, cms_match_confidence = 1.0, updated_at = NOW()
       FROM leadfinder.cms_accounts a
      WHERE c.newsroom_id = $1 AND a.newsroom_id = $1
        AND c.suppressed_as_existing = false
        AND c.reg_no IS NOT NULL AND a.reg_no IS NOT NULL AND c.reg_no = a.reg_no`,
    [newsroomId]
  );
  const { rowCount: byName } = await pool.query(
    `UPDATE leadfinder.companies c
        SET suppressed_as_existing = true, status = 'suppressed',
            cms_match_id = a.id, cms_match_confidence = 0.9, updated_at = NOW()
       FROM leadfinder.cms_accounts a
      WHERE c.newsroom_id = $1 AND a.newsroom_id = $1
        AND c.suppressed_as_existing = false
        AND c.normalised_name = a.normalised_name`,
    [newsroomId]
  );
  return byReg + byName;
}

// ── client-list import ───────────────────────────────────────────────────────
// Called when a doc_type 'client_list' document arrives. Reads CSV or Excel via
// the same optional xlsx dependency the document-processor uses. Column mapping
// is by header heuristics; if no company-name column is found the import fails
// honestly (the file itself is still stored by the document intake).
export async function importClientList({ newsroomId, documentId, filePath }) {
  let XLSX;
  try { XLSX = (await import('xlsx')).default; }
  catch { return { imported: 0, error: 'xlsx parser not installed on this box — file stored, not imported.' }; }

  let rows;
  try {
    const wb = XLSX.readFile(filePath, { raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  } catch (e) {
    return { imported: 0, error: `Could not read the file as a spreadsheet: ${e.message}` };
  }
  if (!rows?.length) return { imported: 0, error: 'The file has no data rows.' };

  const headers = Object.keys(rows[0]);
  const find = (...res) => headers.find((h) => res.some((re) => re.test(h.toLowerCase().trim()))) || null;
  const col = {
    name:     find(/^(company|client)[\s_-]*name$/, /^name$/, /company/, /client/),
    reg:      find(/reg/),
    cidb:     find(/cidb|crs/),
    vat:      find(/vat/),
    email:    find(/e-?mail/),
    phone:    find(/phone|tel|cell|mobile/),
    province: find(/province|region/),
    pkg:      find(/package|tier|product|plan/),
    status:   find(/status/),
  };
  if (!col.name) {
    return { imported: 0, error: `No company-name column found. Headers seen: ${headers.join(', ')}`, headers };
  }

  let imported = 0, skipped = 0;
  for (const r of rows) {
    const name = r[col.name] && String(r[col.name]).trim();
    const normalised = normaliseName(name);
    if (!normalised) { skipped++; continue; }
    await pool.query(
      `INSERT INTO leadfinder.cms_accounts
         (newsroom_id, name, normalised_name, reg_no, cidb_reg_no, vat_no, emails, phones, province, package, status, raw, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (newsroom_id, normalised_name) DO UPDATE SET
         reg_no = COALESCE(EXCLUDED.reg_no, leadfinder.cms_accounts.reg_no),
         cidb_reg_no = COALESCE(EXCLUDED.cidb_reg_no, leadfinder.cms_accounts.cidb_reg_no),
         vat_no = COALESCE(EXCLUDED.vat_no, leadfinder.cms_accounts.vat_no),
         package = COALESCE(EXCLUDED.package, leadfinder.cms_accounts.package),
         status = COALESCE(EXCLUDED.status, leadfinder.cms_accounts.status),
         raw = EXCLUDED.raw, source_document_id = EXCLUDED.source_document_id, imported_at = NOW()`,
      [newsroomId, name, normalised,
       col.reg ? r[col.reg] : null, col.cidb ? r[col.cidb] : null, col.vat ? r[col.vat] : null,
       JSON.stringify(col.email && r[col.email] ? [String(r[col.email])] : []),
       JSON.stringify(col.phone && r[col.phone] ? [String(r[col.phone])] : []),
       col.province ? r[col.province] : null, col.pkg ? r[col.pkg] : null,
       col.status ? r[col.status] : null, JSON.stringify(r), documentId]
    );
    imported++;
  }

  const suppressed = await suppressExistingClients(newsroomId);
  return { imported, skipped, suppressed_now: suppressed, columns: col };
}

// Structured client rows from the connector path (a rep drops their client
// spreadsheet into the AI chat; the AI extracts rows and relays them). Same
// upsert + suppression as the file import — the moment rows land, matching
// prospects vanish from the call list.
export async function importClientRows(newsroomId, rows, documentId = null) {
  let imported = 0, skipped = 0;
  for (const r of rows || []) {
    const name = r?.name && String(r.name).trim();
    const normalised = normaliseName(name);
    if (!normalised) { skipped++; continue; }
    await pool.query(
      `INSERT INTO leadfinder.cms_accounts
         (newsroom_id, name, normalised_name, reg_no, cidb_reg_no, vat_no, emails, phones, province, package, status, raw, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (newsroom_id, normalised_name) DO UPDATE SET
         reg_no = COALESCE(EXCLUDED.reg_no, leadfinder.cms_accounts.reg_no),
         cidb_reg_no = COALESCE(EXCLUDED.cidb_reg_no, leadfinder.cms_accounts.cidb_reg_no),
         vat_no = COALESCE(EXCLUDED.vat_no, leadfinder.cms_accounts.vat_no),
         package = COALESCE(EXCLUDED.package, leadfinder.cms_accounts.package),
         status = COALESCE(EXCLUDED.status, leadfinder.cms_accounts.status),
         raw = EXCLUDED.raw, source_document_id = EXCLUDED.source_document_id, imported_at = NOW()`,
      [newsroomId, name, normalised,
       r.reg_no || null, r.cidb_reg_no || null, r.vat_no || null,
       JSON.stringify(r.email ? [String(r.email)] : []),
       JSON.stringify(r.phone ? [String(r.phone)] : []),
       r.province || null, r.package || null, r.status || null,
       JSON.stringify(r), documentId]);
    imported++;
  }
  const suppressed = await suppressExistingClients(newsroomId);
  return { imported, skipped, suppressed_now: suppressed };
}

// ── the company sweep — the nightly's second half, and the manual run's ──────
// Fetch every awards-kind source, upsert companies + signals, refresh
// suppression, then (re)score every non-suppressed company for the tenant.
export async function sweepCompaniesForTenant(newsroomId) {
  const digest = { sources: 0, companies_new: 0, signals_new: 0, suppressed: 0, scored: 0, notes: [] };

  const { rows: sources } = await pool.query(
    `SELECT * FROM leadfinder.sources
      WHERE newsroom_id = $1 AND kind = 'etenders_awards' AND active = true AND approved = true`,
    [newsroomId]
  );

  for (const s of sources) {
    digest.sources++;
    const r = await fetchCompanySignals(s);
    if (r.note) digest.notes.push(`${s.name}: ${r.note}`);
    let seen = 0, isNew = 0;
    for (const item of r.companies || []) {
      seen++;
      const company = await upsertCompany({ newsroomId, ...item.company });
      if (!company) continue;
      if (company._created) digest.companies_new++;
      const { inserted } = await recordSignal(company.id, newsroomId, { ...item.signal, sourceId: s.id });
      if (inserted) { digest.signals_new++; isNew++; }
    }
    await markSourceFetch(s.id, { error: r.error, unwired: r.unwired });
    await pool.query(
      `UPDATE leadfinder.sources SET items_seen = items_seen + $2, items_new = items_new + $3, updated_at = NOW() WHERE id = $1`,
      [s.id, seen, isNew]
    );
  }

  digest.suppressed = await suppressExistingClients(newsroomId);

  const criteria = await ensureCompanyCriteria(newsroomId);
  const { rows: toScore } = await pool.query(
    `SELECT * FROM leadfinder.companies
      WHERE newsroom_id = $1 AND suppressed_as_existing = false
      ORDER BY last_signal_at DESC NULLS LAST LIMIT 500`,
    [newsroomId]
  );
  for (const c of toScore) {
    await scoreCompany(c, criteria);
    digest.scored++;
  }

  // Enrichment tail: research the best unenriched green companies (capped).
  // Lazy import avoids a boot-time SDK requirement; failure never kills a sweep.
  try {
    const { enrichTopUnenriched } = await import('./enrich.js');
    const e = await enrichTopUnenriched(newsroomId);
    digest.enriched = e.enriched;
    digest.notes.push(...e.notes);
  } catch (e) {
    digest.notes.push(`enrichment skipped: ${e.message}`);
  }

  return digest;
}
