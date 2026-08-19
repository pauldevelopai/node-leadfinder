// LeadFinder — the document intake catalogue + text-borne document storage.
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

// Store a document that arrived as TEXT — the connector path, where a rep drops
// a file into their AI chat and the AI relays the content (connectors carry
// JSON, never file bytes). Same versioning as the upload route: new version,
// prior superseded, history kept, nothing ever edited.
import pool from './pool.js';

export async function storeDocumentText({ newsroomId, docType, filename, text, note = null, source = 'connector' }) {
  const type = String(docType || 'other').slice(0, 40);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mx] } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM leadfinder.documents
        WHERE newsroom_id = $1 AND doc_type = $2`, [newsroomId, type]);
    await client.query(
      `UPDATE leadfinder.documents SET superseded_at = NOW()
        WHERE newsroom_id = $1 AND doc_type = $2 AND superseded_at IS NULL`, [newsroomId, type]);
    const { rows: [doc] } = await client.query(
      `INSERT INTO leadfinder.documents
         (newsroom_id, doc_type, version, filename, mime_type, size_bytes, storage_path, extracted_text, note)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)
       RETURNING id, doc_type, version, filename, uploaded_at`,
      [newsroomId, type, mx.v + 1, String(filename || `${type}-via-${source}.txt`).slice(0, 300),
       'text/plain', Buffer.byteLength(text || '', 'utf8'), text || null, note]);
    await client.query('COMMIT');
    return { ...doc, supersedes: mx.v || null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

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
