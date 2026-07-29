// LeadFinder — the two SDK checkpoints (build brief §5: SDK at EXACTLY two points).
//
//   Checkpoint 1 — extract tender fields from raw notice text. Reuses the
//     validated "Extract key fields from a tender notice" prompt (db/seeds/
//     prompts.mjs) verbatim in spirit: the same field list + the hard "never
//     guess — write null / list in not_stated" rule. We ask for JSON so the
//     deterministic scorer downstream gets clean, typed fields.
//   Checkpoint 2 — evidence quotes + borderline qualification. Pulls verbatim
//     quotes that back the routing and a one-line reviewer note. It NEVER sets a
//     score or band — scoring is arithmetic (scoring.js).
//
// Everything between and after these two calls is deterministic.

import { callClaude } from './claude.js';

// Tolerant JSON extraction from a model reply (handles code fences / stray prose).
function parseJson(raw) {
  const s = String(raw).replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ── Checkpoint 1: field extraction ──────────────────────────────────────────
const EXTRACT_SYSTEM =
  `You extract structured fields from a South African tender / RFQ notice. ` +
  `CRITICAL: never guess. If a field is not clearly present, use null and add its name to "not_stated". ` +
  `Do not infer values that aren't written.\n\n` +
  `Return ONE JSON object, no prose, no code fence:\n` +
  `{\n` +
  `  "reference_no": string|null,\n` +
  `  "issuing_body": string|null,\n` +
  `  "title": string|null,\n` +
  `  "scope": string|null,\n` +
  `  "closing_date": "YYYY-MM-DDTHH:mm"|null,   // 24h local; time 00:00 if only a date is given\n` +
  `  "briefing": { "date": "YYYY-MM-DDTHH:mm"|null, "compulsory": true|false|null }|null,\n` +
  `  "estimated_value": number|null,            // Rand, digits only (e.g. 1250000), VAT-excl if stated\n` +
  `  "submission_method": string|null,\n` +
  `  "contact": string|null,\n` +
  `  "cidb_grade": string|null,                 // verbatim requirement, e.g. "CIDB grade 3 ME or higher"\n` +
  `  "bbbee": string|null,\n` +
  `  "eligibility_other": string[],\n` +
  `  "not_stated": string[]\n` +
  `}`;

// Returns the normalised `extracted` object the scorer + spine consume.
export async function extractTenderFields(text) {
  const raw = await callClaude({
    system: EXTRACT_SYSTEM,
    userContent: `TENDER NOTICE:\n"""\n${String(text).slice(0, 12000)}\n"""`,
    maxTokens: 1200,
    temperature: 0,
  });
  const parsed = parseJson(raw) || {};
  // Normalise the few fields scoring/first-class-columns read; keep the rest verbatim.
  return {
    reference_no:      parsed.reference_no ?? null,
    issuing_body:      parsed.issuing_body ?? null,
    title:             parsed.title ?? null,
    scope:             parsed.scope ?? null,
    closing_date:      parsed.closing_date ?? null,
    briefing:          parsed.briefing ?? null,
    estimated_value:   toNumber(parsed.estimated_value),
    submission_method: parsed.submission_method ?? null,
    contact:           parsed.contact ?? null,
    cidb_grade:        parsed.cidb_grade ?? null,
    bbbee:             parsed.bbbee ?? null,
    eligibility_other: Array.isArray(parsed.eligibility_other) ? parsed.eligibility_other : [],
    not_stated:        Array.isArray(parsed.not_stated) ? parsed.not_stated : [],
  };
}

// ── Checkpoint 2: evidence quotes + borderline qualification ─────────────────
const EVIDENCE_SYSTEM =
  `You are a bid analyst pulling the EVIDENCE behind a tender's qualification — you do NOT score or decide the band. ` +
  `Given the notice, the extracted fields, and the deterministic routing already computed, return the verbatim quotes ` +
  `that a human reviewer needs, plus a one-line judgement note.\n\n` +
  `Return ONE JSON object, no prose, no code fence:\n` +
  `{\n` +
  `  "flags": [\n` +
  `    { "flag_type": "eligibility_gap"|"value_fit"|"deadline_tight"|"missing_field"|"sector_fit"|"other",\n` +
  `      "severity": 1-5, "confidence": 0.0-1.0,\n` +
  `      "evidence_note": "a VERBATIM quote from the notice, or a short factual note if no quote exists" }\n` +
  `  ],\n` +
  `  "qualification_note": "one line for the reviewer — why this is worth a look or not (no score)"\n` +
  `}`;

export async function extractEvidence(text, extracted, scoreResult) {
  const raw = await callClaude({
    system: EVIDENCE_SYSTEM,
    userContent:
      `NOTICE:\n"""\n${String(text).slice(0, 12000)}\n"""\n\n` +
      `EXTRACTED FIELDS:\n${JSON.stringify(extracted)}\n\n` +
      `DETERMINISTIC ROUTING (already decided — explain the evidence, don't re-judge):\n` +
      `band=${scoreResult.band}, total=${scoreResult.total}, reason="${scoreResult.routing_reason}"\n` +
      `component scores: ${JSON.stringify(scoreResult.component_scores)}`,
    maxTokens: 1000,
    temperature: 0,
  });
  const parsed = parseJson(raw) || {};
  const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
  return {
    flags: flags.map((f) => ({
      flag_type:     String(f.flag_type || 'other').slice(0, 60),
      severity:      Math.max(1, Math.min(5, parseInt(f.severity, 10) || 3)),
      confidence:    Math.max(0, Math.min(1, Number(f.confidence) || 0.5)),
      evidence_note: f.evidence_note ? String(f.evidence_note).slice(0, 1000) : null,
    })),
    qualification_note: parsed.qualification_note ? String(parsed.qualification_note).slice(0, 500) : null,
  };
}
