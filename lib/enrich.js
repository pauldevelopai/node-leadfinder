// LeadFinder — company enrichment: the knowledge layer behind a lead.
//
// The public tender feed gives a company's name, province and bidding history —
// enough to RANK a lead, nowhere near enough to CALL one. This module fills the
// gap: a web-researched profile per company (website, offices, size, revenue or
// the honest reason it's unknown, who to approach, why they'd buy, why they'd
// resist), stored on the row so it accumulates — the database of knowledge the
// connector serves, built once per company, not re-searched per question.
//
// Vision rules applied: every profile is born verification_status 'ai_drafted'
// (a person flips it to human_verified, never the model); every claim carries
// its source URL; a fact that can't be found is null WITH a reason — never a
// guess. Costs one web-searching model call per company (~R1–2), so enrichment
// runs on the GREEN band first, capped per sweep, and on demand for any company.

import Anthropic from '@anthropic-ai/sdk';
import pool from './pool.js';

const MODEL = process.env.ENRICH_MODEL || process.env.MODEL || 'claude-sonnet-4-6';
// Server-side enrichment spends the OPERATOR's API credit, so the nightly tail
// is OFF unless deliberately enabled (ENRICH_PER_SWEEP=5 on the box). The free
// path is save_profile: the rep's own Claude/ChatGPT does the research on their
// subscription and stores the result here — the knowledge accrues either way.
const PER_SWEEP = parseInt(process.env.ENRICH_PER_SWEEP, 10) || 0;

let client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured.');
  if (!client || client.__key !== apiKey) {
    client = new Anthropic({ apiKey });
    client.__key = apiKey;
  }
  return client;
}

const SYSTEM = `You research South African companies for a sales team that sells
tender-intelligence subscriptions (Leads 2 Business — construction industry leads,
tender awards, project data). You are given a company seen bidding on public
tenders, with its bidding evidence. Research it on the web and return ONLY a JSON
object — no prose, no markdown fences — with exactly these keys:

{
  "website": string|null,            // their real site; null if none found
  "summary": string,                 // 2-3 sentences: what the company actually does
  "offices": string|null,            // where they're based/located; null + note if unknown
  "employees": string|null,          // headcount or range if stated anywhere; else null
  "employees_note": string|null,     // when null: why unknown (e.g. "no LinkedIn page or site headcount")
  "revenue": string|null,            // annual revenue if PUBLISHED anywhere; else null
  "revenue_note": string,            // when null, the honest reason — e.g. "private SA companies
                                     // are not required to publish financials; only CIDB grade and
                                     // tender award values proxy their size"
  "approach": [                      // who to talk to, best first
    { "who": string,                 // role, and name if found (e.g. "Thabo Nkosi — Director")
      "why": string,                 // why this person (decision authority, role fit)
      "contact": string|null }       // email/phone IF PUBLISHED; never guessed
  ],
  "why_l2b_fit": string,             // why THIS company would benefit from tender-intelligence —
                                     // tie it to their actual bidding pattern in the evidence
  "likely_objections": string,       // honest reasons they might resist (cash flow, already
                                     // subscribed to a competitor, too small, bids rarely...)
  "sources": [string]                // every URL you actually drew facts from
}

Hard rules: NEVER invent a fact, a name, a number, or a contact. A fact you could
not verify is null with a reason in the matching note field. Company names in SA
public data are often all-caps legal names — search variants. If you find nothing
at all about the company online, say so in "summary" (that itself is useful: a
company with no web presence needs a different pitch) and leave the rest null.`;

function evidenceText(company, signals) {
  const lines = (signals || []).slice(0, 10).map((s) =>
    `- ${s.evidence_note || s.kind}${s.occurred_at ? ` (${String(s.occurred_at).slice(0, 10)})` : ''}${s.value ? ` — value R${Number(s.value).toLocaleString('en-ZA')}` : ''}`);
  return [
    `Company: ${company.name}`,
    company.province ? `Province (from tender records): ${company.province}` : null,
    company.reg_no ? `Registration number: ${company.reg_no}` : null,
    company.cidb_grading ? `CIDB grading: ${company.cidb_grading}` : null,
    `Public bidding evidence:`, ...lines,
  ].filter(Boolean).join('\n');
}

// One researched profile, stored on the company row. Returns the profile.
export async function enrichCompany(companyId, newsroomId) {
  const { rows: [c] } = await pool.query(
    `SELECT * FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`, [companyId, newsroomId]);
  if (!c) throw new Error('Company not found');
  const { rows: signals } = await pool.query(
    `SELECT kind, value, occurred_at, evidence_note FROM leadfinder.company_signals
      WHERE company_id = $1 ORDER BY occurred_at DESC NULLS LAST LIMIT 10`, [companyId]);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    tools: [{
      type: 'web_search_20260209', name: 'web_search', max_uses: 4,
      user_location: { type: 'approximate', country: 'ZA' },
    }],
    messages: [{ role: 'user', content: evidenceText(c, signals) }],
  });

  // With server tools the response carries many blocks — the answer is the
  // concatenated text blocks, and the JSON object is what the prompt demanded.
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const jsonStr = text.replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}');
  let profile;
  try { profile = JSON.parse(jsonStr); }
  catch { throw new Error(`Enrichment came back unparseable: ${text.slice(0, 200)}`); }

  profile.enriched_at = new Date().toISOString();
  profile.verification_status = 'ai_drafted';   // a named person flips this, never the model
  profile.model = MODEL;

  await pool.query(
    `UPDATE leadfinder.companies
        SET enrichment = $3::jsonb, enriched_at = NOW(), enrichment_status = 'ai_drafted', updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`,
    [companyId, newsroomId, JSON.stringify(profile)]);

  // Published contacts join the company's contact list (provenance kept).
  const found = (profile.approach || []).filter((a) => a && a.contact)
    .map((a) => ({ name: a.who || null, email: /@/.test(a.contact) ? a.contact : null,
                   phone: /@/.test(a.contact) ? null : a.contact, source: 'enrichment' }));
  if (found.length) {
    await pool.query(
      `UPDATE leadfinder.companies
          SET contacts = CASE WHEN contacts = '[]'::jsonb THEN $3::jsonb ELSE contacts || $3::jsonb END
        WHERE id = $1 AND newsroom_id = $2`,
      [companyId, newsroomId, JSON.stringify(found)]);
  }

  return profile;
}

