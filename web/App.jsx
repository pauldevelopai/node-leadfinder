// LeadFinder — the L2B surface (build brief Phase 2). Lives under Tools → Nodes.
// Four tabs: Today (the morning digest, leads ranked by conversion likelihood),
// Review (the amber queue with evidence + accept/reject/reason + outcome
// feedback), Sources (where to find leads — user-owned), Criteria (how leads are
// judged — user-owned, versioned). Tenant-scoped by the login (Wall 1).
import React, { useEffect, useState } from 'react';


// Relative to the page, never absolute: the same bundle serves '/' locally and
// '/nodes/leadfinder/app/' when hosted, so a leading slash would break hosting.
const API = new URL('api/', window.location.href).toString();

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + String(path).replace(/^\/+/, ''), {
    credentials: 'include',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

const BAND = {
  green: { bg: '#dcfce7', fg: '#166534', label: 'Green · follow' },
  amber: { bg: '#fef9c3', fg: '#854d0e', label: 'Amber · review' },
  red:   { bg: '#fee2e2', fg: '#991b1b', label: 'Red · rejected' },
};
const KIND_LABELS = {
  etenders_ocds: 'National eTenders feed',
  html: 'Web page', rss: 'RSS feed', puppeteer: 'Portal (browser)', email: 'Email inbox', upload: 'Manual upload',
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtRand = (v) => (v == null ? '—' : 'R ' + Number(v).toLocaleString('en-ZA'));

export default function BusinessLeadFinder() {
  const [tab, setTab] = useState('today');
  return (
    <div className="hub hub-beaiready">
      <div className="hub-eyebrow">LeadFinder</div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '4px 0 6px' }}>LeadFinder</h1>
      <p style={{ color: '#6b6359', maxWidth: '66ch', marginBottom: 16 }}>
        Overnight, LeadFinder pulls tenders from your sources, reads them, and ranks each by how likely it is
        to convert — so your morning starts with a short list to act on, not a pile to wade through. You keep
        the judgement calls; it does the watching.
      </p>
      <div role="tablist" style={{ display: 'inline-flex', gap: 4, padding: 4, background: '#f4efe9', border: '1px solid #e4dcd2', borderRadius: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {[['today', 'Today'], ['review', 'Review queue'], ['documents', 'Documents'], ['sources', 'Sources'], ['criteria', 'Criteria']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '8px 15px', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 14,
            fontWeight: tab === k ? 700 : 500, color: tab === k ? '#fff' : '#6b6359',
            background: tab === k ? '#c75b39' : 'transparent',
          }}>{label}</button>
        ))}
      </div>
      {tab === 'today' && <TodayTab onGoToSources={() => setTab('sources')} />}
      {tab === 'review' && <ReviewTab />}
      {tab === 'documents' && <DocumentsTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'criteria' && <CriteriaTab />}
    </div>
  );
}

