// LeadFinder — source-fetch dispatcher.
//
// Given a leadfinder.sources row, return the NEW documents to run through the
// pipeline as [{ text, externalId, url }]. The source model is configurable
// across kinds (build brief §4A); each kind has its own adapter. 'upload' is the
// always-available kind (documents are pushed in via the surface, not pulled),
// so it yields nothing on a scheduled pull. Portal kinds (html/rss/puppeteer)
// are wired per real source — until a tenant configures one with the selectors
// it needs, the adapter honestly returns nothing rather than fabricate leads.
//
// Adding a real portal later = writing its adapter here + the source's `config`
// (selectors/auth) — no schema or pipeline change.

// eslint-disable-next-line no-unused-vars
async function fetchUpload(source) {
  // Uploads are ingested at upload time (surface POST /tenders/upload), not pulled.
  return [];
}

async function fetchPortalStub(source) {
  // Placeholder for html/puppeteer/rss adapters. Real implementation reads
  // source.config (list URL, item selectors, pagination) and returns items.
  // Returns [] + a note so a run logs "adapter not wired" instead of inventing data.
  // `unwired` tells callers NOT to mark this as a successful pull (it never pulled).
  return { items: [], note: `Adapter for kind '${source.kind}' not wired yet — configure the portal + selectors.`, unwired: true };
}

// ── National Treasury eTender OCDS API (a REAL adapter) ─────────────────────
// SA's central eTender Publication Portal exposes every national / provincial /
// municipal / SOE tender as an Open Contracting Data Standard (OCDS) JSON feed —
// no auth, date-filterable. Docs: https://ocds-api.etenders.gov.za/swagger
//   GET /api/OCDSReleases?PageNumber&PageSize&dateFrom&dateTo  ->  { releases: [...] }
//
// We pull the releases advertised in the source's lookback window, keep the ones
// that fit the tenant's business (category / keyword prefilter from config so we
// don't run the whole national feed through extraction), and hand each to the
// pipeline as a labelled notice the field-extractor can read. The pipeline dedups
// on (source_id, external_id=ocid), so an overlapping lookback re-sees recent
// tenders cheaply and only processes genuinely new ones.
//
//   source.location = API base (default https://ocds-api.etenders.gov.za)
//   source.config   = {
//     lookback_days?: number   (default 3 — FIRST-RUN fallback only; after a
//                               successful pull the window starts at the
//                               source's high-water marker, see below)
//     categories?:  string[]   (OCDS mainProcurementCategory; default ['works'] = construction/infra)
//     keywords?:    string[]   (optional OR-match on title+description; [] = no keyword filter)
//     max_items?:   number     (safety cap on items handed downstream; default 200)
//     page_size?:   number     (default 50)
//   }
const ETENDERS_DEFAULT_BASE = 'https://ocds-api.etenders.gov.za';
const ETENDERS_DEAD_STATUS = ['cancelled', 'unsuccessful', 'withdrawn', 'complete'];
const ETENDERS_MAX_PAGES = 40;      // hard bound so a bad feed can't loop forever
// This feed is SLOW — measured 30-60s for a 200-item page. 30s used to be enough
// only because the adapter stopped after page 1; walking the whole feed made the
// tight timeout the binding constraint (a run aborted at 16 of 48 works tenders).
// A partial walk is kept, not discarded, so a timeout degrades rather than fails.
const ETENDERS_TIMEOUT_MS = 120000;

const ymd = (d) => d.toISOString().slice(0, 10);

// OCDS puts the eligibility bar in `specialConditions` as free text — the real
// values look like "CIDB 2SQ OR HIGHER" or "CIDB 5CE". Pull the requirement out
// deterministically rather than paying the extractor to hunt for it: this is a
// published field, not a judgement call. Returns the verbatim phrase (which is
// what leadfinder.tenders.cidb_grade stores) or null when there is no CIDB
// requirement stated — "N/A" and boilerplate must NOT become a fake grade.
function cidbFromSpecialConditions(s) {
  if (!s) return null;
  const m = String(s).match(/\bCIDB\b[^.;\n\r]*/i);
  if (!m) return null;
  const phrase = m[0].trim().replace(/\s+/g, ' ');
  // A bare "CIDB" with no grade token in it tells us nothing.
  return /\d/.test(phrase) ? phrase : null;
}

