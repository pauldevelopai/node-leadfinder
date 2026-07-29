// LeadFinder — the document intake catalogue.
//
// What we are ASKING the client for. This list lives in code rather than the
// database because it is our request, not the tenant's data: it changes when the
// project's needs change, and it should be reviewable in a diff.
//
// Every entry traces to something the client has told us they already have.
// We ask for things people have said exist — not a wishlist.
//
// `why` is shown to the uploader. It matters that they can see what a document
// unlocks, because these are people doing us a favour between sales calls; a
// bare "upload criteria.pdf" gets ignored, "this is what stops the tool pitching
// your existing clients" does not.

export const DOCUMENT_CATALOGUE = [
  {
    doc_type: 'client_list',
    title: 'List of current subscribers',
    why: 'So LeadFinder can drop companies you already sell to before they ever reach your call list. This is the one that saves the most time — every name it suppresses is a call you were going to waste.',
    asked_of: 'your sales lead',
    formats: 'CSV or Excel — company name is enough; registration number, CIDB number or email make the matching far more reliable.',
    changes: 'ongoing',   // expected to be re-sent regularly
  },
  {
    doc_type: 'criteria',
    title: 'Lead qualification criteria',
    why: 'The written thresholds — income levels and CIDB ratings — LeadFinder scores against. Without it we would be guessing at numbers you already have.',
    asked_of: 'your sales lead',
    formats: 'Whatever form it is already in. PDF, Word, a spreadsheet, or a plain email pasted into a text file.',
    changes: 'ongoing',
  },
  {
    doc_type: 'call_sheet',
    title: 'Call sheet / scoring sheet',
    why: 'The sheet your team already vets appointments against — contact position, whether they can sign, company viability, whether they are on new commercial projects. It becomes how LeadFinder ranks, so the tool agrees with the team instead of arguing with it.',
    asked_of: 'your sales lead',
    formats: 'PDF, Word or Excel.',
    changes: 'ongoing',
  },
  {
    doc_type: 'briefing_portals',
    title: 'Tender briefing sites you search',
    why: 'The sites your team googles for tender briefings. LeadFinder can watch them overnight so nobody starts the morning with a search box.',
    asked_of: 'your sales lead',
    formats: 'A list of URLs — a text file, an email, or a spreadsheet.',
    changes: 'occasional',
  },
  {
    doc_type: 'churn_reasons',
    title: 'Why clients cancel',
    why: 'Retention and cancellation records. They tell LeadFinder which leads are worth having — a client who leaves after two months costs more than they bring.',
    asked_of: 'your client liaison',
    formats: 'A spreadsheet export, or the reports you already produce.',
    changes: 'ongoing',
  },
];

export const CATALOGUE_TYPES = DOCUMENT_CATALOGUE.map((d) => d.doc_type);

// Merge the catalogue with what has actually arrived, so the surface can show an
// honest checklist: what we asked for, what is here, what is still outstanding.
// Documents of a type NOT in the catalogue (doc_type 'other', or an entry we have
// since retired) are returned separately rather than dropped — a client took the
// trouble to send them.
export function buildChecklist(rows) {
  const current = new Map();
  const history = new Map();
  for (const r of rows) {
    if (!r.superseded_at) current.set(r.doc_type, r);
    if (!history.has(r.doc_type)) history.set(r.doc_type, []);
    history.get(r.doc_type).push(r);
  }
  const items = DOCUMENT_CATALOGUE.map((c) => ({
    ...c,
    received: current.get(c.doc_type) || null,
    versions: (history.get(c.doc_type) || []).length,
  }));
  const extras = [...current.values()].filter((r) => !CATALOGUE_TYPES.includes(r.doc_type));
  return {
    items,
    extras,
    outstanding: items.filter((i) => !i.received).length,
  };
}
