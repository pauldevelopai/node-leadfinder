// LeadFinder — the client-facing surface.
// Six tabs: Today (the morning tender digest), Call list (companies — the
// actual leads: ranked, claimable, with the call sheet and the outcome ladder),
// Review (the amber tender queue), Documents (the standing intake), Sources
// (where to look — user-owned), Criteria (how leads are judged — user-owned,
// versioned). Tenant-scoped by the login (Wall 1).
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
  etenders_awards: 'eTenders awards (companies)',
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
        {[['today', 'Today'], ['calllist', 'Call list'], ['review', 'Review queue'], ['documents', 'Documents'], ['sources', 'Sources'], ['criteria', 'Criteria']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '8px 15px', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 14,
            fontWeight: tab === k ? 700 : 500, color: tab === k ? '#fff' : '#6b6359',
            background: tab === k ? '#c75b39' : 'transparent',
          }}>{label}</button>
        ))}
      </div>
      {tab === 'today' && <TodayTab onGoToSources={() => setTab('sources')} />}
      {tab === 'calllist' && <CallListTab onGoToSources={() => setTab('sources')} />}
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

// ── Call list: companies — the actual leads ─────────────────────────────────
// The tab that replaces the manual morning: ranked new-to-us companies, each
// with its evidence, a claim (first to take it owns it), the call sheet, and
// the outcome ladder. The counter line is the tool's honesty: found / already
// yours / to call.
const GRADE_BANDS = [['', 'All grades'], ['6+', 'CIDB 6+'], ['2-5', 'CIDB 2–5'], ['1', 'CIDB 1']];
const STAGES = [
  ['claimed', 'Claimed'], ['called', 'Called'], ['meeting', 'Meeting booked'],
  ['converted', 'Converted'], ['lost', 'Lost'], ['retained_90d', 'Retained 90d'], ['retained_12m', 'Retained 12m'],
];