function etendersNoticeText(rel) {
  const t = rel.tender || {};
  const buyer = rel.buyer?.name || t.procuringEntity?.name || null;
  const val = t.value || {};
  const period = t.tenderPeriod || {};
  const contact = t.contactPerson || {};
  const brief = t.briefingSession || {};
  return [
    t.title ? `Title: ${t.title}` : null,
    t.id ? `Reference: ${t.id}` : null,
    buyer ? `Issuing body: ${buyer}` : null,
    t.mainProcurementCategory ? `Category: ${t.mainProcurementCategory}` : null,
    t.category ? `Sector: ${t.category}` : null,
    t.province ? `Province: ${t.province}` : null,
    t.deliveryLocation ? `Delivery location: ${t.deliveryLocation}` : null,
    (t.procurementMethodDetails || t.procurementMethod) ? `Procurement method: ${t.procurementMethodDetails || t.procurementMethod}` : null,
    (val.amount != null && val.amount !== 0) ? `Estimated value: ${val.amount} ${val.currency || 'ZAR'}` : null,
    period.startDate ? `Advertised: ${period.startDate}` : null,
    period.endDate ? `Closing date: ${period.endDate}` : null,
    t.status ? `Status: ${t.status}` : null,
    // The eligibility bar — the single most load-bearing field for scoring, and
    // the one this adapter used to drop on the floor.
    t.specialConditions ? `Special conditions: ${t.specialConditions}` : null,
    brief.isSession ? `Briefing: ${brief.date || 'date not stated'}${brief.compulsory ? ' (compulsory)' : ''}${brief.venue ? ` at ${brief.venue}` : ''}` : null,
    (contact.name || contact.email || contact.telephoneNumber)
      ? `Contact: ${[contact.name, contact.email, contact.telephoneNumber].filter(Boolean).join(' · ')}` : null,
    t.description ? `\nDescription:\n${t.description}` : null,
  ].filter(Boolean).join('\n');
}

// Fields OCDS states outright. The pipeline uses these to fill any blank the
// extractor left — published data beats an inference, and it means a missing
// value is genuinely missing rather than merely un-found.
function etendersHints(rel) {
  const t = rel.tender || {};
  const val = t.value || {};
  const contact = t.contactPerson || {};
  return {
    reference_no:    t.id || null,
    issuing_body:    rel.buyer?.name || t.procuringEntity?.name || null,
    title:           t.title || null,
    closing_date:    t.tenderPeriod?.endDate || null,
    estimated_value: (val.amount != null && val.amount !== 0) ? val.amount : null,
    cidb_grade:      cidbFromSpecialConditions(t.specialConditions),
    province:        t.province || null,
    contact:         [contact.name, contact.email, contact.telephoneNumber].filter(Boolean).join(' · ') || null,
  };
}

function etendersMatches(rel, { categories, keywords }) {
  const t = rel.tender || {};
  if (ETENDERS_DEAD_STATUS.includes(String(t.status || '').toLowerCase())) return false;
  if (categories.length) {
    const cat = String(t.mainProcurementCategory || '').toLowerCase();
    if (!categories.includes(cat)) return false;
  }
  if (keywords.length) {
    const hay = `${t.title || ''} ${t.description || ''}`.toLowerCase();
    if (!keywords.some((k) => hay.includes(k))) return false;
  }
  return true;
}