// ── Today: the morning digest + ranked leads ────────────────────────────────
function TodayTab({ onGoToSources }) {
  const [data, setData] = useState(undefined);
  const [sources, setSources] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // tender id being viewed
  const [msg, setMsg] = useState('');

  const load = () => {
    apiFetch('digest').then(setData).catch(() => setData(null));
    apiFetch('sources').then(setSources).catch(() => setSources([]));
  };
  useEffect(() => { load(); }, []);

  const upload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true); setMsg('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(API + 'tenders/upload', { method: 'POST', body: fd, credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || 'Upload failed');
      setMsg(`Processed “${file.name}” → ${d.band?.toUpperCase()} (score ${d.total}).`);
      load();
    } catch (err) { setMsg(err.message); } finally { setBusy(false); e.target.value = ''; }
  };

  if (data === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  const run = data?.run; const leads = data?.leads || [];
  const watching = (sources || []).filter((s) => s.active).length;

  return (
    <div>
      <section className="hub-band" style={{ background: '#fff', border: '1px solid #e4dcd2', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>This morning</h2>
          {watching > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f0f7f2', color: '#166534', fontSize: 12.5, fontWeight: 700, padding: '4px 11px', borderRadius: 999 }}>
              <span aria-hidden>👁</span> Watching {watching} source{watching === 1 ? '' : 's'} · next sweep overnight
            </span>
          )}
        </div>

        {run ? (
          <p style={{ color: '#4b463f', marginTop: 10 }}>
            Last run {fmtDate(run.finished_at || run.started_at)}: <strong>{run.items_new}</strong> pulled from your sources —
            <span style={{ color: BAND.green.fg }}> {run.tenders_green} to follow</span>,
            <span style={{ color: BAND.amber.fg }}> {run.tenders_amber} to review</span>,
            <span style={{ color: BAND.red.fg }}> {run.tenders_red} rejected</span>.
          </p>
        ) : watching > 0 ? (
          <p style={{ color: '#4b463f', marginTop: 10 }}>
            LeadFinder is watching your source{watching === 1 ? '' : 's'}. The first overnight sweep lands your ranked
            shortlist right here — nothing to do but check back in the morning.
          </p>
        ) : (
          <div style={{ marginTop: 10 }}>
            <p style={{ color: '#4b463f', marginTop: 0 }}>
              LeadFinder isn’t watching anything yet. Point it at where your tenders live — a portal, an RSS feed, or
              an inbox — and it pulls and ranks them for you overnight.
            </p>
            <button onClick={onGoToSources} style={btn}>Add your first source →</button>
          </div>
        )}

        {msg && <p style={{ fontSize: 13, color: '#166534', marginTop: 8 }}>{msg}</p>}

        <div style={{ borderTop: '1px solid #f0e9e0', marginTop: 14, paddingTop: 12 }}>
          <label style={{ fontSize: 12.5, color: '#8a8076', cursor: busy ? 'default' : 'pointer' }}>
            Got one in hand? {busy ? <span>Reading…</span> : <span style={{ color: '#c75b39', fontWeight: 600, textDecoration: 'underline' }}>Upload a tender</span>} to score it now — no need to wait for tonight.
            <input type="file" accept=".pdf,.txt,.doc,.docx" onChange={upload} disabled={busy} style={{ display: 'none' }} />
          </label>
        </div>
      </section>

      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>Leads to follow — ranked by likelihood to convert</h3>
      {leads.length === 0 ? (
        <p style={{ color: '#8a8076' }}>
          {watching > 0 || run
            ? 'Nothing to follow yet — your shortlist appears here after the next overnight sweep.'
            : 'Add a source and LeadFinder will fill this with ranked leads each morning.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {leads.map((l) => <LeadCard key={l.id} lead={l} onOpen={() => setOpen(l.id)} />)}
        </div>
      )}
      {open && <TenderDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function LeadCard({ lead, onOpen }) {
  const b = BAND[lead.band] || BAND.red;
  return (
    <button onClick={onOpen} className="hub-card" style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid #e4dcd2', display: 'block', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{lead.title || lead.reference_no || 'Untitled tender'}</span>
        <span style={{ background: b.bg, color: b.fg, fontWeight: 700, fontSize: 12, padding: '2px 9px', borderRadius: 999 }}>
          {b.label} · {lead.total_score}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: '#8a8076', marginTop: 4 }}>
        {lead.issuing_body || '—'} · closes {fmtDate(lead.closing_date)} · {fmtRand(lead.estimated_value)} · {lead.flags} flag{lead.flags === 1 ? '' : 's'}
      </div>
    </button>
  );
}

// ── Tender detail drawer: evidence + accept/reject + outcome feedback ────────
function TenderDrawer({ id, onClose, onChanged }) {
  const [t, setT] = useState(undefined);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => apiFetch(`tenders/${id}`).then(setT).catch(() => setT(null));
  useEffect(() => { load(); }, [id]);

  const review = async (decision) => {
    setBusy(true);
    try { await apiFetch(`tenders/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, reason }) }); await load(); onChanged?.(); }
    finally { setBusy(false); }
  };
  const outcome = async (converted) => {
    setBusy(true);
    try { await apiFetch(`tenders/${id}/outcome`, { method: 'POST', body: JSON.stringify({ outcome: converted ? 'won' : 'lost', converted, note: reason }) }); await load(); onChanged?.(); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', background: '#faf7f3', height: '100%', overflowY: 'auto', padding: '22px 24px', boxShadow: '-4px 0 24px rgba(0,0,0,0.2)' }}>
        <button onClick={onClose} style={{ ...btnGhost, float: 'right' }}>Close</button>
        {t === undefined ? <p>Loading…</p> : !t ? <p>Not found.</p> : (
          <>
            <h2 style={{ marginTop: 0, fontSize: 19 }}>{t.title || t.reference_no || 'Tender'}</h2>
            <p style={{ fontSize: 13, color: '#6b6359', marginTop: 0 }}>
              {t.issuing_body || '—'} · ref {t.reference_no || '—'} · closes {fmtDate(t.closing_date)} · {fmtRand(t.estimated_value)}
            </p>
            <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
              <span style={{ background: (BAND[t.band] || BAND.red).bg, color: (BAND[t.band] || BAND.red).fg, fontWeight: 700, fontSize: 12, padding: '3px 10px', borderRadius: 999 }}>
                {(BAND[t.band] || BAND.red).label} · score {t.total_score}
              </span>
            </div>
            <p style={{ fontSize: 12.5, color: '#8a8076' }}>{t.routing_reason}</p>

            <div className="hub-card-kicker">Component scores</div>
            <ul style={{ margin: '6px 0 14px', paddingLeft: 16, fontSize: 13 }}>
              {Object.entries(t.component_scores || {}).map(([k, s]) => (
                <li key={k}>{k}: <strong>{(s.score * 100).toFixed(0)}%</strong> <span style={{ color: '#8a8076' }}>(w {s.weight}) — {s.note}</span></li>
              ))}
            </ul>

            <div className="hub-card-kicker">Evidence</div>
            <ul style={{ margin: '6px 0 14px', paddingLeft: 16, fontSize: 13 }}>
              {(t.flags || []).length === 0 && <li style={{ color: '#8a8076' }}>No flags.</li>}
              {(t.flags || []).map((f, i) => (
                <li key={i}><strong>{f.flag_type}</strong> {f.evidence_note ? <>— “{f.evidence_note}”</> : null}</li>
              ))}
            </ul>

            {t.decision && <p style={{ fontSize: 13, color: '#166534' }}>Reviewed: <strong>{t.decision.decision}</strong>{t.decision.reason ? ` — ${t.decision.reason}` : ''}</p>}
            {t.outcome && <p style={{ fontSize: 13, color: '#0369a1' }}>Outcome: <strong>{t.outcome.outcome}</strong>{t.outcome.converted != null ? ` (${t.outcome.converted ? 'converted' : 'no sale'})` : ''}</p>}

            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason / note (the signal LeadFinder learns from)…"
              style={{ ...inp, minHeight: 64, marginTop: 8 }} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button disabled={busy} onClick={() => review('accept')} style={btn}>Accept — worth pursuing</button>
              <button disabled={busy} onClick={() => review('reject')} style={btnGhost}>Reject</button>
            </div>
            <div className="hub-card-kicker" style={{ marginTop: 16 }}>Did a past lead convert?</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button disabled={busy} onClick={() => outcome(true)} style={{ ...btnGhost, borderColor: '#166534', color: '#166534' }}>✓ Converted to a sale</button>
              <button disabled={busy} onClick={() => outcome(false)} style={{ ...btnGhost, borderColor: '#991b1b', color: '#991b1b' }}>✗ Didn’t convert</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Review queue: amber tenders needing a call ──────────────────────────────
function ReviewTab() {
  const [rows, setRows] = useState(undefined);
  const [open, setOpen] = useState(null);
  const load = () => apiFetch('tenders?status=needs_review').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  if (rows === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  return (
    <div>
      <p style={{ color: '#6b6359', marginTop: 0 }}>Borderline tenders LeadFinder couldn’t auto-decide — your judgement, with the evidence attached.</p>
      {rows.length === 0 ? <p style={{ color: '#8a8076' }}>The queue is clear.</p> : (
        <div style={{ display: 'grid', gap: 10 }}>{rows.map((l) => <LeadCard key={l.id} lead={{ ...l, flags: l.flags ?? 0 }} onOpen={() => setOpen(l.id)} />)}</div>
      )}
      {open && <TenderDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

// ── Documents: what we need from L2B, and an easy way to send it ────────────
// The criteria and call sheet are the CLIENT'S artefacts, not ours — they exist
// already, and they change. So this is a standing intake rather than a one-off
// onboarding step: each upload supersedes the last and the history is kept, so
// "we've tightened the thresholds" is a 20-second job, not a conversation.
function DocumentsTab() {
  const [data, setData] = useState(undefined);
  const [busy, setBusy] = useState('');       // doc_type currently uploading
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);     // document id being read

  const load = () => apiFetch('documents').then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, []);

  const send = async (docType, file) => {
    if (!file) return;
    setBusy(docType); setMsg(''); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      const res = await fetch(API + 'documents', { method: 'POST', body: fd, credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || 'Upload failed');
      setMsg(d.supersedes
        ? `Got “${d.filename}” — saved as version ${d.version}. Version ${d.supersedes} is kept in the history.`
        : `Got “${d.filename}”. Thank you — that's one less thing outstanding.`);
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  if (data === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  if (!data) return <p style={{ color: '#8a8076' }}>Couldn’t load the document list.</p>;

  return (
    <div>
      <p style={{ color: '#6b6359', marginTop: 0, maxWidth: '66ch' }}>
        The things LeadFinder needs from you. Most of these already exist inside L2B — we would rather
        use yours than invent our own. Send a new version whenever something changes; nothing is
        overwritten, so we can always see what the tool was working from at the time.
      </p>

      {data.outstanding > 0 ? (
        <p style={{ fontSize: 13.5, fontWeight: 600, color: '#854d0e', background: '#fef9c3', display: 'inline-block', padding: '6px 12px', borderRadius: 8 }}>
          {data.outstanding} of {data.items.length} still outstanding
        </p>
      ) : (
        <p style={{ fontSize: 13.5, fontWeight: 600, color: '#166534', background: '#dcfce7', display: 'inline-block', padding: '6px 12px', borderRadius: 8 }}>
          Everything we asked for is in. Send a new version any time something changes.
        </p>
      )}

      {msg && <p style={{ fontSize: 13, color: '#166534' }}>{msg}</p>}
      {err && <p style={{ fontSize: 13, color: '#B91C1C' }}>{err}</p>}

      <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
        {data.items.map((it) => (
          <DocRow key={it.doc_type} item={it} busy={busy === it.doc_type} onSend={send} onRead={setOpen} />
        ))}
      </div>

      {data.extras?.length > 0 && (
        <>
          <div className="hub-card-kicker" style={{ marginTop: 22 }}>Also sent</div>
          <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
            {data.extras.map((e) => (
              <div key={e.id} className="hub-card" style={{ border: '1px solid #e4dcd2', fontSize: 13.5 }}>
                <strong>{e.filename}</strong> <span style={{ color: '#8a8076' }}>· {e.doc_type} · {fmtDate(e.uploaded_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {open && <DocDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DocRow({ item, busy, onSend, onRead }) {
  const got = item.received;
  return (
    <section className="hub-card" style={{ border: '1px solid #e4dcd2', borderLeft: `4px solid ${got ? '#166534' : '#d9cec1'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>
          {got ? '✓ ' : ''}{item.title}
        </span>
        <span style={{ fontSize: 12, color: '#8a8076' }}>
          {item.asked_of ? `asked of ${item.asked_of}` : null}
          {item.changes === 'ongoing' ? ' · expect this to change' : null}
        </span>
      </div>

      <p style={{ fontSize: 13.5, color: '#4b463f', margin: '6px 0 8px', maxWidth: '68ch' }}>{item.why}</p>
      <p style={{ fontSize: 12.5, color: '#8a8076', margin: '0 0 10px' }}>{item.formats}</p>

      {got && (
        <div style={{ fontSize: 12.5, color: '#6b6359', background: '#f7f4ef', padding: '8px 11px', borderRadius: 7, marginBottom: 10 }}>
          <strong>{got.filename}</strong> · version {got.version} · sent {fmtDate(got.uploaded_at)}
          {got.uploaded_by_name ? ` by ${got.uploaded_by_name}` : ''}
          {item.versions > 1 ? ` · ${item.versions} versions kept` : ''}
          {got.has_text && (
            <button onClick={() => onRead(got.id)} style={{ ...btnGhost, padding: '3px 9px', fontSize: 12, marginLeft: 8 }}>
              Read it
            </button>
          )}
        </div>
      )}

      <label style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-block' }}>
        <span style={{ ...btn, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Sending…' : got ? 'Send a newer version' : 'Choose a file'}
        </span>
        <input
          type="file"
          accept=".pdf,.doc,.docx,.xlsx,.csv,.txt"
          disabled={busy}
          onChange={(e) => { onSend(item.doc_type, e.target.files?.[0]); e.target.value = ''; }}
          style={{ display: 'none' }}
        />
      </label>
    </section>
  );
}

function DocDrawer({ id, onClose }) {
  const [d, setD] = useState(undefined);
  useEffect(() => { apiFetch(`documents/${id}`).then(setD).catch(() => setD(null)); }, [id]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)', background: '#faf7f3', height: '100%', overflowY: 'auto', padding: '22px 24px', boxShadow: '-4px 0 24px rgba(0,0,0,0.2)' }}>
        <button onClick={onClose} style={{ ...btnGhost, float: 'right' }}>Close</button>
        {d === undefined ? <p>Loading…</p> : !d ? <p>Not found.</p> : (
          <>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>{d.filename}</h2>
            <p style={{ fontSize: 12.5, color: '#8a8076', marginTop: 0 }}>
              {d.doc_type} · version {d.version} · sent {fmtDate(d.uploaded_at)}
              {d.superseded_at ? ` · superseded ${fmtDate(d.superseded_at)}` : ' · current'}
            </p>
            {d.note && <p style={{ fontSize: 13 }}>{d.note}</p>}
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.55, background: '#fff', border: '1px solid #e4dcd2', borderRadius: 8, padding: 14, fontFamily: 'inherit' }}>
              {d.extracted_text || 'No readable text in this file — it is stored, but we could not pull text out of it (a scan or image, most likely).'}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sources editor ──────────────────────────────────────────────────────────
function SourcesTab() {
  const [rows, setRows] = useState(undefined);
  const [form, setForm] = useState({ name: '', kind: 'html', location: '' });
  const [err, setErr] = useState('');
  const load = () => apiFetch('sources').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const add = async () => {
    setErr('');
    if (!form.name.trim()) { setErr('Give the source a name'); return; }
    try { await apiFetch('sources', { method: 'POST', body: JSON.stringify(form) }); setForm({ name: '', kind: 'html', location: '' }); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggle = async (s) => { await apiFetch(`sources/${s.id}`, { method: 'PUT', body: JSON.stringify({ active: !s.active }) }); load(); };
  const del = async (s) => { await apiFetch(`sources/${s.id}`, { method: 'DELETE' }); load(); };
  if (rows === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  return (
    <div>
      <p style={{ color: '#6b6359', marginTop: 0 }}>Where LeadFinder looks for tenders. Add or change a source any time — no developer needed. The National eTenders feed and manual uploads work today; other portals are wired as you add them.</p>
      <section className="hub-band" style={{ background: '#fff', border: '1px solid #e4dcd2', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 1fr auto', gap: 8, alignItems: 'end' }}>
          <label style={lbl}>Name<input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. National eTender portal" /></label>
          <label style={lbl}>Kind
            <select style={inp} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['etenders_ocds', 'html', 'rss', 'puppeteer', 'email', 'upload'].map((k) => <option key={k} value={k}>{KIND_LABELS[k] || k}</option>)}
            </select>
          </label>
          <label style={lbl}>Location (URL / inbox)<input style={inp} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="https://…" /></label>
          <button onClick={add} style={btn}>Add</button>
        </div>
        {err && <p style={{ color: '#B91C1C', fontSize: 13, marginBottom: 0 }}>{err}</p>}
      </section>
      {rows.length === 0 ? <p style={{ color: '#8a8076' }}>No sources yet.</p> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((s) => (
            <div key={s.id} className="hub-card" style={{ border: '1px solid #e4dcd2', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <strong>{s.name}</strong> <span style={{ fontSize: 12, color: '#8a8076' }}>· {KIND_LABELS[s.kind] || s.kind}{s.location ? ` · ${s.location}` : ''}{s.origin === 'suggested' ? ' · suggested' : ''}</span>
                {s.last_error && <div style={{ fontSize: 12, color: '#B91C1C' }}>last error: {s.last_error}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => toggle(s)} style={btnGhost}>{s.active ? 'Pause' : 'Activate'}</button>
                <button onClick={() => del(s)} style={{ ...btnGhost, color: '#991b1b', borderColor: '#e4c4c4' }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Criteria editor: tune weights + thresholds → saves a new version ────────
function CriteriaTab() {
  const [c, setC] = useState(undefined);
  const [msg, setMsg] = useState('');
  const load = () => apiFetch('criteria').then(setC).catch(() => setC(null));
  useEffect(() => { load(); }, []);
  const setWeight = (i, v) => { const w = [...c.weights]; w[i] = { ...w[i], weight: v }; setC({ ...c, weights: w }); };
  const setThresh = (k, v) => setC({ ...c, thresholds: { ...c.thresholds, [k]: v } });
  const save = async () => {
    setMsg('');
    const body = { thresholds: c.thresholds, weights: c.weights.map((w) => ({ component: w.component, weight: Number(w.weight), source: w.source, rule: w.rule })) };
    try { const updated = await apiFetch('criteria', { method: 'POST', body: JSON.stringify(body) }); setC(updated); setMsg(`Saved as version ${updated.version}.`); }
    catch (e) { setMsg(e.message); }
  };
  if (c === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  if (!c) return <p style={{ color: '#8a8076' }}>No criteria yet.</p>;
  return (
    <div>
      <p style={{ color: '#6b6359', marginTop: 0 }}>How LeadFinder judges a tender’s likelihood to convert. Tune the weights and thresholds — saving creates a new version, so past scores stay auditable. <span style={{ color: '#8a8076' }}>(Active: v{c.version})</span></p>
      <section className="hub-band" style={{ background: '#fff', border: '1px solid #e4dcd2', marginBottom: 14 }}>
        <div className="hub-card-kicker">Components &amp; weights</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {c.weights.map((w, i) => (
            <div key={w.component} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14 }}>{w.component} {w.source === 'learned' && <span style={{ fontSize: 11, color: '#0369a1' }}>· learned</span>}</span>
              <input type="number" step="0.5" min="0" value={w.weight} onChange={(e) => setWeight(i, e.target.value)} style={{ ...inp, width: 90 }} />
            </div>
          ))}
        </div>
      </section>
      <section className="hub-band" style={{ background: '#fff', border: '1px solid #e4dcd2', marginBottom: 14 }}>
        <div className="hub-card-kicker">Thresholds (score out of 100)</div>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
          <label style={lbl}>Green at or above<input type="number" value={c.thresholds?.green_min ?? 70} onChange={(e) => setThresh('green_min', Number(e.target.value))} style={{ ...inp, width: 90 }} /></label>
          <label style={lbl}>Red at or below<input type="number" value={c.thresholds?.red_max ?? 40} onChange={(e) => setThresh('red_max', Number(e.target.value))} style={{ ...inp, width: 90 }} /></label>
        </div>
      </section>
      <button onClick={save} style={btn}>Save as new version</button>
      {msg && <span style={{ marginLeft: 10, fontSize: 13, color: '#166534' }}>{msg}</span>}
    </div>
  );
}

const btn = { padding: '9px 16px', background: '#c75b39', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const btnGhost = { padding: '8px 14px', background: 'transparent', color: '#1c1b1a', border: '1px solid #e4dcd2', borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' };
const inp = { width: '100%', padding: '8px 11px', border: '1px solid #e4dcd2', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' };
const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#6b6359', fontWeight: 600 };