function CallListTab({ onGoToSources }) {
  const [data, setData] = useState(undefined);
  const [gradeBand, setGradeBand] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => {
    const qs = gradeBand ? `?grade_band=${encodeURIComponent(gradeBand)}` : '';
    apiFetch(`companies${qs}`).then(setData).catch(() => setData(null));
  };
  useEffect(() => { load(); }, [gradeBand]);

  const runNow = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await apiFetch('companies/run', { method: 'POST', body: JSON.stringify({}) });
      setMsg(`Swept ${r.sources} source${r.sources === 1 ? '' : 's'}: ${r.companies_new} new compan${r.companies_new === 1 ? 'y' : 'ies'}, ${r.signals_new} new signal${r.signals_new === 1 ? '' : 's'}, ${r.suppressed} suppressed as existing clients.`);
      load();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  if (data === undefined) return <p style={{ color: '#8a8076' }}>Loading…</p>;
  if (!data) return <p style={{ color: '#8a8076' }}>Couldn’t load the call list.</p>;
  const k = data.counters || {};
  const companies = data.companies || [];

  return (
    <div>
      <section className="hub-band" style={{ background: '#fff', border: '1px solid #e4dcd2', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Companies to call</h2>
          <button onClick={runNow} disabled={busy} style={btnGhost}>{busy ? 'Sweeping…' : 'Run a sweep now'}</button>
        </div>
        <p style={{ color: '#4b463f', marginTop: 10, marginBottom: 0 }}>
          <strong>{k.found ?? 0}</strong> found · <strong>{k.suppressed ?? 0}</strong> already yours ·{' '}
          <strong style={{ color: '#166534' }}>{k.to_call ?? 0}</strong> to call
          {k.new_7d ? <span style={{ color: '#8a8076' }}> · {k.new_7d} new this week</span> : null}
        </p>
        <p style={{ fontSize: 12.5, color: '#8a8076', marginTop: 6, marginBottom: 0 }}>
          Companies winning and bidding on public work, pulled from the eTenders awards feed and ranked.
          Claim one before you dial — a claimed company is yours, so nobody doubles a call.
        </p>
        {msg && <p style={{ fontSize: 13, color: '#166534', marginTop: 8, marginBottom: 0 }}>{msg}</p>}
      </section>

      <div style={{ display: 'inline-flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
        {GRADE_BANDS.map(([v, label]) => (
          <button key={v || 'all'} onClick={() => setGradeBand(v)} style={{
            ...btnGhost, padding: '5px 12px', fontSize: 12.5,
            background: gradeBand === v ? '#c75b39' : 'transparent',
            color: gradeBand === v ? '#fff' : '#6b6359',
            borderColor: gradeBand === v ? '#c75b39' : '#e4dcd2',
          }}>{label}</button>
        ))}
      </div>

      {companies.length === 0 ? (
        <p style={{ color: '#8a8076' }}>
          No companies yet{gradeBand ? ' in this grade band' : ''}.{' '}
          {gradeBand ? 'Try another band.' : <>Add an <strong>eTenders awards</strong> source (<button onClick={onGoToSources} style={{ ...btnGhost, padding: '2px 8px', fontSize: 12.5 }}>Sources</button>) and run a sweep — or wait for tonight’s.</>}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {companies.map((c) => <CompanyCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />)}
        </div>
      )}
      {open && <CompanyDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function CompanyCard({ c, onOpen }) {
  const b = c.band ? (BAND[c.band] || BAND.red) : null;
  const stage = STAGES.find(([v]) => v === c.current_stage)?.[1];
  return (
    <button onClick={onOpen} className="hub-card" style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid #e4dcd2', display: 'block', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
          {c.grade_band && <span style={{ background: '#f4efe9', color: '#6b6359', fontWeight: 700, fontSize: 11.5, padding: '2px 8px', borderRadius: 999 }}>CIDB {c.grade_band}</span>}
          {b && <span style={{ background: b.bg, color: b.fg, fontWeight: 700, fontSize: 12, padding: '2px 9px', borderRadius: 999 }}>{b.label} · {c.total_score}</span>}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: '#8a8076', marginTop: 4 }}>
        {c.province || '—'} · {c.signals} signal{c.signals === 1 ? '' : 's'} · last {fmtDate(c.last_signal_at)}
        {c.claimed_at && <span style={{ color: '#0369a1', fontWeight: 600 }}> · claimed by {c.claimed_by_name || 'a colleague'}</span>}
        {stage && c.current_stage !== 'claimed' && <span style={{ color: '#166534', fontWeight: 600 }}> · {stage}</span>}
      </div>
    </button>
  );
}

// ── Company drawer: evidence, claim, call sheet, outcome ladder ─────────────
function CompanyDrawer({ id, onClose, onChanged }) {
  const [c, setC] = useState(undefined);
  const [me, setMe] = useState(null);
  const [form, setForm] = useState(null);        // call-sheet definition
  const [answers, setAnswers] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => apiFetch(`companies/${id}`).then(setC).catch(() => setC(null));
  useEffect(() => {
    load();
    apiFetch('whoami').then(setMe).catch(() => {});
    apiFetch('call-sheet-form').then(setForm).catch(() => setForm([]));
  }, [id]);

  const act = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const claim = () => act(() => apiFetch(`companies/${id}/claim`, { method: 'POST', body: JSON.stringify({}) }));
  const unclaim = () => act(() => apiFetch(`companies/${id}/unclaim`, { method: 'POST', body: JSON.stringify({}) }));
  const sendSheet = (decision) => act(() => apiFetch(`companies/${id}/call-sheet`, {
    method: 'POST', body: JSON.stringify({ answers, decision, reason }),
  }));
  const setStage = (stage) => act(() => apiFetch(`companies/${id}/outcome`, {
    method: 'POST', body: JSON.stringify({ stage, reason: stage === 'lost' ? reason : undefined }),
  }));

  const mine = c && me && c.claimed_by && c.claimed_by === me.id;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(600px, 100%)', background: '#faf7f3', height: '100%', overflowY: 'auto', padding: '22px 24px', boxShadow: '-4px 0 24px rgba(0,0,0,0.2)' }}>
        <button onClick={onClose} style={{ ...btnGhost, float: 'right' }}>Close</button>
        {c === undefined ? <p>Loading…</p> : !c ? <p>Not found.</p> : (
          <>
            <h2 style={{ marginTop: 0, fontSize: 19 }}>{c.name}</h2>
            <p style={{ fontSize: 13, color: '#6b6359', marginTop: 0 }}>
              {c.cidb_grading ? `CIDB ${c.cidb_grading}` : 'CIDB grading unknown'} · {c.province || 'province unknown'}
              {c.reg_no ? ` · reg ${c.reg_no}` : ''}
            </p>
            {c.band && (
              <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
                <span style={{ background: (BAND[c.band] || BAND.red).bg, color: (BAND[c.band] || BAND.red).fg, fontWeight: 700, fontSize: 12, padding: '3px 10px', borderRadius: 999 }}>
                  {(BAND[c.band] || BAND.red).label} · score {c.total_score}
                </span>
              </div>
            )}
            {c.routing_reason && <p style={{ fontSize: 12.5, color: '#8a8076', marginTop: 0 }}>{c.routing_reason}</p>}
            {c.suppressed_as_existing && (
              <p style={{ fontSize: 13, fontWeight: 600, color: '#854d0e', background: '#fef9c3', padding: '6px 12px', borderRadius: 8, display: 'inline-block' }}>
                Already a client{c.cms_match_name ? ` — matches “${c.cms_match_name}” in your client list` : ''}. Not on the call list.
              </p>
            )}

            {/* Claim — first to take it owns it */}
            <div style={{ margin: '10px 0 14px' }}>
              {c.claimed_at ? (
                <span style={{ fontSize: 13.5 }}>
                  <strong style={{ color: '#0369a1' }}>Claimed by {mine ? 'you' : (c.claimed_by_name || 'a colleague')}</strong>
                  {' '}on {fmtDate(c.claimed_at)}
                  {mine && <button onClick={unclaim} disabled={busy} style={{ ...btnGhost, padding: '3px 10px', fontSize: 12.5, marginLeft: 10 }}>Release</button>}
                </span>
              ) : (
                <button onClick={claim} disabled={busy} style={btn}>Claim this company — I’ll call them</button>
              )}
            </div>

            {/* Contacts */}
            <div className="hub-card-kicker">Contacts</div>
            <ul style={{ margin: '6px 0 14px', paddingLeft: 16, fontSize: 13 }}>
              {(Array.isArray(c.contacts) ? c.contacts : []).length === 0 && <li style={{ color: '#8a8076' }}>None on record yet.</li>}
              {(Array.isArray(c.contacts) ? c.contacts : []).map((p, i) => (
                <li key={i}>{[p.name, p.email, p.phone].filter(Boolean).join(' · ') || '—'}</li>
              ))}
            </ul>

            {/* Evidence — the signals behind the ranking */}
            <div className="hub-card-kicker">Why they’re on the list</div>
            <ul style={{ margin: '6px 0 14px', paddingLeft: 16, fontSize: 13 }}>
              {(c.signals || []).length === 0 && <li style={{ color: '#8a8076' }}>No signals recorded.</li>}
              {(c.signals || []).map((s, i) => (
                <li key={i}>{s.evidence_note || s.kind} <span style={{ color: '#8a8076' }}>({fmtDate(s.occurred_at)})</span></li>
              ))}
            </ul>

            {/* Outcome ladder */}
            <div className="hub-card-kicker">Where it stands</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 6px' }}>
              {STAGES.map(([v, label]) => (
                <button key={v} onClick={() => setStage(v)} disabled={busy} style={{
                  ...btnGhost, padding: '4px 10px', fontSize: 12,
                  background: c.current_stage === v ? '#c75b39' : 'transparent',
                  color: c.current_stage === v ? '#fff' : '#6b6359',
                  borderColor: c.current_stage === v ? '#c75b39' : '#e4dcd2',
                }}>{label}</button>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: '#8a8076', margin: '0 0 14px' }}>
              Tap the step you’ve reached. Every step is kept — this history is what teaches LeadFinder which leads were worth finding.
            </p>

            {/* Call sheet */}
            <div className="hub-card-kicker">Call sheet</div>
            <div style={{ display: 'grid', gap: 8, margin: '8px 0 10px' }}>
              {(form || []).map((f) => (
                <label key={f.key} style={lbl}>{f.label}
                  {f.type === 'yesno' ? (
                    <select style={inp} value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}>
                      <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea style={{ ...inp, minHeight: 56 }} value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
                  ) : (
                    <input style={inp} value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
                  )}
                </label>
              ))}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason / note (kept with the decision)…" style={{ ...inp, minHeight: 48 }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button disabled={busy} onClick={() => sendSheet('accept')} style={btn}>Save sheet — worth pursuing</button>
                <button disabled={busy} onClick={() => sendSheet('reject')} style={btnGhost}>Save sheet — not viable</button>
                <button disabled={busy} onClick={() => sendSheet(undefined)} style={btnGhost}>Save without a verdict</button>
              </div>
            </div>

            {/* History */}
            {(c.outcomes || []).length > 0 && (
              <>
                <div className="hub-card-kicker">History</div>
                <ul style={{ margin: '6px 0 14px', paddingLeft: 16, fontSize: 12.5, color: '#6b6359' }}>
                  {c.outcomes.map((o, i) => (
                    <li key={i}>{STAGES.find(([v]) => v === o.stage)?.[1] || o.stage} — {fmtDate(o.recorded_at)}{o.reason ? ` (${o.reason})` : ''}</li>
                  ))}
                </ul>
              </>
            )}

            {err && <p style={{ fontSize: 13, color: '#B91C1C' }}>{err}</p>}
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

// ── Documents: what we need from the client, and an easy way to send it ─────
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
        The things LeadFinder needs from you. Most of these already exist inside your business — we would rather
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
              {['etenders_ocds', 'etenders_awards', 'html', 'rss', 'puppeteer', 'email', 'upload'].map((k) => <option key={k} value={k}>{KIND_LABELS[k] || k}</option>)}
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
