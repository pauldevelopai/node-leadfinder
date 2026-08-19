// Seed the L2B company criteria — the INFORMED GUESS (criteria v-next, entity
// 'company'), pending the client's written thresholds (their criteria doc was
// promised 27 Jul and is chased separately; when it lands, its numbers replace
// these the same way — a new version through the same gate).
//
// Usage:  DATABASE_URL=postgres://… node scripts/seed-l2b-criteria.mjs [tenant-slug]
// Defaults to slug 'l2b'. Creates a new ACTIVE company criteria version and
// archives the previous one. Idempotent-ish: refuses to run twice against the
// same notes marker unless --force.
//
// WHERE EACH NUMBER COMES FROM (sources: l2b.co.za read 2026-08-19; the two
// 27 Jul calls (Tegan Thomas, Karen — canvassing); LEADFINDER_L2B_PLAN.md §B3):
//
//  * bidding_activity (w 3.0) — L2B sells tender intelligence; a company
//    actively bidding on public work needs it BY DEFINITION. Karen prospects
//    around tender briefings — active bidders are her exact pool. ideal_min 2:
//    a repeat bidder is a habit, a single bid can be a fluke.
//  * losing_bids (w 2.5) — the plan's §B3 insight: companies that bid and
//    LOST are the strongest prospects in the model — actively tendering,
//    spending money on submissions, and not winning, which is precisely the
//    pain the product solves. ideal_min 1 lost bid in 180 days.
//  * recency (w 2.0) — live intent decays. ideal within 45 days, dead past
//    270 (the awards window horizon).
//  * spend_capacity (w 2.0) — Tegan: "just because someone has a CIDB 3
//    doesn't mean they can afford our service — it's based on their cash
//    flow", and cash flow is the named churn cause. Awarded value is the
//    only cash proxy the feed carries: ideal R200k–R50m in 180 days (the
//    band where there's real revenue but an R3,200/month subscription still
//    matters). missing_score 0.4 — most tenderer-only companies show no
//    award value, and that must not bury them.
//  * cidb_graded (w 1.0, deliberately LOW) — grading routes TERRITORY
//    (Tegan+Connie 6+, internal sales 1, AEs between), it does not measure
//    lead quality: a grade-1 is internal sales' good lead, not a bad lead.
//    And consulting engineers — L2B customers per both the site and Tegan —
//    have no CIDB at all. So known-grading earns a nudge, never a verdict.
//  * contactable (w 1.5) — Karen's stated time sink is hunting contact
//    details before she can dial. A lead with a phone number on it is
//    worth more of her morning than one without.
//
//  Thresholds green 65 / red 35: a recent repeat bidder with a lost bid and a
//  contact lands green even with no award value and no CIDB — that is exactly
//  the company Karen wants first. Grade filtering stays a TERRITORY filter in
//  the UI/MCP, not a score.

import '../lib/load-env.js';
import pool from '../lib/pool.js';

const SLUG = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : (process.env.LEADFINDER_TENANT || 'l2b');
const FORCE = process.argv.includes('--force');
const MARKER = 'L2B informed-guess company criteria (site + 27 Jul calls) — replace with their written numbers when they land';

const THRESHOLDS = { green_min: 65, red_max: 35, hard_rules: [] };
const WEIGHTS = [
  { component: 'bidding_activity', weight: 3.0,
    rule: { type: 'range', field: 'signal_count_180d', ideal_min: 2, ideal_max: 9007199254740991, hard_min: 0, missing_score: 0 } },
  { component: 'losing_bids', weight: 2.5,
    rule: { type: 'range', field: 'lost_bid_count_180d', ideal_min: 1, ideal_max: 9007199254740991, hard_min: 0, missing_score: 0 } },
  { component: 'recency', weight: 2.0,
    rule: { type: 'range', field: 'days_since_last_signal', ideal_min: 0, ideal_max: 45, hard_max: 270, missing_score: 0.2 } },
  { component: 'spend_capacity', weight: 2.0,
    rule: { type: 'range', field: 'award_value_180d', ideal_min: 200000, ideal_max: 50000000, hard_min: 0, hard_max: 500000000, missing_score: 0.4 } },
  { component: 'cidb_graded', weight: 1.0,
    rule: { type: 'range', field: 'has_cidb', ideal_min: 1, ideal_max: 1, hard_min: 0, missing_score: 0 } },
  { component: 'contactable', weight: 1.5,
    rule: { type: 'range', field: 'has_contact', ideal_min: 1, ideal_max: 1, hard_min: 0, missing_score: 0 } },
];

const { rows: [nr] } = await pool.query('SELECT id, name FROM public.newsrooms WHERE slug = $1', [SLUG]);
if (!nr) { console.error(`No newsroom with slug '${SLUG}'.`); process.exit(1); }

const { rows: [dup] } = await pool.query(
  `SELECT id, version FROM leadfinder.criteria_versions
    WHERE newsroom_id = $1 AND entity = 'company' AND notes = $2 AND status = 'active'`, [nr.id, MARKER]);
if (dup && !FORCE) {
  console.log(`Already seeded (v${dup.version} active). Use --force to reseed.`);
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [mx] } = await client.query(
    'SELECT COALESCE(MAX(version),0) AS v FROM leadfinder.criteria_versions WHERE newsroom_id = $1', [nr.id]);
  await client.query(
    `UPDATE leadfinder.criteria_versions SET status = 'archived'
      WHERE newsroom_id = $1 AND entity = 'company' AND status = 'active'`, [nr.id]);
  const { rows: [ver] } = await client.query(
    `INSERT INTO leadfinder.criteria_versions (newsroom_id, version, entity, status, thresholds, notes, activated_at)
     VALUES ($1,$2,'company','active',$3::jsonb,$4,NOW()) RETURNING id, version`,
    [nr.id, mx.v + 1, JSON.stringify(THRESHOLDS), MARKER]);
  for (const w of WEIGHTS) {
    await client.query(
      `INSERT INTO leadfinder.criteria_weights (criteria_version_id, component, weight, source, rule)
       VALUES ($1,$2,$3,'prior',$4::jsonb)`, [ver.id, w.component, w.weight, JSON.stringify(w.rule)]);
  }
  await client.query('COMMIT');
  console.log(`Seeded company criteria v${ver.version} (active) for ${nr.name} [${SLUG}].`);
  console.log('Companies rescore under it on the next sweep (or POST /api/companies/run).');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Seed failed:', e.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
