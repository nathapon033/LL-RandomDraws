import { useCallback, useEffect, useRef, useState } from 'react';
import Wheel from './Wheel.jsx';

const fmt = (n) => (n ?? 0).toLocaleString('en-AU');
const mask = (card) => (card && card.length > 6 ? `${card.slice(0, 3)}•••${card.slice(-3)}` : card);
const auDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-AU', {
        timeZone: 'Australia/Sydney',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';

const countdown = (iso, now) => {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return 'Drawing now…';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `in ${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s % 60)}`;
};

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Request failed (${res.status})`);
  return body;
}

const EXCEL_MAX_ROWS = 1_048_575; // Excel's 1,048,576 row limit minus the header

// Summary of a draft before it's drawn, with anything worth checking first
function DraftCard({ draft, summary }) {
  const checks = [];
  const sampled = draft.isTest && draft.localEntries > draft.entriesDrawnFrom;
  if (sampled) {
    checks.push({ ok: true, text: `Test mode: a random ${fmt(draft.entriesDrawnFrom)} of ${fmt(draft.localEntries)} entries.` });
  } else if (draft.localEntries != null) {
    checks.push(
      draft.localEntries === draft.entriesDrawnFrom
        ? { ok: true, text: `randomdraws.com counted ${fmt(draft.entriesDrawnFrom)} entries, matching the file.` }
        : {
            ok: false,
            text: `randomdraws.com counted ${fmt(draft.entriesDrawnFrom)} entries but the file has ${fmt(draft.localEntries)}.`,
          }
    );
  }
  if (draft.entriesDrawnFrom === EXCEL_MAX_ROWS || draft.localEntries === EXCEL_MAX_ROWS) {
    checks.push({
      ok: false,
      text: `${fmt(EXCEL_MAX_ROWS)} entries is exactly Excel's row limit. If the file was saved from Excel, entries may have been cut off.`,
    });
  }
  if (draft.emptyRowCount) checks.push({ ok: false, text: `${fmt(draft.emptyRowCount)} empty rows will be skipped.` });
  for (const w of draft.warnings || []) checks.push({ ok: false, text: w.message || String(w) });
  if (summary && draft.entriesFile && draft.entriesFile !== summary.entriesFile) {
    checks.push({ ok: false, text: `Made from ${draft.entriesFile}, not the file loaded now (${summary.entriesFile}).` });
  }

  return (
    <div className="draft-card">
      <div className="draw-row">
        <strong>{draft.name}</strong>
        <span className={`tag ${draft.isTest ? 'test' : 'live'}`}>{draft.isTest ? 'test' : 'live'}</span>
      </div>
      <p className="small muted">
        Draft created {auDateTime(draft.dateCreated)} · not drawn yet
        {draft.entriesFile ? ` · ${draft.entriesFile}` : ''}
      </p>
      <p className="small draft-id">
        <span className="muted">Draw ID</span> <span className="mono">{draft.drawId}</span>
        <button
          className="linkish small"
          onClick={() => navigator.clipboard?.writeText(draft.drawId).catch(() => {})}
          title="Copy draw ID"
        >
          Copy
        </button>
      </p>
      <p className="draft-count">{fmt(draft.entriesDrawnFrom)} entries</p>
      <ul className="plain checks">
        {checks.map((c, i) => (
          <li key={i} className={c.ok ? 'ok' : 'warn'}>
            {c.ok ? '✓' : '!'} {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  const wheel = useRef(null);
  const pending = useRef(null);
  const [summary, setSummary] = useState(null);
  const [account, setAccount] = useState({});
  const [mode, setMode] = useState('test');
  const [segments, setSegments] = useState(72);
  const [labels, setLabels] = useState([]);
  const [masked, setMasked] = useState(true);
  const [drawName, setDrawName] = useState('Liquor Legends Rewards Draw');
  const [status, setStatus] = useState('idle'); // idle | drawing | landing | done
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [pointer, setPointer] = useState(null);
  const [spinCount, setSpinCount] = useState(0);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [passcode, setPasscode] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null); // { ok, text }
  const fileInput = useRef(null);
  const [when, setWhen] = useState('now'); // now | schedule
  const [scheduleAt, setScheduleAt] = useState(''); // datetime-local value, PC local time
  const [notice, setNotice] = useState('');
  const [draws, setDraws] = useState([]); // scheduled + recent, both modes
  const [autoSpin, setAutoSpin] = useState(true);
  const [now, setNow] = useState(Date.now());
  const seenScheduled = useRef(new Set());
  const [draft, setDraft] = useState(null); // draft draw selected for drawing/scheduling
  const [creating, setCreating] = useState(false);

  const busy = status === 'drawing' || status === 'landing';
  const show = masked ? mask : (x) => x;

  const loadSample = useCallback(async (n) => {
    const sample = await api(`/api/sample?n=${n}`);
    setLabels(sample);
    return sample;
  }, []);

  useEffect(() => {
    api('/api/summary').then(setSummary).catch((e) => setError(e.message));
    ['test', 'live'].forEach((m) =>
      api(`/api/account?mode=${m}`)
        .then((a) => setAccount((prev) => ({ ...prev, [m]: a })))
        .catch((e) => setAccount((prev) => ({ ...prev, [m]: { error: e.message } })))
    );
  }, []);

  useEffect(() => {
    if (!busy) {
      setHighlight(null);
      loadSample(segments).catch((e) => setError(e.message));
    }
  }, [segments]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveCredits = account.live?.remainingCredits ?? 0;
  // GET /account leaves out trial credits (confirmed by RandomDraws support), so a
  // 0 balance doesn't block live draws. The API rejects the draw if none are left.
  const canCreate = summary && !busy && !creating && (mode === 'test' || !account.live?.error);
  const canDraw = draft && labels.length > 1 && !busy && !creating;
  const creditText = liveCredits > 0 ? `${fmt(liveCredits)} paid credits plus any trial credits` : 'trial credits only (not shown by the API)';

  const loadDraws = useCallback(async () => {
    const lists = await Promise.all(
      ['test', 'live'].map((m) => api(`/api/draws?mode=${m}`).catch(() => []))
    );
    setDraws(lists.flat());
  }, []);

  useEffect(() => {
    loadDraws();
  }, [loadDraws]);

  const drafts = draws
    .filter((d) => d.state === 'draft')
    .sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated));
  const scheduled = draws
    .filter((d) => d.state === 'scheduled')
    .sort((a, b) => new Date(a.scheduleDate) - new Date(b.scheduleDate));
  const recent = draws
    .filter((d) => d.state === 'drawn')
    .sort((a, b) => new Date(b.dateDrawn) - new Date(a.dateDrawn))
    .slice(0, 5);
  // Newest completed draw, preferring live (official) ones for the header link
  const latest = recent.find((d) => !d.isTest && d.certificateUrl) || recent.find((d) => d.certificateUrl);

  // Tick the countdowns, and poll RandomDraws while anything is scheduled
  useEffect(() => {
    if (!scheduled.length) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(loadDraws, 15000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [scheduled.length, loadDraws]);

  // Poll quickly once a scheduled draw is due so the reveal isn't delayed
  const due = scheduled.some((d) => new Date(d.scheduleDate).getTime() <= now);
  useEffect(() => {
    if (!due) return;
    const t = setTimeout(loadDraws, 3000);
    return () => clearTimeout(t);
  }, [due, now, loadDraws]);

  // Spin the wheel onto a scheduled draw's winner when it completes
  useEffect(() => {
    for (const d of draws) {
      if (d.state === 'scheduled') seenScheduled.current.add(d.drawId);
      else if (d.state === 'drawn' && seenScheduled.current.has(d.drawId)) {
        seenScheduled.current.delete(d.drawId);
        if (autoSpin && !busy) reveal(d);
        else setNotice(`"${d.name}" has been drawn. Press Reveal to show it on the wheel.`);
      }
    }
  }, [draws]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleTime = scheduleAt ? new Date(scheduleAt) : null;
  const scheduleValid = scheduleTime && scheduleTime.getTime() > Date.now() + 60_000;

  // Step 1: upload the entries file to RandomDraws as a draft (no credit used)
  async function createDraft() {
    setError('');
    setNotice('');
    setCreating(true);
    try {
      const d = await api('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, name: drawName }),
      });
      setDraft(d);
      setNotice('Draft created. Check the details below, then draw or schedule it.');
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
    loadDraws();
  }

  function selectDraft(d) {
    setDraft(d);
    setMode(d.mode);
    setDrawName(d.name);
    setError('');
    setNotice('');
  }

  const confirmDraft = (d, scheduleDate) =>
    api(`/api/draws/${d.drawId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: d.mode, ...(scheduleDate && { scheduleDate }) }),
    });

  // Step 2: draw the selected draft now, or schedule it
  function runDraw() {
    if (!draft) return;
    if (when === 'schedule') return scheduleDraw();
    if (draft.mode === 'live') {
      const ok = window.confirm(
        `Run LIVE draw "${draft.name}" on ${fmt(draft.entriesDrawnFrom)} entries now?\n\n` +
          `This uses 1 draw credit and the result is final.`
      );
      if (!ok) return;
    }
    const d = draft;
    setDraft(null);
    spin(() => confirmDraft(d)).then(loadDraws);
  }

  async function scheduleDraw() {
    if (!scheduleValid) return setError('Pick a time at least 1 minute from now.');
    const at = auDateTime(scheduleTime.toISOString());
    if (draft.mode === 'live') {
      const ok = window.confirm(
        `Schedule LIVE draw "${draft.name}" on ${fmt(draft.entriesDrawnFrom)} entries for ${at} (Sydney time)?\n\n` +
          `This uses 1 draw credit now. Cancelling before the draw refunds it.`
      );
      if (!ok) return;
    }
    setError('');
    setNotice('');
    setStatus('drawing');
    try {
      await confirmDraft(draft, scheduleTime.toISOString());
      setNotice(`Scheduled for ${at}. Keep this page open to see it on the wheel.`);
      setScheduleAt('');
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus('idle');
    }
    loadDraws(); // don't hold the controls while the list refreshes
  }

  async function deleteDraft(d) {
    if (!window.confirm(`Delete draft "${d.name}"? No credit has been used.`)) return;
    try {
      await api(`/api/draws/${d.drawId}?mode=${d.mode}`, { method: 'DELETE' });
      if (draft?.drawId === d.drawId) setDraft(null);
      setNotice(`Deleted draft "${d.name}".`);
    } catch (e) {
      setError(e.message);
    }
    loadDraws();
  }

  // Show a completed draw on the wheel (e.g. a scheduled one)
  function reveal(d) {
    spin(() => api(`/api/draws/${d.drawId}?mode=${d.mode}`));
  }

  async function cancelScheduled(d) {
    const ok = window.confirm(
      `Cancel "${d.name}" scheduled for ${auDateTime(d.scheduleDate)}?` +
        (d.isTest ? '' : '\n\nThe draw credit will be refunded.')
    );
    if (!ok) return;
    try {
      await api(`/api/draws/${d.drawId}?mode=${d.mode}`, { method: 'DELETE' });
      seenScheduled.current.delete(d.drawId);
      setNotice(`Cancelled "${d.name}".`);
    } catch (e) {
      setError(e.message);
    }
    loadDraws();
  }

  // Spin until getDraw() resolves, then land on its main prize winner
  async function spin(getDraw) {
    setError('');
    setNotice('');
    setResult(null);
    setHighlight(null);
    setOverlayOpen(false);
    setSpinCount((c) => c + 1);
    setStatus('drawing');

    let current = labels;
    try {
      current = await loadSample(segments);
    } catch {
      /* keep the current labels */
    }
    wheel.current.start();

    try {
      const draw = await getDraw();
      const major = draw.prizes?.find((p) => !p.isReserve)?.winners[0];
      if (!major) throw new Error('The draw returned no winner');

      // Put the drawn card on a random segment and land the wheel there
      const index = Math.floor(Math.random() * current.length);
      const next = [...current];
      next[index] = major.card;
      setLabels(next);
      pending.current = { ...draw, major, index, spin: spinCount + 1 };
      setResult(pending.current);
      setStatus('landing');
      wheel.current.landOn(index);
    } catch (e) {
      wheel.current.stop();
      setStatus('idle');
      setError(e.message);
    }
  }

  const onSettle = (index) => {
    setHighlight(index);
    setStatus('done');
    setOverlayOpen(true);
    const r = pending.current;
    if (r) setHistory((h) => [r, ...h].slice(0, 10));
    if (r?.mode === 'live') {
      api('/api/account?mode=live').then((a) => setAccount((prev) => ({ ...prev, live: a }))).catch(() => {});
    }
  };

  // Swap the entries file used for draws; the server checks the passcode
  async function changeEntries(file) {
    setUploading(true);
    setUploadMsg(null);
    try {
      const next = await api(file ? '/api/entries' : '/api/entries/default', {
        method: 'POST',
        headers: file
          ? { 'Content-Type': 'text/csv', 'X-Passcode': passcode, 'X-Filename': encodeURIComponent(file.name) }
          : { 'X-Passcode': passcode },
        body: file || undefined,
      });
      setSummary(next);
      setResult(null);
      setHighlight(null);
      setOverlayOpen(false);
      await loadSample(segments);
      setUploadMsg({
        ok: true,
        text: `Now using ${file ? file.name : next.entriesFile}: ${fmt(next.entries)} entries, ${fmt(next.uniqueCards)} members.`,
      });
      setUploadFile(null);
      setPasscode('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (e) {
      setUploadMsg({ ok: false, text: e.message });
    } finally {
      setUploading(false);
    }
  }

  const reserves = result?.prizes.filter((p) => p.isReserve).flatMap((p) => p.winners) ?? [];
  const majorPrize = result?.prizes.find((p) => !p.isReserve);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">LL</span>
          <div>
            <h1>Rewards Prize Draw</h1>
            <p>Liquor Legends · certified by randomdraws.com</p>
          </div>
        </div>
        <div className="topbar-right">
          {latest && (
            <a className="cert-link" href={latest.certificateUrl} target="_blank" rel="noreferrer">
              <span className="muted">Latest {latest.isTest ? 'test ' : ''}draw certificate</span>
              <span>
                #{latest.drawNumber} · {auDateTime(latest.dateDrawn)} ↗
              </span>
            </a>
          )}
          <div className={`mode-pill ${mode}`}>{mode === 'live' ? 'LIVE' : 'TEST MODE'}</div>
        </div>
      </header>

      <main className="layout">
        {/* ---------- Left: data + controls ---------- */}
        <aside className="panel">
          <section>
            <h2>Entries</h2>
            {summary ? (
              <>
                <div className="stats">
                  <div>
                    <span className="stat">{fmt(summary.entries)}</span>
                    <span className="stat-label">entries</span>
                  </div>
                  <div>
                    <span className="stat">{fmt(summary.uniqueCards)}</span>
                    <span className="stat-label">Rewards members</span>
                  </div>
                </div>
                <p className="muted small">
                  {summary.entriesFile} · {(summary.sizeBytes / 1048576).toFixed(1)} MB
                  {summary.isUpload && <span className="tag test">uploaded</span>}
                </p>

                <button className="linkish small" onClick={() => setUploadOpen((o) => !o)} disabled={busy}>
                  {uploadOpen ? 'Hide upload' : 'Upload new entries file'}
                </button>
                {uploadOpen && (
                  <div className="upload">
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".csv,.txt,.tsv,text/csv"
                      onChange={(e) => setUploadFile(e.target.files[0] || null)}
                      disabled={uploading || busy}
                    />
                    <p className="muted small">CSV with a header row including Reward_Card_ID, one row per entry. Max 100 MB.</p>
                    <label className="field">
                      <span>Passcode</span>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={passcode}
                        onChange={(e) => setPasscode(e.target.value)}
                        disabled={uploading || busy}
                      />
                    </label>
                    <button
                      className="secondary"
                      onClick={() => changeEntries(uploadFile)}
                      disabled={!uploadFile || !passcode || uploading || busy}
                    >
                      {uploading ? 'Uploading…' : 'Upload & use this file'}
                    </button>
                    {summary.isUpload && (
                      <button
                        className="linkish small"
                        onClick={() => changeEntries(null)}
                        disabled={!passcode || uploading || busy}
                      >
                        Switch back to {summary.defaultFile}
                      </button>
                    )}
                    {uploadMsg && <p className={`small ${uploadMsg.ok ? 'ok' : 'error'}`}>{uploadMsg.text}</p>}
                  </div>
                )}
                <h3>Prizes</h3>
                <ul className="plain">
                  {summary.prizes.map((p) => (
                    <li key={p.id}>
                      {p.description} × {p.quantity}
                      {p.reserves ? ` (+${p.reserves} reserve)` : ''}
                    </li>
                  ))}
                </ul>
                <h3>Most entries</h3>
                <ol className="plain small">
                  {summary.topCards.map((t) => (
                    <li key={t.card}>
                      {show(t.card)} <span className="muted">· {fmt(t.entries)}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="muted">Loading entries…</p>
            )}
          </section>

          <section>
            <h2>Draw</h2>
            <label className="field">
              <span>Draw name</span>
              <input
                value={drawName}
                maxLength={50}
                onChange={(e) => setDrawName(e.target.value)}
                disabled={busy || creating || !!draft}
              />
            </label>

            <div className="segmented" role="radiogroup" aria-label="Mode">
              {['test', 'live'].map((m) => (
                <button
                  key={m}
                  className={mode === m ? 'on' : ''}
                  onClick={() => setMode(m)}
                  disabled={busy || creating || !!draft}
                >
                  {m === 'test' ? 'Test' : 'Live'}
                </button>
              ))}
            </div>
            <p className="muted small">
              {mode === 'test'
                ? summary && summary.entries <= 20
                  ? `Test mode is free and uploads all ${fmt(summary.entries)} entries. Results are not official.`
                  : 'Test mode is free but the API only allows 20 entries, so it draws from a random 20-entry sample. Results are not official.'
                : account.live?.error
                  ? `Account error: ${account.live.error}`
                  : `Uploads all ${fmt(summary?.entries)} entries and uses 1 credit. Available: ${creditText}.`}
            </p>

            <label className="field">
              <span>Wheel segments: {segments}</span>
              <input
                type="range"
                min="12"
                max="120"
                step="12"
                value={segments}
                onChange={(e) => setSegments(Number(e.target.value))}
                disabled={busy}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
              Mask card numbers on the wheel
            </label>

            {!draft ? (
              <>
                <button className="primary" onClick={createDraft} disabled={!canCreate}>
                  {creating ? 'Creating draw…' : '1. Create draw'}
                </button>
                <p className="muted small step-hint">
                  Uploads {summary ? summary.entriesFile : 'the entries file'} to randomdraws.com as a draft. No credit is
                  used until you draw or schedule it.
                </p>
              </>
            ) : (
              <DraftCard draft={draft} summary={summary} />
            )}

            {draft && (
              <>
            <div className="segmented" role="radiogroup" aria-label="When">
              {[
                ['now', 'Draw now'],
                ['schedule', 'Schedule'],
              ].map(([k, label]) => (
                <button key={k} className={when === k ? 'on' : ''} onClick={() => setWhen(k)} disabled={busy}>
                  {label}
                </button>
              ))}
            </div>
            {when === 'schedule' && (
              <label className="field">
                <span>Draw at (this PC&apos;s time)</span>
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000 + 120000).toISOString().slice(0, 16)}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  disabled={busy}
                />
                {scheduleTime && (
                  <span className={scheduleValid ? 'small' : 'small error'}>
                    {scheduleValid
                      ? `${auDateTime(scheduleTime.toISOString())} Sydney time`
                      : 'Must be at least 1 minute from now'}
                  </span>
                )}
              </label>
            )}

            <button
              className="primary"
              onClick={runDraw}
              disabled={!canDraw || (when === 'schedule' && !scheduleValid)}
            >
              {status === 'drawing'
                ? when === 'schedule'
                  ? 'Scheduling…'
                  : 'Drawing…'
                : status === 'landing'
                  ? 'Spinning…'
                  : when === 'schedule'
                    ? '2. Schedule draw'
                    : '2. Spin & draw'}
            </button>
            <div className="draft-actions">
              <button className="linkish small" onClick={() => setDraft(null)} disabled={busy}>
                Back (keep draft)
              </button>
              <button className="linkish small" onClick={() => deleteDraft(draft)} disabled={busy}>
                Delete draft
              </button>
            </div>
              </>
            )}
            {error && <p className="error small">{error}</p>}
            {notice && <p className="ok small">{notice}</p>}
          </section>
        </aside>

        {/* ---------- Centre: wheel with overlays ---------- */}
        <section className="stage">
          <div className="wheel-wrap">
            <div className="ov ov-spin">{spinCount ? `Spin #${spinCount}` : 'Ready'}</div>
            <div className={`ov ov-pointer ${busy ? 'live' : ''}`}>
              {pointer != null && labels[pointer] ? show(labels[pointer]) : '—'}
            </div>
            <div className="ov ov-count">
              {summary ? `${fmt(summary.entries)} entries · ${labels.length} shown` : ''}
            </div>

            {labels.length > 1 && (
              <Wheel
                ref={wheel}
                labels={labels}
                highlight={highlight}
                format={show}
                onTick={setPointer}
                onSettle={onSettle}
              />
            )}

            {overlayOpen && result && (
              <div className="ov-winner" onClick={() => setOverlayOpen(false)}>
                <div className="winner-card" onClick={(e) => e.stopPropagation()}>
                  <p className="eyebrow">{majorPrize?.description || 'Winner'}</p>
                  <p className="winner-number">{show(result.major.card)}</p>
                  <p className="winner-meta">
                    Entry #{fmt(result.major.entryNo)} · OID {result.major.oid}
                    {result.major.cardEntries != null && ` · ${fmt(result.major.cardEntries)} entries held`}
                  </p>
                  {result.isTest && <p className="badge">Test draw, not official</p>}
                  <button onClick={() => setOverlayOpen(false)}>Show wheel</button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ---------- Right: results ---------- */}
        <aside className="panel">
          <section>
            <h2>Result</h2>
            {!result || status !== 'done' ? (
              <p className="muted">{busy ? 'Waiting for randomdraws.com…' : 'No draw yet.'}</p>
            ) : (
              <>
                <div className="result-main">
                  <span className="muted small">{majorPrize?.description}</span>
                  <span className="result-card">{result.major.card}</span>
                  <span className="small">
                    OID {result.major.oid} · entry #{fmt(result.major.entryNo)}
                  </span>
                  {result.major.cardEntries != null && (
                    <span className="small muted">
                      Card holds {fmt(result.major.cardEntries)} of {fmt(summary?.entries)} entries
                    </span>
                  )}
                </div>
                {reserves.length > 0 && (
                  <>
                    <h3>Reserves</h3>
                    <ol className="plain small">
                      {reserves.map((w) => (
                        <li key={w.row}>
                          {w.card} <span className="muted">· OID {w.oid}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                <dl className="meta small">
                  <dt>Draw no.</dt>
                  <dd>{result.drawNumber}</dd>
                  <dt>Drawn</dt>
                  <dd>{auDateTime(result.dateDrawn)}</dd>
                  <dt>Pool</dt>
                  <dd>{fmt(result.entriesDrawnFrom)} entries</dd>
                  <dt>Draw ID</dt>
                  <dd className="mono">{result.drawId}</dd>
                </dl>
                {result.certificateUrl && (
                  <a className="link" href={result.certificateUrl} target="_blank" rel="noreferrer">
                    View draw certificate ↗
                  </a>
                )}
              </>
            )}
          </section>

          {drafts.length > 0 && (
            <section>
              <h2>Drafts</h2>
              <ul className="plain draw-list">
                {drafts.map((d) => (
                  <li key={d.drawId} className={draft?.drawId === d.drawId ? 'selected' : ''}>
                    <div className="draw-row">
                      <strong>{d.name}</strong>
                      <span className={`tag ${d.isTest ? 'test' : 'live'}`}>{d.isTest ? 'test' : 'live'}</span>
                    </div>
                    <div className="small muted">
                      {auDateTime(d.dateCreated)} · {fmt(d.entriesDrawnFrom)} entries
                    </div>
                    <div className="draw-row">
                      <button
                        className="linkish small"
                        onClick={() => selectDraft(d)}
                        disabled={busy || draft?.drawId === d.drawId}
                      >
                        {draft?.drawId === d.drawId ? 'Selected' : 'Select'}
                      </button>
                      <button className="linkish small" onClick={() => deleteDraft(d)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2>Scheduled draws</h2>
            {scheduled.length === 0 ? (
              <p className="muted small">Nothing scheduled.</p>
            ) : (
              <ul className="plain draw-list">
                {scheduled.map((d) => (
                  <li key={d.drawId}>
                    <div className="draw-row">
                      <strong>{d.name}</strong>
                      <span className={`tag ${d.isTest ? 'test' : 'live'}`}>{d.isTest ? 'test' : 'live'}</span>
                    </div>
                    <div className="small muted">
                      {auDateTime(d.scheduleDate)} · {fmt(d.entriesDrawnFrom)} entries
                    </div>
                    <div className="draw-row">
                      <span className="countdown">{countdown(d.scheduleDate, now)}</span>
                      <button className="linkish small" onClick={() => cancelScheduled(d)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <label className="check small">
              <input type="checkbox" checked={autoSpin} onChange={(e) => setAutoSpin(e.target.checked)} />
              Spin the wheel automatically when a scheduled draw completes
            </label>
          </section>

          {recent.length > 0 && (
            <section>
              <h2>Recent draws</h2>
              <ul className="plain draw-list">
                {recent.map((d) => (
                  <li key={d.drawId}>
                    <div className="draw-row">
                      <strong>
                        #{d.drawNumber} {d.name}
                      </strong>
                      <span className={`tag ${d.isTest ? 'test' : 'live'}`}>{d.isTest ? 'test' : 'live'}</span>
                    </div>
                    <div className="draw-row">
                      <span className="small muted">
                        {auDateTime(d.dateDrawn)}
                        {d.scheduleDate ? ' · scheduled' : ''}
                      </span>
                      <span className="row-actions">
                        {d.certificateUrl && (
                          <a className="link small" href={d.certificateUrl} target="_blank" rel="noreferrer">
                            Certificate ↗
                          </a>
                        )}
                        <button className="linkish small" onClick={() => reveal(d)} disabled={busy}>
                          Reveal
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {history.length > 0 && (
            <section>
              <h2>This session</h2>
              <ul className="plain small history">
                {history.map((h) => (
                  <li key={h.drawId}>
                    <span>#{h.spin}</span> {show(h.major.card)}
                    <span className={`tag ${h.isTest ? 'test' : 'live'}`}>{h.isTest ? 'test' : 'live'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
