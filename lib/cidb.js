// LeadFinder — CIDB Register of Contractors lookups (enrichment Tier 0).
//
// A JS port of the tracker's server/scripts/cidb-register.py (the working
// reference — its docstring carries the measured facts). The register is a
// Microsoft Power Pages portal whose page HTML contains ZERO contractor rows;
// the grid is filled by a JSON service the page calls. So this module parses
// the page shell only to DISCOVER the grid's contract, then talks to the
// service directly:
//
//   POST /_services/entity-grid-data.json/<view-guid>
//   header __RequestVerificationToken — must pair with the cookie set by
//          GET /_layout/tokenhtml, fetched on the SAME session (cookie jar)
//   body   { base64SecureConfiguration, sortExpression, search, page, ... }
//
// Gotchas ported verbatim from the Python:
//   * base64SecureConfiguration is NOT the plaintext data-view-layouts blob —
//     it is the encrypted Base64SecureConfiguration field INSIDE the decoded
//     layout JSON. Sending the plaintext one returns HTTP 500.
//   * search: a bare term is starts-with; *term* is contains. We always send
//     contains — feed names rarely match the register's legal name exactly.
//   * register names carry leading whitespace; flatten() trims.
//   * Dynamics OMITS null attributes (~1% of records have no `name`, only a
//     trading name) — company_name is the always-populated derived field.
//   * the 1.5s delay between requests is deliberate. Don't lower it.
//
// USAGE POLICY (LEADFINDER_NODE_PLAN.md §7⅞, L2B plan §8): per-company lookups
// ONLY — they mirror the client's existing manual workflow and are the
// defensible ask while Paul's bulk-licence question to CIDB stays open. Never
// bulk-mirror the register from this module. Capped per sweep, respectful
// delay, one list request per company.
//
// Matching is conservative: a single exact normalised-name match attaches; an
// ambiguous result goes to a POSSIBLE-MATCH state on the company row
// (cidb_lookup_status='possible' + cidb_candidates) for a person to resolve —
// never silently attached. What a confident match stores:
//   companies row — cidb_reg_no, cidb_grading (verbatim), cidb_grade +
//     grade_band (parsed), cidb_status, cidb_expiry, cidb_bbbee
//   company_signals kind 'cidb' — with the contractor's portal URL as evidence.
// The signal's external_id includes the expiry date on purpose: a renewal
// (new expiry) is a NEW signal — a renewing contractor is spending money.

import pool from './pool.js';
import { normaliseName, parseCidbGrading, gradeBand, recordSignal } from './companies.js';

const BASE = 'https://portal.cidb.org.za';
const PAGE = `${BASE}/RegisterOfContractors/`;
const DETAIL = `${BASE}/RegisterOfContractors/ContractorView/`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 60000;

// Tier 0 is free (no model call) but hits a third party: capped and delayed.
// CIDB_PER_SWEEP=0 disables the nightly tail; the floor on the delay is the
// Python's deliberate 1.5s — a bigger value is allowed, a smaller one is not.
const envCap = parseInt(process.env.CIDB_PER_SWEEP, 10);
const PER_SWEEP = Number.isFinite(envCap) ? envCap : 25;
const DELAY_MS = Math.max(1500, parseInt(process.env.CIDB_DELAY_MS, 10) || 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a minimal cookie jar — the token cookie must ride with the token header ──
function absorbCookies(jar, res) {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const line of lines) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(jar, url, { method = 'GET', body = null, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
        ...headers,
      },
    });
    absorbCookies(jar, res);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
    return res;
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `CIDB request timed out (${new URL(url).pathname})` : err.message);
  } finally { clearTimeout(timer); }
}

const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ── discovery: parse the page shell for the grid's contract ──────────────────
function parseShell(html) {
  const tags = html.match(/<div[^>]*\bdata-get-url\b[^>]*>/gi) || [];
  const tag = tags.find((t) => /entity-grid/i.test(t));
  if (!tag) throw new Error('CIDB portal: entity-grid element not found — the portal markup changed.');
  const attr = (name) => {
    const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
    return m ? decodeEntities(m[1]) : null;
  };
  const getUrl = attr('data-get-url');
  const layoutsB64 = attr('data-view-layouts');
  if (!getUrl || !layoutsB64) throw new Error('CIDB portal: grid contract attributes missing from the shell page.');
  const layouts = JSON.parse(Buffer.from(layoutsB64, 'base64').toString('utf8'));
  return { getUrl: BASE + getUrl, layouts };
}

