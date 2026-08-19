// LeadFinder — schema, created on first boot by the runtime's ensureSchema.
//
// A faithful port of the tracker's migrations 131_leadfinder_schema.sql and
// 154_leadfinder_documents.sql. Ten tables in their own `leadfinder` schema,
// every one tenant-scoped by newsroom_id (Wall 1 — a tenant sees only itself).
//
// IMPORTANT — this Node shares the box's Postgres with the tracker, and the
// tracker created these same tables via its migrations. Every statement is
// IF NOT EXISTS, so running this against a database the tracker already
// migrated is a no-op and the existing DATA IS PRESERVED. That is what makes
// the extraction safe: the Node adopts the tables rather than rebuilding them.
//
// GENERATED from the migrations, but do not regenerate by splitting the .sql on
// ";" — two of the column comments contain a semicolon, and a naive split
// truncates CREATE TABLE leadfinder.tenders mid-comment. That shipped once and
// crash-looped the Node with "syntax error at end of input" at position 526,
// which is exactly the length of the truncated statement. Split on semicolons
// that are outside -- comments and '...' strings, or hand-edit this file.
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
  // The original one-active-per-TENANT unique index used to be created here.
  // It is gone, not moved: criteria now score two entities, so the invariant is
  // one-active-per-(tenant, entity) — created further down, after the entity
  // column exists. Recreating the old index here would abort every boot once a
  // tenant legitimately holds an active tender AND an active company version
  // (it did, on 2026-08-19). The DROP below clears it from older databases.
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
  -- sort/score on; the full labelled extraction is kept in \`extracted\` verbatim.
  reference_no        TEXT,
  issuing_body        TEXT,
  title               TEXT,
  closing_date        TIMESTAMPTZ,
  estimated_value     NUMERIC(16,2),
  cidb_grade          TEXT,
  extracted           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- every field incl. "Not stated" markers

  -- Scoring (deterministic, against a specific criteria version).
  component_scores    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-component RAW scores, not just the total
  total_score         NUMERIC(6,2),
  criteria_version_id UUID REFERENCES leadfinder.criteria_versions(id),

  -- Routing.
  band                VARCHAR(6),                    -- 'green'|'amber'|'red'
  routing_reason      TEXT,                          -- which threshold/rule fired
  status              VARCHAR(16) NOT NULL DEFAULT 'new', -- 'new'|'qualified'|'needs_review'|'rejected'|'resolved'

  -- Wall 1: client-only, never crosses into the cross-client pattern layer.
  client_only         BOOLEAN NOT NULL DEFAULT true,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
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
  -- request list can grow without a migration; the catalogue in code is the
  -- source of truth for what is currently being asked for.
  doc_type       VARCHAR(40) NOT NULL,      -- 'criteria'|'call_sheet'|'client_list'|'briefing_portals'|'other'
  version        INTEGER NOT NULL,          -- monotonic per (newsroom, doc_type)
  superseded_at  TIMESTAMPTZ,               -- set when a later version arrives; null = current

  -- The file as received. Kept verbatim — we never edit a client's document.
  filename       TEXT NOT NULL,
  mime_type      VARCHAR(120),
  size_bytes     BIGINT,
  storage_path   TEXT,                      -- on-disk path under the uploads root

  -- Text pulled out at upload time so the document is searchable and readable
  -- in-app without re-parsing. Null when extraction found nothing (a scanned
  -- image, say) — an honest null, never a placeholder.
  extracted_text TEXT,

  -- What the client told us about it, and what we made of it.
  note           TEXT,                      -- uploader's own note ("this replaces the March sheet")
  status         VARCHAR(16) NOT NULL DEFAULT 'received',  -- 'received'|'reviewed'|'applied'

  uploaded_by    UUID REFERENCES public.team_members(id),
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (newsroom_id, doc_type, version)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_documents_tenant ON leadfinder.documents(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_documents_current
  ON leadfinder.documents(newsroom_id, doc_type) WHERE superseded_at IS NULL`,

  // ── The company entity (plan v2: the company is the lead; a tender is a ─────
  // signal about a company). Additive: nothing above changes, and the tracker's
  // migrations never created these, so IF NOT EXISTS makes this Node the owner.

  // Criteria now score two entities. Existing rows backfill to 'tender' via the
  // default; the one-active-per-tenant index becomes one-active-per-entity.
  // (The old index is dropped by name — a no-op on every boot after the first.)
  `ALTER TABLE leadfinder.criteria_versions ADD COLUMN IF NOT EXISTS entity VARCHAR(10) NOT NULL DEFAULT 'tender'`,
  `DROP INDEX IF EXISTS leadfinder.idx_lf_criteria_active_one`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lf_criteria_active_per_entity
  ON leadfinder.criteria_versions(newsroom_id, entity) WHERE status = 'active'`,

  // The client's own book, imported from their client-list uploads. Exists so
  // dedupe is real: a prospect matching a row here is SUPPRESSED, and the count
  // of suppressions is the headline number ("31 already yours").
  `CREATE TABLE IF NOT EXISTS leadfinder.cms_accounts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  normalised_name     TEXT NOT NULL,                 -- same normaliser as companies — the join key
  reg_no              TEXT,
  cidb_reg_no         TEXT,
  vat_no              TEXT,
  emails              JSONB NOT NULL DEFAULT '[]'::jsonb,
  phones              JSONB NOT NULL DEFAULT '[]'::jsonb,
  province            TEXT,
  package             TEXT,                          -- subscription tier, as the client's list states it
  status              TEXT,                          -- subscription status, verbatim from the list
  raw                 JSONB,                         -- the imported row, untouched
  source_document_id  UUID REFERENCES leadfinder.documents(id) ON DELETE SET NULL,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (newsroom_id, normalised_name)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_cms_tenant ON leadfinder.cms_accounts(newsroom_id)`,

  // The lead. Mirrors the tenders scoring spine (component_scores / total /
  // criteria_version / band / routing_reason) so the audit story is identical.
  // claimed_* answers Karen's "there's no rule of thumb": first to claim owns it.
  `CREATE TABLE IF NOT EXISTS leadfinder.companies (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id            UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,               -- as first observed
  normalised_name        TEXT NOT NULL,               -- the dedupe key
  reg_no                 TEXT,
  cidb_reg_no            TEXT,
  cidb_grading           TEXT,                        -- verbatim, e.g. "PE 1CE, 1GB" / "CIDB 5CE"
  cidb_grade             SMALLINT,                    -- parsed max level 1..9
  grade_band             VARCHAR(4),                  -- '1' | '2-5' | '6+' — the territory split
  province               TEXT,
  domain                 TEXT,
  contacts               JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name,email,phone,source}]
  fields                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- computed scoring inputs, kept for audit

  component_scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_score            NUMERIC(6,2),
  criteria_version_id    UUID REFERENCES leadfinder.criteria_versions(id),
  band                   VARCHAR(6),
  routing_reason         TEXT,
  status                 VARCHAR(16) NOT NULL DEFAULT 'new',  -- 'new'|'qualified'|'needs_review'|'rejected'|'suppressed'
  current_stage          VARCHAR(16),                 -- latest outcome-ladder stage

  suppressed_as_existing BOOLEAN NOT NULL DEFAULT false,
  cms_match_id           UUID REFERENCES leadfinder.cms_accounts(id) ON DELETE SET NULL,
  cms_match_confidence   NUMERIC(3,2),

  claimed_by             UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  claimed_by_name        TEXT,                        -- display name/email at claim time
  claimed_at             TIMESTAMPTZ,

  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_signal_at         TIMESTAMPTZ,
  client_only            BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (newsroom_id, normalised_name)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_companies_tenant   ON leadfinder.companies(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_companies_band     ON leadfinder.companies(newsroom_id, band)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_companies_calllist ON leadfinder.companies(newsroom_id, total_score DESC)
  WHERE suppressed_as_existing = false`,

  // Enrichment: the web-researched profile (website, offices, size, who to
  // approach, fit + objections), born 'ai_drafted', flipped to 'human_verified'
  // only by a named person. Additive columns — safe on existing rows.
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS enrichment JSONB`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(16)`,

  // CIDB Register lookups (enrichment Tier 0, lib/cidb.js). cidb_status /
  // cidb_expiry / cidb_bbbee mirror the register verbatim-ish (expiry is typed
  // because a renewal is a buying signal the criteria can read later).
  // cidb_lookup_status: 'matched' | 'possible' | 'none' (null = never checked);
  // 'possible' keeps the candidate rows in cidb_candidates for a PERSON to
  // resolve — an ambiguous register match is never silently attached.
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_status TEXT`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_expiry DATE`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_bbbee TEXT`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_checked_at TIMESTAMPTZ`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_lookup_status VARCHAR(12)`,
  `ALTER TABLE leadfinder.companies ADD COLUMN IF NOT EXISTS cidb_candidates JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_lf_companies_cidb_queue
  ON leadfinder.companies(newsroom_id)
  WHERE cidb_grading IS NULL AND cidb_checked_at IS NULL AND suppressed_as_existing = false`,

  // One row per observed event about a company. external_id makes re-ingestion
  // idempotent (unique treats NULLs as distinct, so manual signals may repeat).
  `CREATE TABLE IF NOT EXISTS leadfinder.company_signals (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id   UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES leadfinder.companies(id) ON DELETE CASCADE,
  kind          VARCHAR(20) NOT NULL,          -- 'award'|'tenderer'|'bid'|'cidb'|'tender_contact'|'call_sheet'|'manual'
  tender_id     UUID REFERENCES leadfinder.tenders(id) ON DELETE SET NULL,
  source_id     UUID REFERENCES leadfinder.sources(id) ON DELETE SET NULL,
  external_id   TEXT,                          -- e.g. "ocid:party" — the dedup key
  value         NUMERIC(16,2),                 -- rand value where the event carries one
  occurred_at   TIMESTAMPTZ,
  evidence_note TEXT,                          -- the human-readable one-liner behind the signal
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, kind, external_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_csignals_company ON leadfinder.company_signals(company_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_csignals_tenant  ON leadfinder.company_signals(newsroom_id)`,

  // The call sheet, captured in-app. answers holds the structured form — the
  // form definition lives in code (companies.js CALL_SHEET_FORM) so replacing it
  // with the client's real sheet is a reviewable diff, like the doc catalogue.
  `CREATE TABLE IF NOT EXISTS leadfinder.company_reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES leadfinder.companies(id) ON DELETE CASCADE,
  answers     JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision    VARCHAR(10),                     -- 'accept'|'reject'|null (info capture without a verdict)
  reason      TEXT,
  decided_by  UUID REFERENCES public.team_members(id),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_creviews_company ON leadfinder.company_reviews(company_id)`,

  // The outcome ladder — one row per step, so a converted lead carries its whole
  // history. The reweighting target is RETAINED, not converted (plan v2 §6).
  `CREATE TABLE IF NOT EXISTS leadfinder.company_outcomes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES leadfinder.companies(id) ON DELETE CASCADE,
  stage       VARCHAR(16) NOT NULL,            -- 'claimed'|'called'|'meeting'|'converted'|'lost'|'retained_90d'|'retained_12m'
  reason      TEXT,                            -- for 'lost': why (closed list once the churn taxonomy lands)
  note        TEXT,
  recorded_by UUID REFERENCES public.team_members(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_coutcomes_company ON leadfinder.company_outcomes(company_id, recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_coutcomes_tenant  ON leadfinder.company_outcomes(newsroom_id, stage)`,

  // ── MCP access layer (the vision's front door: LeadFinder as a connector ────
  // reachable from Claude / ChatGPT, not only as an app). Keys follow the
  // policy_mcp_keys pattern — per-tenant, SHA-256 hashed, revocable; the
  // plaintext is shown once at mint and never stored.
  `CREATE TABLE IF NOT EXISTS leadfinder.mcp_keys (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id  UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,        -- SHA-256 of the bearer token
  label        TEXT NOT NULL,               -- e.g. "Tegan — Claude.ai connector"
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_by   UUID REFERENCES public.team_members(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_mcp_keys_tenant ON leadfinder.mcp_keys(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_mcp_keys_hash   ON leadfinder.mcp_keys(key_hash) WHERE is_active`,

  // Usage, logged from day one — query counts against the data are the evidence
  // the Foundation shows funders (vision layer 4).
  `CREATE TABLE IF NOT EXISTS leadfinder.mcp_usage (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id UUID NOT NULL REFERENCES public.newsrooms(id) ON DELETE CASCADE,
  key_id      UUID REFERENCES leadfinder.mcp_keys(id) ON DELETE SET NULL,
  tool        VARCHAR(60) NOT NULL,
  args        JSONB,
  ok          BOOLEAN NOT NULL DEFAULT true,
  called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_lf_mcp_usage_tenant ON leadfinder.mcp_usage(newsroom_id, called_at DESC)`
];

export async function ensureSchema(pool) {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}

export default ensureSchema;
