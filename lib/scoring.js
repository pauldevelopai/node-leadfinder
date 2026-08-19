// LeadFinder — scoring now comes from the shared Opportunity Finder engine
// (@developai/grounded-opportunity-engine), which was extracted from this very
// file and verified behaviourally identical across 27,720 differential cases.
// LOCKED DECISION (build brief §5) unchanged: scoring is ARITHMETIC against the
// tenant's criteria config — never model-decided.
//
// What stays here is the SEED DATA — the engine never owns business assumptions.

export { scoreEntity as scoreTender, EVALUATORS, registerEvaluator } from '@developai/grounded-opportunity-engine';

// ── starter criteria for a tender→sale business ─────────────────────────────
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
