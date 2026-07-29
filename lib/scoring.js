// LeadFinder — deterministic scoring (the "score trust" core).
//
// LOCKED DECISION (build brief §5): scoring is ARITHMETIC against the tenant's
// criteria config — never model-decided. The SDK only extracts fields
// (checkpoint 1) and evidence/qualification (checkpoint 2); it never sets a band.
//
// The engine is a GENERIC rule evaluator: each criteria component carries a
// `rule` (JSONB in leadfinder.criteria_weights) that maps an extracted field to
// a 0..1 sub-score. So the business's assumptions live in editable config (the
// user builds/tunes criteria while using LeadFinder, brief clarification #2) —
// adding or changing a component needs no code change. The objective the score
// estimates is CONVERSION LIKELIHOOD (will this lead become a sale, #3); the
// learning loop later reweights against real outcomes (lead_outcomes, #4).

// ── field coercion helpers (extracted values may be strings or "Not stated") ──
const NOT_STATED = (v) => v == null || /^\s*(not stated|n\/?a|unknown|-)?\s*$/i.test(String(v));

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "CIDB grade 3 ME or higher" / "Grade 5" / "3" -> 3
function toGrade(v) {
  if (v == null) return null;
  const m = String(v).match(/\b([1-9])\b/);
  return m ? parseInt(m[1], 10) : null;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// ── the rule evaluators — each returns { score: 0..1, note } ─────────────────
// A rule's `field` names a key in the extracted object.
const EVALUATORS = {
  // numeric field inside an ideal band; linear falloff outside to hard bounds.
  range(rule, extracted) {
    const val = toNumber(extracted[rule.field]);
    if (val == null) return { score: rule.missing_score ?? 0.3, note: `${rule.field} not stated` };
    const { ideal_min = 0, ideal_max = Infinity, hard_min = 0, hard_max = Infinity } = rule;
    if (val >= ideal_min && val <= ideal_max) return { score: 1, note: `${rule.field} in ideal range` };
    if (val < ideal_min) {
      const s = clamp01((val - hard_min) / Math.max(1, ideal_min - hard_min));
      return { score: s, note: `${rule.field} below ideal` };
    }
    const s = clamp01((hard_max - val) / Math.max(1, hard_max - ideal_max));
    return { score: s, note: `${rule.field} above ideal` };
  },

  // required CIDB grade must be within the business's capability.
  grade_within(rule, extracted) {
    const required = toGrade(extracted[rule.field]);
    if (required == null) return { score: rule.missing_score ?? 0.5, note: 'grade not stated' };
    const cap = rule.business_max_grade ?? 9;
    if (required <= cap) return { score: 1, note: `required grade ${required} within capability ${cap}` };
    return { score: 0, note: `required grade ${required} exceeds capability ${cap}` };
  },

  // any of the keywords appears in the field(s) -> fit. Accepts `fields: [...]`
  // (scan several) or a single `field`; matching across title+description matters
  // for feed sources whose title is a terse reference, not the subject.
  keyword_any(rule, extracted) {
    const fields = rule.fields || (rule.field ? [rule.field] : []);
    const hay = fields.map((f) => String(extracted[f] || '')).join(' ').toLowerCase().trim();
    if (!hay) return { score: rule.missing_score ?? 0.3, note: `${fields.join('/') || 'field'} empty` };
    // Word-START boundary match: "road" hits road/roads/roadworks but NOT "broadband";
    // avoids the substring false positives plain includes() produced.
    const hit = (rule.keywords || []).find((k) => {
      const kw = String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + kw).test(hay);
    });
    return hit
      ? { score: 1, note: `matched "${hit}"` }
      : { score: rule.miss_score ?? 0.2, note: 'no keyword match' };
  },

  // enough runway before the closing date to prepare a competitive bid.
  runway(rule, extracted, now) {
    const close = toDate(extracted[rule.field]);
    if (!close) return { score: rule.missing_score ?? 0.3, note: 'closing date not stated' };
    const days = (close.getTime() - now.getTime()) / 86400000;
    const { ideal_min_days = 14, hard_min_days = 2 } = rule;
    if (days < hard_min_days) return { score: 0, note: `only ${Math.round(days)}d to close`, hard: true };
    if (days >= ideal_min_days) return { score: 1, note: `${Math.round(days)}d runway` };
    return { score: clamp01((days - hard_min_days) / Math.max(1, ideal_min_days - hard_min_days)), note: `${Math.round(days)}d runway (tight)` };
  },

  // share of key fields actually present (data completeness).
  completeness(rule, extracted) {
    const fields = rule.fields || [];
    if (!fields.length) return { score: 1, note: 'no fields configured' };
    const present = fields.filter((f) => !NOT_STATED(extracted[f])).length;
    return { score: present / fields.length, note: `${present}/${fields.length} key fields present` };
  },
};

