// LeadFinder — schema, created on first boot by the runtime's ensureSchema.
//
// A faithful port of the tracker's migrations 131_leadfinder_schema.sql and
// 154_leadfinder_documents.sql. Ten tables in their own `leadfinder` schema,
// every one tenant-scoped by newsroom_id (Wall 1 — L2B sees only L2B).
//
// IMPORTANT — this Node shares the box's Postgres with the tracker, and the
// tracker created these same tables via its migrations. Every statement is
// IF NOT EXISTS, so running this against a database the tracker already
// migrated is a no-op and the existing DATA IS PRESERVED. That is what makes
// the extraction safe: the Node adopts the tables rather than rebuilding them.
//
// After cutover the tracker's 131/154 should stop being the source of truth for
// this schema — two owners for one set of tables is a bug waiting to happen.
// See docs/LEADFINDER_L2B_PLAN.md in the tracker repo.
//
// uuid_generate_v4() comes from uuid-ossp, which the shared database already has.

const STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS leadfinder`,
  `CREATE TABLE IF NOT EXISTS leadfinder.sources (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  name                VARCHAR(300) NOT NULL,
  kind                VARCHAR(20) NOT NULL,          -- 'upload'|'email'|'html'|'rss'|'puppeteer'
  location            TEXT,                          -- url, inbox, or folder (null for ad-hoc upload)
  active              BOOLEAN NOT NULL DEFAULT true,
  run_frequency_hours INTEGER NOT NULL DEFAULT 24,
  last_run_at         TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_error          TEXT,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- source-specific settings (selectors, auth ref, …)
  origin              VARCHAR(12) NOT NULL DEFAULT 'human',  -- 'seed'|'human'|'suggested'
  approved            BOOLEAN NOT NULL DEFAULT true,         -- suggested sources start false (propose->approve)
  rationale           TEXT,                          -- why a suggested source was proposed (for the morning brief)
  items_seen          INTEGER NOT NULL DEFAULT 0,
  items_new           INTEGER NOT NULL DEFAULT 0,
  created_by          UUID REFERENCES public.team_members(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_sources_tenant ON leadfinder.sources(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_sources_active ON leadfinder.sources(newsroom_id, active) WHERE active = true`,
  `CREATE TABLE IF NOT EXISTS leadfinder.criteria_versions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id   UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,                    -- monotonic per tenant
  status        VARCHAR(12) NOT NULL DEFAULT 'draft', -- 'draft'|'active'|'archived'
  thresholds    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {green_min, red_max, hard_rules:[…]}
  notes         TEXT,
  created_by    UUID REFERENCES public.team_members(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at  TIMESTAMPTZ,
  UNIQUE (newsroom_id, version)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_criteria_versions_tenant ON leadfinder.criteria_versions(newsroom_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lf_criteria_active_one
  ON leadfinder.criteria_versions(newsroom_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS leadfinder.criteria_weights (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  criteria_version_id UUID NOT NULL REFERENCES leadfinder.criteria_versions(id) ON DELETE CASCADE,
  component           VARCHAR(60) NOT NULL,          -- 'cidb_grade'|'value_fit'|'sector_fit'|'geography'|'deadline_runway'|…
  weight              NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  source              VARCHAR(12) NOT NULL DEFAULT 'prior',  -- 'prior'|'learned'
  rule                JSONB NOT NULL DEFAULT '{}'::jsonb,    -- how the component maps a field to a 0..1 sub-score
  UNIQUE (criteria_version_id, component)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_criteria_weights_version ON leadfinder.criteria_weights(criteria_version_id)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.raw_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id  UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  source_id    UUID NOT NULL REFERENCES leadfinder.sources(id) ON DELETE CASCADE,
  external_id  TEXT,                                 -- portal id / file hash — the dedup key
  url          TEXT,
  title        TEXT,
  content      TEXT,                                 -- raw extracted text handed to checkpoint 1
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload  JSONB,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending'|'extracted'|'rejected'|'duplicate'
  tender_id    UUID,                                 -- the tender it became (set on extract)
  CONSTRAINT lf_raw_items_dedup UNIQUE (source_id, external_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_raw_items_tenant  ON leadfinder.raw_items(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_raw_items_pending ON leadfinder.raw_items(source_id, status) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS leadfinder.tenders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  source_id           UUID REFERENCES leadfinder.sources(id) ON DELETE SET NULL,
  raw_item_id         UUID REFERENCES leadfinder.raw_items(id) ON DELETE SET NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Extracted fields (checkpoint 1). First-class columns for the ones we filter/
  -- sort/score on`,
  `CREATE INDEX IF NOT EXISTS idx_lf_tenders_tenant   ON leadfinder.tenders(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_tenders_band      ON leadfinder.tenders(newsroom_id, band)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_tenders_status    ON leadfinder.tenders(newsroom_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_tenders_closing   ON leadfinder.tenders(newsroom_id, closing_date)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.tender_flags (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tender_id     UUID NOT NULL REFERENCES leadfinder.tenders(id) ON DELETE CASCADE,
  flag_type     VARCHAR(60) NOT NULL,                -- 'eligibility_gap'|'value_fit'|'deadline_tight'|'missing_field'|…
  severity      SMALLINT NOT NULL DEFAULT 3,         -- 1..5
  confidence    NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  evidence_note TEXT,                                -- the verbatim quote from the notice
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_tender_flags_tender ON leadfinder.tender_flags(tender_id)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.review_decisions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tender_id    UUID NOT NULL REFERENCES leadfinder.tenders(id) ON DELETE CASCADE,
  newsroom_id  UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  decision     VARCHAR(10) NOT NULL,                 -- 'accept'|'reject'
  reason       TEXT,                                 -- free text — the learning signal
  decided_by   UUID REFERENCES public.team_members(id),
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_review_tenant ON leadfinder.review_decisions(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_review_tender ON leadfinder.review_decisions(tender_id)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.lead_outcomes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tender_id    UUID NOT NULL REFERENCES leadfinder.tenders(id) ON DELETE CASCADE,
  newsroom_id  UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  outcome      VARCHAR(16) NOT NULL,   -- 'won'|'lost'|'pursued'|'abandoned'|'no_bid'
  converted    BOOLEAN,                -- did it become a sale? the ranking objective (null = unknown yet)
  rating       SMALLINT,               -- optional 1..5 good/bad signal
  note         TEXT,                   -- why it worked / didn't — free-text learning signal
  recorded_by  UUID REFERENCES public.team_members(id),
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_outcomes_tender ON leadfinder.lead_outcomes(tender_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_outcomes_conv   ON leadfinder.lead_outcomes(newsroom_id, converted)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.runs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id    UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  source_id      UUID REFERENCES leadfinder.sources(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  items_seen     INTEGER NOT NULL DEFAULT 0,
  items_new      INTEGER NOT NULL DEFAULT 0,
  tenders_green  INTEGER NOT NULL DEFAULT 0,
  tenders_amber  INTEGER NOT NULL DEFAULT 0,
  tenders_red    INTEGER NOT NULL DEFAULT 0,
  status         VARCHAR(12) NOT NULL DEFAULT 'running', -- 'running'|'success'|'error'
  error          TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_runs_tenant ON leadfinder.runs(newsroom_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS leadfinder.documents (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id    UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,

  -- Which of our asks this satisfies. Free text rather than an enum so the
  -- request list can grow without a migration`,
  `CREATE INDEX IF NOT EXISTS idx_lf_documents_tenant ON leadfinder.documents(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_documents_current
  ON leadfinder.documents(newsroom_id, doc_type) WHERE superseded_at IS NULL`
];

export async function ensureSchema(pool) {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}

export default ensureSchema;