// Store a profile researched by a CONNECTOR CLIENT (the rep's own Claude or
// ChatGPT, on their subscription — free to the operator). Same shape, same
// storage, same rules as server-side enrichment; the stamp records who did the
// research. Vision shape: born ai_drafted, every claim expected to carry a
// source URL, jurisdiction recorded, a named human flips verification later.
const PROFILE_KEYS = ['website', 'summary', 'offices', 'employees', 'employees_note',
  'revenue', 'revenue_note', 'approach', 'why_l2b_fit', 'likely_objections', 'sources'];

export async function saveProfile(companyId, newsroomId, profile, researchedBy = 'client-ai') {
  const { rows: [c] } = await pool.query(
    `SELECT id FROM leadfinder.companies WHERE id = $1 AND newsroom_id = $2`, [companyId, newsroomId]);
  if (!c) throw new Error('Company not found');
  if (!profile || typeof profile !== 'object') throw new Error('profile object is required');
  if (!profile.summary || !String(profile.summary).trim()) throw new Error('profile.summary is required — even "no web presence found" is a finding.');
  const hasFacts = ['website', 'offices', 'employees', 'revenue'].some((k) => profile[k])
    || (profile.approach || []).length > 0;
  if (hasFacts && !(Array.isArray(profile.sources) && profile.sources.length)) {
    throw new Error('sources[] is required when the profile carries facts — every claim needs the URL it came from.');
  }

  const clean = {};
  for (const k of PROFILE_KEYS) clean[k] = profile[k] ?? null;
  clean.enriched_at = new Date().toISOString();
  clean.verification_status = 'ai_drafted';   // a named person flips this, never an AI
  clean.researched_by = researchedBy;
  clean.jurisdiction = 'ZA';

  await pool.query(
    `UPDATE leadfinder.companies
        SET enrichment = $3::jsonb, enriched_at = NOW(), enrichment_status = 'ai_drafted', updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`,
    [companyId, newsroomId, JSON.stringify(clean)]);

  const found = (clean.approach || []).filter((a) => a && a.contact)
    .map((a) => ({ name: a.who || null, email: /@/.test(a.contact) ? a.contact : null,
                   phone: /@/.test(a.contact) ? null : a.contact, source: researchedBy }));
  if (found.length) {
    await pool.query(
      `UPDATE leadfinder.companies
          SET contacts = CASE WHEN contacts = '[]'::jsonb THEN $3::jsonb ELSE contacts || $3::jsonb END
        WHERE id = $1 AND newsroom_id = $2`,
      [companyId, newsroomId, JSON.stringify(found)]);
  }
  return { ok: true, stored: Object.keys(clean).filter((k) => clean[k] != null).length + ' fields', verification_status: 'ai_drafted' };
}

// The sweep's tail: enrich the most CALL-WORTHY unenriched companies, capped.
// The queue is criteria-driven by construction: it orders by claim state, then
// band, then score — and band/score come from the tenant's ACTIVE criteria
// version, so when the client adjusts their criteria (in-app, via the returned
// workbook, or by approving a learning-loop proposal), the enrichment priority
// re-aims itself with no further code. Claimed companies jump the queue — a
// claimed lead is about to be dialled.
// Skips silently when the API key has no credit — the sweep must never die on
// enrichment, and the note says honestly what happened.
export async function enrichTopUnenriched(newsroomId, cap = PER_SWEEP) {
  const { rows } = await pool.query(
    `SELECT id, name FROM leadfinder.companies
      WHERE newsroom_id = $1 AND suppressed_as_existing = false
        AND enriched_at IS NULL AND band IN ('green', 'amber')
      ORDER BY (claimed_at IS NOT NULL) DESC,
               (band = 'green') DESC,
               total_score DESC NULLS LAST
      LIMIT $2`, [newsroomId, cap]);
  const out = { attempted: rows.length, enriched: 0, notes: [] };
  for (const r of rows) {
    try {
      await enrichCompany(r.id, newsroomId);
      out.enriched++;
    } catch (e) {
      out.notes.push(`enrich ${r.name}: ${e.message}`);
      // Credit/auth problems will fail every call — stop after the first.
      if (/credit|billing|401|403|authentication/i.test(e.message)) break;
    }
  }
  return out;
}
