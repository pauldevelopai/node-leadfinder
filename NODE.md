# Node identity card — LeadFinder

- **Slug:** `leadfinder`
- **Display name:** LeadFinder
- **Repo:** `pauldevelopai/node-leadfinder`
- **Storage:** Postgres tables in their own `leadfinder` schema, created by
  `lib/schema.js` via `ensureSchema` (the node-analytics pattern). Fifteen
  tables: the original ten (`sources`, `criteria_versions`, `criteria_weights`,
  `raw_items`, `tenders`, `tender_flags`, `review_decisions`, `lead_outcomes`,
  `runs`, `documents`) plus the company side (plan v2 — the company IS the
  lead): `companies`, `company_signals`, `company_reviews` (call sheets),
  `company_outcomes` (the ladder to retained_12m), `cms_accounts` (the client's
  own book, for suppression). `criteria_versions` carries an `entity` column —
  one active version per entity ('tender' | 'company') per tenant.
- **Hosted:** `leadfinder-hosted` on the box, port 3009, gated by the tracker
  cookie. **Live since 2026-08-19.** Canonical door (Grounded is the primary
  front door): `https://grounded.developai.co.za/nodes/leadfinder/app/`;
  MCP connector `https://grounded.developai.co.za/nodes/leadfinder/mcp`.
  The same paths answer on beaiready.developai.co.za.
- **AI:** Claude, via `lib/claude.js`. Exactly two model calls per tender, and
  neither one scores.
- **UI:** React + Vite in `web/`, built into `public/` — the node-greenindex
  pattern. `base: './'` so the same bundle serves `/` locally and
  `/nodes/leadfinder/app/` hosted.
- **MCP:** the node is also a connector — `/mcp` (JSON-RPC 2.0 + SSE, the
  tracker's policy-mcp pattern) works from Claude.ai / ChatGPT with a Bearer
  key minted at `/api/mcp-keys` (per-tenant, hashed, revocable). Eight tools
  covering the whole loop, log_outcome included; every call is logged to
  `leadfinder.mcp_usage`. See `lib/mcp.js`.

## What it does

LeadFinder watches where leads appear, reads each one, and ranks them by how
likely they are to convert — so the morning starts with a short list to act on
rather than a pile to sift.

Built first for a business selling tender-intelligence subscriptions to
construction companies. The important consequence: **the lead is a company, not
a tender.** Tenders are a signal *about* a company. See the LeadFinder plan in
the tracker repo — that entity redirect is the main outstanding piece of work
and it should land here, in this repo.

(Client specifics — who asked for what, and why — stay in the tracker repo's
plan, which is not public. This repo describes the tool, not the customer.)

## The design rule that matters

**Scoring is arithmetic, never model-decided.** The SDK is used at exactly two
checkpoints — extract fields from a notice, and pull evidence quotes — and
neither sets a band. Everything between and after is deterministic, scored
against the tenant's own versioned criteria. That is what makes any routing
decision auditable after the fact.

Two versioned, tenant-owned halves of config:
- **sources** — where to look (`lib/fetch.js`)
- **criteria** — what to score against (`criteria_versions` + `criteria_weights`)

Learned weights are **propose-only**: they never overwrite, they become a new
version a human activates (`lib/reweight.js`).

## Sources

`WIRED_KINDS = ['upload', 'etenders_ocds']`. Other kinds (`html`, `rss`,
`puppeteer`, `email`) return an honest "not wired yet" rather than fabricate
leads. The real adapter is the National Treasury eTenders OCDS API — no auth,
date-filterable.

**Two measured gotchas in that feed, both handled:**
- It does *not* honour "a short page is the last page" — pages ran 75, 101, 88,
  46, 0 over one window. Page until a request returns **empty**.
- It is slow: 30–60s for a 200-item page, hence a 120s timeout.

## Document intake

`leadfinder.documents` + `lib/documents.js` hold a standing request list for the
things the client already has — subscriber list, criteria, call sheet, briefing
portals, churn records. **Every upload is a version**; a re-upload supersedes and
the old one stays readable, so "what was the tool scoring against in August?" is
always answerable.

Nothing consumes these automatically. An uploaded criteria document does not
rewrite `criteria_weights` — a human reads it and tunes. Parsing a client's
scoring sheet straight into weights would be exactly the silent, unauditable
inference the rest of this Node is built to avoid.

## Migration status — READ THIS FIRST

This repo was extracted from the tracker (`pauldevelopai/tracker`), where
LeadFinder was the only `kind: "builtin"` node. The extraction is **scaffolded,
not cut over**:

- [x] engine ported (`fetch`, `extract`, `scoring`, `pipeline`, `reweight`,
      `documents`) with imports rewired to `lib/`
- [x] schema ported from tracker migrations 131 + 154 into `ensureSchema`
- [x] routes ported to `mountRoutes`, tenancy now from the runtime's host
- [x] React UI ported, standalone, builds
- [x] nightly sweep ported
- [ ] **not deployed** — needs a port, pm2 process and Caddy block
- [ ] **`nodes.json` still says `kind: "builtin"`** — flip to hosted at cutover
- [ ] **the tracker still owns the same tables** via migrations 131/154

That last point is the one to be careful about. This Node and the tracker share
one Postgres, and `ensureSchema` is all `IF NOT EXISTS`, so pointing this Node at
the box database **adopts the existing tables and their data** rather than
rebuilding them. That is what makes the move safe — but until cutover there are
two definitions of one schema, which is a bug waiting to happen. At cutover, the
tracker's LeadFinder code and its 131/154 migrations should be retired.