// ── score one tender against a criteria config ──────────────────────────────
// criteria = { weights: [{component, weight, rule}], thresholds: {green_min,
// red_max, hard_rules?} }. Returns per-component RAW scores (persisted, not just
// the total), the weighted total (0..100), band, and the reason that fired.
export function scoreTender(extracted, criteria, now = new Date()) {
  const weights = criteria.weights || [];
  const componentScores = {};
  let hardFail = null;
  let weighted = 0;
  let weightSum = 0;

  for (const w of weights) {
    const evalFn = EVALUATORS[w.rule?.type];
    const res = evalFn ? evalFn(w.rule, extracted, now) : { score: 0, note: `unknown rule "${w.rule?.type}"` };
    const score = clamp01(res.score);
    componentScores[w.component] = { score, weight: w.weight, note: res.note, source: w.source || 'prior' };
    weighted += score * w.weight;
    weightSum += w.weight;
    // A rule can flag a hard fail (e.g. deadline already effectively passed).
    if (res.hard && !hardFail) hardFail = `${w.component}: ${res.note}`;
    // Config-declared hard rule: component score of 0 auto-rejects.
    if ((criteria.thresholds?.hard_rules || []).includes(w.component) && score === 0 && !hardFail) {
      hardFail = `${w.component} failed a hard rule (${res.note})`;
    }
  }

  const total = weightSum > 0 ? (weighted / weightSum) * 100 : 0;
  const { green_min = 70, red_max = 40 } = criteria.thresholds || {};

  let band, routing_reason;
  if (hardFail) {
    band = 'red';
    routing_reason = `hard rule: ${hardFail}`;
  } else if (total >= green_min) {
    band = 'green';
    routing_reason = `score ${total.toFixed(1)} ≥ green threshold ${green_min}`;
  } else if (total <= red_max) {
    band = 'red';
    routing_reason = `score ${total.toFixed(1)} ≤ red threshold ${red_max}`;
  } else {
    band = 'amber';
    routing_reason = `score ${total.toFixed(1)} between ${red_max} and ${green_min} — needs review`;
  }

  return { component_scores: componentScores, total: Math.round(total * 10) / 10, band, routing_reason };
}

// ── starter criteria for a tender→sale business (L2B) ────────────────────────
// This is SEED DATA, not engine logic — it's inserted as criteria version 1 and
// the user tunes it in LeadFinder. Components are conversion predictors: a lead
// converts if the business can qualify (eligibility), the job fits (sector),
// the value is worth bidding, and there's time to prepare.
export const STARTER_CRITERIA = {
  thresholds: { green_min: 70, red_max: 40, hard_rules: ['eligibility_fit', 'deadline_runway', 'sector_fit'] },
  weights: [
    { component: 'eligibility_fit', weight: 3.0, source: 'prior',
      rule: { type: 'grade_within', field: 'cidb_grade', business_max_grade: 6, missing_score: 0.5 } },
    { component: 'value_fit', weight: 2.0, source: 'prior',
      rule: { type: 'range', field: 'estimated_value', ideal_min: 100000, ideal_max: 5000000, hard_min: 0, hard_max: 20000000, missing_score: 0.3 } },
    { component: 'sector_fit', weight: 2.5, source: 'prior',
      rule: { type: 'keyword_any', fields: ['title', 'scope'], keywords: ['construction', 'civil', 'road', 'building', 'bridge', 'infrastructure', 'plumbing', 'electrical', 'hvac', 'air-condition', 'roofing', 'sanitation', 'refurbish', 'renovation', 'fencing', 'painting', 'earthworks', 'concrete', 'paving', 'water', 'sewer', 'pipeline', 'structural', 'demolition', 'engineering'], miss_score: 0.0 } },
    { component: 'deadline_runway', weight: 1.5, source: 'prior',
      rule: { type: 'runway', field: 'closing_date', ideal_min_days: 14, hard_min_days: 3 } },
    { component: 'completeness', weight: 1.0, source: 'prior',
      rule: { type: 'completeness', fields: ['reference_no', 'issuing_body', 'closing_date', 'estimated_value', 'contact'] } },
  ],
};