async function fetchEtendersOcds(source) {
  const cfg = source.config || {};
  const base = String(source.location || ETENDERS_DEFAULT_BASE).replace(/\/+$/, '');
  const lookbackDays = Number.isFinite(cfg.lookback_days) ? cfg.lookback_days : 3;
  const categories = (Array.isArray(cfg.categories) ? cfg.categories : ['works']).map((c) => String(c).toLowerCase());
  const keywords = (Array.isArray(cfg.keywords) ? cfg.keywords : []).map((k) => String(k).toLowerCase());
  const maxItems = Number.isFinite(cfg.max_items) ? cfg.max_items : 200;
  const pageSize = Number.isFinite(cfg.page_size) ? cfg.page_size : 50;

  // High-water marker (ingestion done one way): the window starts at the last
  // SUCCESSFUL pull minus a one-day overlap — dedup on ocid makes the overlap
  // free — falling back to lookback_days for a source that has never
  // succeeded. markSourceFetch only advances last_success_at on a clean walk,
  // so a partial or failed run re-covers its window next time instead of
  // silently skipping what it missed. The awards adapter below deliberately
  // does NOT use a marker: that feed mutates old records (awards appear months
  // after the advertised date), so it re-walks an aged window by design.
  const now = new Date();
  const marker = source.last_success_at ? new Date(source.last_success_at).getTime() : null;
  const fromMs = marker
    ? Math.min(marker - 86400000, now.getTime() - 86400000)   // never less than a 1-day window
    : now.getTime() - lookbackDays * 86400000;
  const dateFrom = ymd(new Date(fromMs));
  const dateTo = ymd(now);

  const items = [];
  const seen = new Set();
  let scanned = 0;
  let page = 1;

  try {
    for (let p = 0; p < ETENDERS_MAX_PAGES && items.length < maxItems; p++) {
      const url = `${base}/api/OCDSReleases?PageNumber=${page}&PageSize=${pageSize}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ETENDERS_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      } finally { clearTimeout(timer); }

      if (!res.ok) {
        return { items, note: `etenders OCDS: HTTP ${res.status} on page ${page} — kept ${items.length} before stopping.`, error: `HTTP ${res.status}` };
      }
      const body = await res.json();
      const releases = Array.isArray(body?.releases) ? body.releases : [];
      if (releases.length === 0) break;
      scanned += releases.length;

      for (const rel of releases) {
        if (items.length >= maxItems) break;
        const ocid = rel.ocid || rel.tender?.id;
        if (!ocid || seen.has(String(ocid))) continue;
        if (!etendersMatches(rel, { categories, keywords })) continue;
        seen.add(String(ocid));
        items.push({
          text: etendersNoticeText(rel),
          externalId: String(ocid),
          url: `${base}/api/OCDSReleases/release/${encodeURIComponent(ocid)}`,
          hints: etendersHints(rel),
        });
      }
      // Page until a request comes back EMPTY. This feed does not honour the
      // usual "a short page is the last page" convention — measured over
      // 2026-07-24..27 the pages ran 75, 101, 88, 46, 0, so a short page is
      // routinely followed by a longer one. The old `releases.length < pageSize`
      // break stopped on page 1 and silently took ~24% of the feed (12 works
      // tenders instead of 48). ETENDERS_MAX_PAGES is what bounds the loop.
      page++;
    }
  } catch (err) {
    const why = err.name === 'AbortError' ? 'request timed out' : err.message;
    return { items, note: `etenders OCDS: ${why} — kept ${items.length} before stopping.`, error: why };
  }

  const filterDesc = `${categories.join('/') || 'all categories'}${keywords.length ? ' + keywords' : ''}`;
  return { items, note: `etenders OCDS: scanned ${scanned} release(s) ${dateFrom}→${dateTo}, kept ${items.length} matching ${filterDesc}.` };
}

// ── eTenders OCDS awards mode — the company harvest (plan v2 §5 Phase 3) ─────
// The tender adapter above deliberately drops complete/awarded releases
// (ETENDERS_DEAD_STATUS) because a closed tender is not biddable. But those are
// exactly the releases that carry `awards[].suppliers[]` and tenderer parties —
// the COMPANY names that are the actual leads. This adapter keeps precisely
// what the tender mode discards. No dead-status filter, on purpose.
//
//   source.kind     = 'etenders_awards'
//   source.location = API base (default as above)
//   source.config   = {
//     lookback_days?: number    (default 270 — how far BACK the window starts)
//     lag_days?:      number    (default 60 — how far back it ENDS; see below)
//     categories?:  string[]    (default [] = all — see below)
//     max_items?:   number      (cap on signals emitted; default 300)
//     page_size?:   number      (default 100)
//   }
//
// WHY AN AGED WINDOW (measured 2026-08-19): the date filter selects releases by
// their advertised window, and awards only appear on a release months later,
// after adjudication. A 90-day recent window returned 244 releases with ZERO
// awards (100% status 'active'); the Jan–Mar window returned 9 releases and
// ALL NINE carried awards with supplier names. So this adapter walks
// now−lookback_days → now−lag_days — old enough to be awarded, recent enough
// to be live intent. Density is thin (single digits per quarter inline), which
// is also why categories defaults to [] here: filtering the aged window to
// 'works' can starve it to nothing. Narrow it per source config if needed.
//
// Returns { companies: [{ company:{name,regNo,province,contacts}, signal:{...} }], note }.
// A company item carries ONE signal; the same company appearing on several
// releases emits several items and the upsert/dedupe layer folds them.
async function fetchEtendersAwards(source) {
  const cfg = source.config || {};
  const base = String(source.location || ETENDERS_DEFAULT_BASE).replace(/\/+$/, '');
  const lookbackDays = Number.isFinite(cfg.lookback_days) ? cfg.lookback_days : 270;
  const lagDays = Number.isFinite(cfg.lag_days) ? cfg.lag_days : 60;
  const categories = (Array.isArray(cfg.categories) ? cfg.categories : []).map((c) => String(c).toLowerCase());
  const maxItems = Number.isFinite(cfg.max_items) ? cfg.max_items : 300;
  const pageSize = Number.isFinite(cfg.page_size) ? cfg.page_size : 100;

  const now = new Date();
  const dateFrom = ymd(new Date(now.getTime() - lookbackDays * 86400000));
  const dateTo = ymd(new Date(now.getTime() - lagDays * 86400000));

  const companies = [];
  const seen = new Set();      // signal externalIds, within this run
  const skipped = [];          // pages the feed refused ("p2:500")
  let scanned = 0, awards = 0, tenderers = 0, pageErrors = 0;
  let page = 1;

  // Contacts live on the release's parties[], keyed by party id or name.
  const partyFor = (rel, ref) => {
    const parties = Array.isArray(rel.parties) ? rel.parties : [];
    return parties.find((p) => (ref?.id && p.id === ref.id) || (ref?.name && p.name === ref.name)) || null;
  };
  const contactsOf = (party) => {
    const cp = party?.contactPoint || {};
    const c = { name: cp.name || null, email: cp.email || null, phone: cp.telephoneNumber || cp.telephone || null, source: 'etenders' };
    return (c.name || c.email || c.phone) ? [c] : [];
  };

  const emit = (rel, ref, kind, { value = null, occurredAt = null } = {}) => {
    if (!ref?.name || companies.length >= maxItems) return;
    const ocid = rel.ocid || rel.tender?.id;
    const externalId = `${ocid}:${ref.id || ref.name}`;
    if (seen.has(`${kind}:${externalId}`)) return;
    seen.add(`${kind}:${externalId}`);
    const party = partyFor(rel, ref);
    const t = rel.tender || {};
    const buyer = rel.buyer?.name || t.procuringEntity?.name || null;
    const what = t.title || t.id || 'a public tender';
    companies.push({
      company: {
        name: ref.name,
        // OCDS party identifier is usually the CIPC registration number for SA
        // suppliers, but the feed doesn't promise it — stored as-is, never invented.
        regNo: party?.identifier?.id ? String(party.identifier.id) : null,
        province: party?.address?.region || t.province || null,
        contacts: contactsOf(party),
      },
      signal: {
        kind,
        externalId,
        value,
        occurredAt: occurredAt || rel.date || null,
        evidenceNote: kind === 'award'
          ? `Awarded "${what}"${buyer ? ` by ${buyer}` : ''}${value ? ` (R ${Number(value).toLocaleString('en-ZA')})` : ''}`
          : `Bid on "${what}"${buyer ? ` (${buyer})` : ''}`,
        raw: { ocid, title: t.title || null, buyer, status: t.status || null },
      },
    });
    if (kind === 'award') awards++; else tenderers++;
  };

  try {
    for (let p = 0; p < ETENDERS_MAX_PAGES && companies.length < maxItems; p++) {
      const url = `${base}/api/OCDSReleases?PageNumber=${page}&PageSize=${pageSize}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ETENDERS_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      } finally { clearTimeout(timer); }

      // Measured 2026-08-19: the feed 500s on INDIVIDUAL pages (page 2 of a
      // 30-day window failed repeatedly while pages 1 and 3 served fine). A bad
      // page is skipped, not fatal — three consecutive failures end the walk.
      // (The tender walk above still aborts on first error; same fix applies
      // there if its feed shows the same behaviour.)
      if (!res.ok) {
        pageErrors++;
        if (pageErrors >= 3) {
          return { companies, note: `etenders awards: ${pageErrors} consecutive page errors (last: HTTP ${res.status} on page ${page}) — kept ${companies.length}.`, error: `HTTP ${res.status}` };
        }
        skipped.push(`p${page}:${res.status}`);
        page++;
        continue;
      }
      pageErrors = 0;
      const body = await res.json();
      const releases = Array.isArray(body?.releases) ? body.releases : [];
      if (releases.length === 0) break;   // same page-until-EMPTY rule as the tender walk
      scanned += releases.length;

      for (const rel of releases) {
        const t = rel.tender || {};
        if (categories.length && !categories.includes(String(t.mainProcurementCategory || '').toLowerCase())) continue;
        for (const award of Array.isArray(rel.awards) ? rel.awards : []) {
          for (const sup of Array.isArray(award.suppliers) ? award.suppliers : []) {
            emit(rel, sup, 'award', { value: award.value?.amount ?? null, occurredAt: award.date || null });
          }
        }
        for (const bidder of Array.isArray(t.tenderers) ? t.tenderers : []) {
          emit(rel, bidder, 'tenderer');
        }
      }
      page++;
    }
  } catch (err) {
    const why = err.name === 'AbortError' ? 'request timed out' : err.message;
    return { companies, note: `etenders awards: ${why} — kept ${companies.length} before stopping.`, error: why };
  }

  return {
    companies,
    note: `etenders awards: scanned ${scanned} release(s) ${dateFrom}→${dateTo} — ${awards} award signal(s), ${tenderers} tenderer signal(s), ${categories.join('/') || 'all categories'}`
      + (skipped.length ? ` (feed refused ${skipped.length} page(s): ${skipped.join(', ')})` : '') + '.',
  };
}

// The company-signal fetch, used by the company sweep (lib/companies.js) —
// NOT part of fetchSource, so the tender pipeline can never accidentally run
// an awards source through extraction (callers filter kind='etenders_awards'
// out of the tender path).
export async function fetchCompanySignals(source) {
  if (source.kind !== 'etenders_awards') {
    return { companies: [], note: `Kind '${source.kind}' has no company-signal adapter.`, unwired: true };
  }
  return fetchEtendersAwards(source);
}

const ADAPTERS = {
  upload:         fetchUpload,
  etenders_ocds:  fetchEtendersOcds,
  html:           fetchPortalStub,
  rss:            fetchPortalStub,
  puppeteer:      fetchPortalStub,
  email:          fetchPortalStub,
};

// Returns { items: [{text, externalId, url}], note? }.
export async function fetchSource(source) {
  const adapter = ADAPTERS[source.kind] || fetchPortalStub;
  const out = await adapter(source);
  return Array.isArray(out) ? { items: out } : out;
}

export const WIRED_KINDS = ['upload', 'etenders_ocds', 'etenders_awards']; // kinds that actually produce items today
