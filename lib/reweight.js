// LeadFinder — the reweighting loop (STUB: interface locked, no math yet).
//
// Build brief §3/§5: the learning loop is PROPOSE-ONLY. Learned weights never
// overwrite silently. The gate is non-negotiable even in the stub:
//     propose  ->  the client approves  ->  a NEW criteria version ('learned')
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
// the proposed weights as source='learned', let the client review + activate it (which
// archives the prior active version). That keeps every criteria change
// auditable and versioned — never an in-place overwrite.

// ── The COMPANY loop — implemented, still propose-only ───────────────────────
//
// This is the loop the client actually asked for: we surface leads, they log
// which ones became sales (and which survived — the target is RETAINED, not
// sold: at ~R3,200/month a client who cancels in month three is worth little,
// and fitting on "converted" would teach the tool to find churners), and the
// fit proposes how the weights should move. A human activates the new version;
// the next sweep rescores everything under it. That closes the circle.
//
// Ground truth per company (from leadfinder.company_outcomes, the ladder):
//   retained_12m / retained_90d  → positive, full strength (1.0)
//   converted (not later lost)   → positive, provisional   (0.6)
//   lost                         → negative                (0.0)
// plus call-sheet rejects (company_reviews.decision = 'reject') as negatives —
// a rep saying "not viable" after a call is a real verdict, and it arrives
// months before sale/churn data can.
//
// The fit is deliberately simple and inspectable — no black box judging the
// judge: for each component, compare its mean sub-score among positives vs
// negatives. A component that scored winners high and losers low earns weight;
// one that can't tell them apart loses weight. Moves are bounded (±50% per
// proposal) so no single fit can swing the criteria wildly.

const STAGE_LABEL = { retained_12m: 1.0, retained_90d: 1.0, converted: 0.6, lost: 0.0 };
const MIN_DECIDED = 50;      // decided companies needed before proposing
const MAX_MOVE = 0.5;        // a weight moves at most ±50% per proposal

export async function proposeCompanyReweight(newsroomId) {
  // One row per company: its best (latest-strongest) terminal stage + scores.
  const { rows: companies } = await pool.query(
    `SELECT c.id, c.name, c.component_scores,
            (SELECT o.stage FROM leadfinder.company_outcomes o
              WHERE o.company_id = c.id AND o.stage IN ('retained_12m','retained_90d','converted','lost')
              ORDER BY CASE o.stage WHEN 'retained_12m' THEN 4 WHEN 'retained_90d' THEN 3
                                    WHEN 'converted' THEN 2 ELSE 1 END DESC, o.recorded_at DESC
              LIMIT 1) AS stage,
            (SELECT r.decision FROM leadfinder.company_reviews r
              WHERE r.company_id = c.id ORDER BY r.decided_at DESC LIMIT 1) AS last_review
       FROM leadfinder.companies c
      WHERE c.newsroom_id = $1 AND c.component_scores != '{}'::jsonb`,
    [newsroomId]
  );

  const decided = [];
  for (const c of companies) {
    let label = null;
    if (c.stage && STAGE_LABEL[c.stage] !== undefined) label = STAGE_LABEL[c.stage];
    else if (c.last_review === 'reject') label = 0.0;   // "not viable" is a verdict too
    if (label !== null) decided.push({ ...c, label });
  }

  const positives = decided.filter((d) => d.label > 0);
  const negatives = decided.filter((d) => d.label === 0);
  const basis = {
    scored_companies: companies.length,
    decided: decided.length,
    positives: positives.length,
    negatives: negatives.length,
    min_decided_needed: MIN_DECIDED,
  };

  // The fit needs both classes and enough of them — a proposal fitted on ten
  // sales and zero losses would just inflate everything.
  const ready = decided.length >= MIN_DECIDED && positives.length >= 5 && negatives.length >= 5;
  if (!ready) {
    return {
      newsroom_id: newsroomId, entity: 'company', basis, ready: false,
      proposed_weights: [],
      note: `Collecting ground truth (${decided.length}/${MIN_DECIDED} decided, `
          + `${positives.length} positive / ${negatives.length} negative). `
          + 'The loop is armed — every claim, call sheet and outcome logged feeds it. No proposal until there is enough to fit.',
    };
  }

  // Weighted mean sub-score per component, positives (by label strength) vs negatives.
  const current = await pool.query(
    `SELECT w.component, w.weight::float AS weight
       FROM leadfinder.criteria_weights w
       JOIN leadfinder.criteria_versions v ON v.id = w.criteria_version_id
      WHERE v.newsroom_id = $1 AND v.entity = 'company' AND v.status = 'active'`,
    [newsroomId]
  );

  const meanScore = (rows, component) => {
    let num = 0, den = 0;
    for (const r of rows) {
      const s = r.component_scores?.[component]?.score;
      if (s == null) continue;
      const w = r.label > 0 ? r.label : 1;   // negatives count evenly
      num += Number(s) * w; den += w;
    }
    return den ? num / den : null;
  };

  const proposed_weights = current.rows.map(({ component, weight }) => {
    const posMean = meanScore(positives, component);
    const negMean = meanScore(negatives, component);
    if (posMean == null || negMean == null) {
      return { component, current_weight: weight, proposed_weight: weight, source: 'learned',
               rationale: 'Not enough scored data on this component to judge it — unchanged.' };
    }
    const separation = posMean - negMean;          // -1..1
    const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, separation));
    const proposed = Math.round(weight * (1 + move) * 100) / 100;
    return {
      component, current_weight: weight, proposed_weight: proposed, source: 'learned',
      rationale: `Scored ${Math.round(posMean * 100)}% on companies that converted/retained vs `
               + `${Math.round(negMean * 100)}% on lost/not-viable ones (${positives.length}+/${negatives.length}−). `
               + (Math.abs(separation) < 0.05 ? 'Barely separates them — weight eases off.'
                  : separation > 0 ? 'It predicts — weight earns an increase.'
                  : 'It points the wrong way — weight comes down.'),
    };
  });

  return {
    newsroom_id: newsroomId, entity: 'company', basis, ready: true,
    proposed_weights,
    note: 'A proposal, not a change: review it and save it as a new criteria version to apply. '
        + 'The fit is a per-component comparison of scores between retained/converted companies and lost/not-viable ones.',
  };
}
