// LeadFinder — the reweighting loop (STUB: interface locked, no math yet).
//
// Build brief §3/§5: the learning loop is PROPOSE-ONLY. Learned weights never
// overwrite silently. The gate is non-negotiable even in the stub:
//     propose  ->  L2B approves  ->  a NEW criteria version (source='learned')
// Nothing here writes weights or activates a version. proposeReweight() only
// reads history and returns a proposal object; applying it is a separate,
// explicit, human-gated action (creating + activating a new criteria_version),
// which is why the math is deliberately absent until there are enough real
// decisions (~50) to fit against.
//
// The signal it will fit against (already persisted by Phase 1):
//   * leadfinder.lead_outcomes.converted  — did a followed lead become a sale?
//   * leadfinder.review_decisions          — accept/reject + reason at amber time
// Against each tender's leadfinder.tenders.component_scores (per-component raw
// scores) under the criteria_version that scored it. The fit asks: which
// components actually predicted conversion, and how should their weights move?

import pool from './pool.js';

// Read-only. Returns a proposal the human reviews — it does NOT change criteria.
export async function proposeReweight(newsroomId) {
  // How much ground truth do we have? (The stub reports readiness, fits nothing.)
  const { rows: [counts] } = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM leadfinder.lead_outcomes   WHERE newsroom_id = $1) AS outcomes,
        (SELECT COUNT(*) FROM leadfinder.lead_outcomes   WHERE newsroom_id = $1 AND converted = true)  AS converted,
        (SELECT COUNT(*) FROM leadfinder.review_decisions WHERE newsroom_id = $1) AS decisions`,
    [newsroomId]
  ).catch(() => ({ rows: [{ outcomes: 0, converted: 0, decisions: 0 }] }));

  const MIN_OUTCOMES = 50; // don't fit weights on thin data
  const ready = Number(counts.outcomes) >= MIN_OUTCOMES;

  return {
    newsroom_id: newsroomId,
    basis: {
      outcomes:  Number(counts.outcomes),
      converted: Number(counts.converted),
      decisions: Number(counts.decisions),
      min_outcomes_needed: MIN_OUTCOMES,
    },
    ready,
    // No math yet — an empty proposal until the fit is built. When implemented,
    // each entry is { component, current_weight, proposed_weight, source:'learned', rationale }.
    proposed_weights: [],
    note: ready
      ? 'Enough outcome data to fit — reweighting math not implemented yet (stub).'
      : `Collecting outcome data (${counts.outcomes}/${MIN_OUTCOMES}). No proposal until there's enough to fit.`,
  };
}

// Applying a proposal is intentionally NOT here. It is a separate, human-gated
// action: create a new leadfinder.criteria_versions row (status 'draft') with
// the proposed weights as source='learned', let L2B review + activate it (which
// archives the prior active version). That keeps every criteria change
// auditable and versioned — never an in-place overwrite.