function parseToken(html) {
  const input = (html.match(/<input[^>]*__RequestVerificationToken[^>]*>/i) || [])[0];
  const m = input && input.match(/value\s*=\s*"([^"]+)"/i);
  if (!m) throw new Error('CIDB portal: antiforgery token not found in /_layout/tokenhtml.');
  return m[1];
}

// One "session" = shell discovery + antiforgery token on one cookie jar,
// reused across a whole sweep (two setup requests, then one per company).
// Layout 0 = "All Contractors" on purpose: an EXPIRED registration is a
// finding here (the renewal conversation), not noise to filter out.
export async function openCidbSession() {
  const jar = new Map();
  const shell = parseShell(await (await request(jar, PAGE)).text());
  const layout = shell.layouts[0];
  if (!layout?.Base64SecureConfiguration) {
    throw new Error('CIDB portal: layout carries no Base64SecureConfiguration — refusing to send the plaintext blob (it returns HTTP 500).');
  }
  const token = parseToken(await (await request(jar, `${BASE}/_layout/tokenhtml`)).text());
  return { jar, getUrl: shell.getUrl, layout, token };
}

async function fetchGrid(session, { search = '', page = 1, pageSize = 50 } = {}) {
  const body = {
    base64SecureConfiguration: session.layout.Base64SecureConfiguration,
    sortExpression: session.layout.SortExpression || 'name ASC',
    search,
    page,
    pageSize,
    pagingCookie: '',
    filter: null,
    metaFilter: null,
    nlSearchFilter: '',
    timezoneOffset: -120,   // SAST
    customParameters: [],
  };
  const res = await request(session.jar, session.getUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      __RequestVerificationToken: session.token,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: PAGE,
    },
  });
  return res.json();
}

// ── record flattening + field mapping ────────────────────────────────────────
// Dynamics returns {Attributes:[{Name,Value,DisplayValue}, …]} per record.
// `row` is display-preferred (what a human sees); `values` keeps the raw Value
// per attribute because Dynamics dates arrive as "/Date(ms)/" there — the only
// unambiguous form the list view offers.
function flatten(record) {
  const row = {}; const values = {};
  for (const a of record?.Attributes || []) {
    let v = a.DisplayValue;
    if (v === null || v === undefined || v === '') v = a.Value;
    if (v && typeof v === 'object') v = v.Name ?? v.Value ?? JSON.stringify(v);
    if (typeof v === 'string') v = v.trim();       // register names carry leading spaces
    row[a.Name] = v;
    values[a.Name] = a.Value;
  }
  row.company_name = row.name || row.nv_tradingas || '';
  return { row, values };
}

// The view's Columns metadata maps display names ("Grading Designation") to
// logical names (nv_…), so we don't hardcode logical names we might have
// wrong — and a portal rename degrades to null fields, never wrong fields.
function fieldPicker(columns, row) {
  const cols = Array.isArray(columns) ? columns : [];
  return (...patterns) => {
    for (const re of patterns) {
      const hit = cols.find((c) => re.test(String(c.Name || '')) || re.test(String(c.LogicalName || '')));
      if (hit && row[hit.LogicalName] != null && row[hit.LogicalName] !== '') {
        return { value: row[hit.LogicalName], key: hit.LogicalName };
      }
    }
    for (const re of patterns) {
      const k = Object.keys(row).find((key) => re.test(key));
      if (k && row[k] != null && row[k] !== '') return { value: row[k], key: k };
    }
    return { value: null, key: null };
  };
}

// Expiry to ISO yyyy-mm-dd. "/Date(ms)/" is trusted outright; a textual date
// is trusted only when unambiguous — an ambiguous dd/mm vs mm/dd stays null
// in the typed column (the verbatim string is still kept in the raw payload).
function parseCidbDate(rawValue, display) {
  const ms = typeof rawValue === 'string' && rawValue.match(/\/Date\((-?\d+)/);
  if (ms) {
    const d = new Date(parseInt(ms[1], 10));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const pad = (n) => String(n).padStart(2, '0');
  for (const v of [rawValue, display]) {
    if (typeof v !== 'string') continue;
    let m = v.match(/^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = v.match(/^\s*(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) {
      const a = +m[1]; const b = +m[2];
      if (a > 12 && b <= 12) return `${m[3]}-${pad(b)}-${pad(a)}`;
      if (b > 12 && a <= 12) return `${m[3]}-${pad(a)}-${pad(b)}`;
      return null;
    }
  }
  return null;
}

function extractCandidate(record, columns) {
  const { row, values } = flatten(record);
  const pick = fieldPicker(columns, row);
  const crs = pick(/crs/i);
  const grading = pick(/grad/i);
  const status = pick(/registration\s*status/i, /^statuscode$/i, /^status$/i, /statecode/i);
  const expiry = pick(/expir/i);
  const bbbee = pick(/b.?bbee/i);
  const province = pick(/province/i);
  const emerging = pick(/emerging/i);
  const accountid = row.accountid || null;
  return {
    crs_number: crs.value != null ? String(crs.value) : null,
    name: row.company_name || null,
    trading_as: row.nv_tradingas || null,
    grading: grading.value != null ? String(grading.value) : null,
    status: status.value != null ? String(status.value) : null,
    expiry: expiry.value != null ? String(expiry.value) : null,
    expiry_iso: parseCidbDate(expiry.key ? values[expiry.key] : null, expiry.value),
    bbbee: bbbee.value != null ? String(bbbee.value) : null,
    province: province.value != null ? String(province.value) : null,
    potentially_emerging: emerging.value != null ? String(emerging.value) : null,
    accountid,
    url: accountid ? `${DETAIL}?id=${encodeURIComponent(accountid)}` : PAGE,
  };
}

// ── search term + match classification ───────────────────────────────────────
// The term is the feed name minus legal-form noise, WITHOUT normaliseName's
// punctuation rewrite — the register stores "K&L CIVILS (PTY) LTD" and a
// contains-search for "k and l civils" would miss it.
export function cidbSearchTerm(name) {
  let s = String(name || '').split(/\s+t\/a\s+/i)[0];
  s = s.replace(/\((?:pty|proprietary)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ');
  const legal = /^(pty|ltd|limited|proprietary|cc|inc|incorporated)\.?$/i;
  while (tokens.length > 1 && legal.test(tokens[tokens.length - 1].replace(/[(),.]/g, ''))) tokens.pop();
  return tokens.join(' ').trim();
}

// Confident = exactly one register record whose normalised name (or trading
// name) equals the company's dedupe key — or whose CRS number equals a CRS we
// already hold. Everything else that found rows is a possible match for a
// person to resolve. Never guess.
function classify(company, candidates, itemCount) {
  const target = company.normalised_name;
  if (company.cidb_reg_no) {
    const byCrs = candidates.filter((c) => c.crs_number && c.crs_number === String(company.cidb_reg_no));
    if (byCrs.length === 1) return { verdict: 'matched', match: byCrs[0], note: 'matched on the CRS number already held' };
  }
  const exact = candidates.filter((c) =>
    (c.name && normaliseName(c.name) === target)
    || (c.trading_as && normaliseName(c.trading_as) === target));

  if (exact.length === 1) {
    // A name-exact record contradicting a CRS we already hold is NOT confident.
    if (company.cidb_reg_no && exact[0].crs_number && exact[0].crs_number !== String(company.cidb_reg_no)) {
      return { verdict: 'possible', candidates: exact, note: `exact name match carries CRS ${exact[0].crs_number} but we already hold ${company.cidb_reg_no}` };
    }
    return { verdict: 'matched', match: exact[0] };
  }
  if (exact.length > 1) {
    const crsSet = new Set(exact.map((c) => c.crs_number).filter(Boolean));
    if (crsSet.size === 1) return { verdict: 'matched', match: exact[0], note: `${exact.length} register rows share CRS ${[...crsSet][0]}` };
    const active = exact.filter((c) => /active/i.test(c.status || ''));
    if (active.length === 1) return { verdict: 'matched', match: active[0], note: `one Active record among ${exact.length} exact-name register records` };
    return { verdict: 'possible', candidates: exact.slice(0, 5), note: `${exact.length} exact-name register records with different CRS numbers` };
  }
  if (candidates.length > 0 && itemCount <= 10) {
    return { verdict: 'possible', candidates: candidates.slice(0, 5), note: `no exact name match; ${itemCount} register row(s) contain the name` };
  }
  if (candidates.length > 0) {
    return { verdict: 'none', note: `${itemCount} register rows contain this name — too generic to attach` };
  }
  return { verdict: 'none', note: 'no register rows contain this name' };
}

// ── writes ───────────────────────────────────────────────────────────────────
// Confident match: the register overwrites its OWN fields (a refresh must see
// a grading upgrade or a status change), fills blanks elsewhere (reg no,
// province — the fill-nulls policy of companies.js), and records the signal.
async function attachMatch(company, m, { attachedBy = 'auto-name-match', note = null } = {}) {
  const grade = parseCidbGrading(m.grading);
  await pool.query(
    `UPDATE leadfinder.companies
        SET cidb_reg_no  = COALESCE(cidb_reg_no, $3),
            cidb_grading = $4,
            cidb_grade   = COALESCE($5, cidb_grade),
            grade_band   = COALESCE($6, grade_band),
            province     = COALESCE(province, $7),
            cidb_status  = $8,
            cidb_expiry  = $9,
            cidb_bbbee   = $10,
            cidb_checked_at = NOW(), cidb_lookup_status = 'matched', cidb_candidates = NULL,
            updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`,
    [company.id, company.newsroom_id, m.crs_number, m.grading, grade, gradeBand(grade),
     m.province, m.status, m.expiry_iso, m.bbbee]
  );
  const evidenceNote = [
    `CIDB ${m.grading || 'registered — no grading stated'}`,
    m.status ? `status ${m.status}` : null,
    (m.expiry_iso || m.expiry) ? `expires ${m.expiry_iso || m.expiry}` : null,
    m.bbbee ? `B-BBEE ${m.bbbee}` : null,
  ].filter(Boolean).join(' · ') + ` — ${m.url}`;
  // external_id carries the expiry so a RENEWAL (new expiry on refresh) is a
  // new signal: a renewing contractor is spending money right now.
  const { inserted } = await recordSignal(company.id, company.newsroom_id, {
    kind: 'cidb',
    externalId: m.crs_number ? `crs:${m.crs_number}:${m.expiry_iso || 'unknown'}` : `name:${company.normalised_name}`,
    evidenceNote,
    raw: { ...m, source: 'cidb-register', attached_by: attachedBy, match_note: note },
  });
  return { attached: true, signal_new: inserted, crs_number: m.crs_number, grading: m.grading, grade, grade_band: gradeBand(grade), status: m.status, expiry: m.expiry_iso || m.expiry, bbbee: m.bbbee, url: m.url };
}

async function markLookup(company, status, payload) {
  await pool.query(
    `UPDATE leadfinder.companies
        SET cidb_checked_at = NOW(), cidb_lookup_status = $3, cidb_candidates = $4::jsonb, updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`,
    [company.id, company.newsroom_id, status, payload ? JSON.stringify(payload) : null]
  );
}

// One company, one list request. Returns {verdict, ...detail}.
export async function lookupCompany(session, company) {
  const term = cidbSearchTerm(company.name);
  if (term.replace(/[^a-z0-9]/gi, '').length < 4) {
    const note = `name too short/generic for a register search ("${term}")`;
    await markLookup(company, 'none', { checked_at: new Date().toISOString(), search_term: term, note });
    return { verdict: 'none', note };
  }
  const data = await fetchGrid(session, { search: `*${term}*`, pageSize: 50 });
  const itemCount = Number(data?.ItemCount) || (data?.Records?.length ?? 0);
  const candidates = (Array.isArray(data?.Records) ? data.Records : [])
    .map((r) => extractCandidate(r, session.layout.Columns));
  const c = classify(company, candidates, itemCount);

  if (c.verdict === 'matched') {
    const detail = await attachMatch(company, c.match, { note: c.note || null });
    return { verdict: 'matched', note: c.note || null, ...detail };
  }
  const payload = {
    checked_at: new Date().toISOString(),
    search_term: term,
    item_count: itemCount,
    note: c.note,
    ...(c.verdict === 'possible' ? { candidates: c.candidates } : {}),
  };
  await markLookup(company, c.verdict, payload);
  return { verdict: c.verdict, note: c.note, candidates: c.candidates || [] };
}

// ── the sweep tail (Tier 0) ──────────────────────────────────────────────────
// Companies missing a grading, never checked, not already the client's —
// call-worthiest first (the same priority logic as the Tier 2 queue), capped.
// Failure never kills a sweep; three consecutive errors end the walk honestly.
export async function cidbSweepForTenant(newsroomId, cap = PER_SWEEP) {
  const out = { attempted: 0, matched: 0, possible: 0, none: 0, notes: [] };
  if (!cap || cap < 1) return out;

  const { rows } = await pool.query(
    `SELECT id, newsroom_id, name, normalised_name, cidb_reg_no
       FROM leadfinder.companies
      WHERE newsroom_id = $1 AND suppressed_as_existing = false
        AND cidb_grading IS NULL AND cidb_checked_at IS NULL
      ORDER BY (claimed_at IS NOT NULL) DESC, (band = 'green') DESC,
               total_score DESC NULLS LAST, last_signal_at DESC NULLS LAST
      LIMIT $2`,
    [newsroomId, cap]
  );
  if (!rows.length) return out;

  let session;
  try { session = await openCidbSession(); }
  catch (e) { out.notes.push(`CIDB portal unreachable: ${e.message}`); return out; }

  let consecutiveErrors = 0;
  for (const company of rows) {
    out.attempted++;
    try {
      let r;
      try {
        r = await lookupCompany(session, company);
      } catch {
        // The token/cookie pair can age out mid-run — re-establish once.
        await sleep(DELAY_MS);
        session = await openCidbSession();
        r = await lookupCompany(session, company);
      }
      out[r.verdict] = (out[r.verdict] || 0) + 1;
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      out.notes.push(`CIDB lookup "${company.name}": ${e.message}`);
      if (consecutiveErrors >= 3) {
        out.notes.push(`CIDB sweep stopped after ${consecutiveErrors} consecutive errors — remaining companies stay queued for the next sweep.`);
        break;
      }
    }
    await sleep(DELAY_MS);   // the Python's deliberate politeness, kept
  }
  return out;
}

// ── on-demand lookup + human resolution of the possible-match state ─────────
// The route path. Unlike the nightly (grading-missing rows only), on demand a
// MATCHED company may be re-looked-up — that is the renewal check.
export async function cidbLookupById(companyId, newsroomId) {
  const { rows: [company] } = await pool.query(
    `SELECT id, newsroom_id, name, normalised_name, cidb_reg_no
       FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`,
    [companyId, newsroomId]
  );
  if (!company) throw new Error('Company not found');
  const session = await openCidbSession();
  return lookupCompany(session, company);
}

// A person picks one stored candidate (by CRS number) — that attaches it, and
// the raw payload names who resolved it. Or dismisses the queue entirely.
export async function resolveCidbCandidate(companyId, newsroomId, { crsNumber = null, dismiss = false, resolvedBy = 'unknown' } = {}) {
  const { rows: [company] } = await pool.query(
    `SELECT id, newsroom_id, name, normalised_name, cidb_reg_no, cidb_candidates, cidb_lookup_status
       FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`,
    [companyId, newsroomId]
  );
  if (!company) throw new Error('Company not found');

  if (dismiss) {
    const payload = { ...(company.cidb_candidates || {}), dismissed_at: new Date().toISOString(), dismissed_by: resolvedBy };
    await markLookup(company, 'none', payload);
    return { dismissed: true };
  }
  const list = company.cidb_candidates?.candidates || [];
  const match = list.find((c) => c && String(c.crs_number) === String(crsNumber));
  if (!match) throw new Error(`No stored candidate with CRS number ${crsNumber} — nothing was attached.`);
  return attachMatch(company, match, { attachedBy: resolvedBy, note: 'resolved from the possible-match queue by a person' });
}
