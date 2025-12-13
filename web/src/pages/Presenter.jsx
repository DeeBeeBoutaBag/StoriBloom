// web/src/pages/Presenter.jsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE } from '../api.js';
import PresenterHUD from '../components/PresenterHUD.jsx';
import PresenterVotingPanel from '../components/PresenterVotingPanel.jsx';

const STAGES = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
];

function useSiteIdFromUrl() {
  const { siteId: siteIdParam } = useParams();
  const [siteId, setSiteId] = useState(() => {
    const fromUrl = (siteIdParam || '').toUpperCase();
    if (fromUrl) {
      sessionStorage.setItem('presenter_siteId', fromUrl);
      return fromUrl;
    }
    return (sessionStorage.getItem('presenter_siteId') || '').toUpperCase();
  });

  useEffect(() => {
    if (siteId) {
      sessionStorage.setItem('presenter_siteId', siteId.toUpperCase());
    }
  }, [siteId]);

  return [siteId, setSiteId];
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteIdFromUrl();
  const [rooms, setRooms] = useState([]);
  const [gallery, setGallery] = useState([]);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [error, setError] = useState('');
  const [galleryError, setGalleryError] = useState('');

  const canFetch = useMemo(() => !!(siteId && siteId.trim().length), [siteId]);

  // ── Auth bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    ensureGuest().catch((e) => console.warn('[Presenter] ensureGuest failed', e));
  }, []);

  // ── Fetch rooms list ────────────────────────────────────────────────────
  const loadRooms = useCallback(async () => {
    if (!canFetch) return;
    setLoading(true);
    setError('');
    try {
      const url = new URL(`${API_BASE}/presenter/rooms`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());

      const res = await fetch(url.toString(), {
        ...(await authHeaders()),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `rooms fetch failed (${res.status})`);
      }

      const j = await res.json();
      const list = Array.isArray(j.rooms) ? j.rooms : [];
      setRooms(list);
    } catch (err) {
      console.error('[Presenter] rooms load error:', err);
      setRooms([]);
      setError(err.message || 'Could not load rooms.');
    } finally {
      setLoading(false);
    }
  }, [siteId, canFetch]);

  // ── Fetch gallery (closed abstracts) ────────────────────────────────────
  const loadGallery = useCallback(async () => {
    if (!canFetch) return;
    setGalleryLoading(true);
    setGalleryError('');
    try {
      const url = new URL(`${API_BASE}/presenter/gallery`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());

      const res = await fetch(url.toString(), {
        ...(await authHeaders()),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `gallery fetch failed (${res.status})`);
      }

      const j = await res.json();
      const items = Array.isArray(j.items) ? j.items : [];

      // normalize sort: newest first
      items.sort((a, b) => (Number(b.closedAt || 0) || 0) - (Number(a.closedAt || 0) || 0));
      setGallery(items);
    } catch (err) {
      console.error('[Presenter] gallery load error:', err);
      setGallery([]);
      setGalleryError(err.message || 'Could not load gallery.');
    } finally {
      setGalleryLoading(false);
    }
  }, [siteId, canFetch]);

  useEffect(() => {
    if (!canFetch) return;
    loadRooms();
    const id = setInterval(loadRooms, 2500);
    return () => clearInterval(id);
  }, [canFetch, loadRooms]);

  // Load gallery when opened, then keep it fresh while open
  useEffect(() => {
    if (!canFetch || !galleryOpen) return;
    loadGallery();
    const id = setInterval(loadGallery, 5000);
    return () => clearInterval(id);
  }, [canFetch, galleryOpen, loadGallery]);

  // ── Simple POST helper for controls ─────────────────────────────────────
  async function post(path, body) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        ...(await authHeaders()),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Action failed (${res.status})`);
      }
      return true;
    } catch (err) {
      console.error('[Presenter] action error', err);
      alert(err.message || 'Action failed');
      return false;
    }
  }

  const next = (roomId) => post(`/rooms/${roomId}/next`);
  const extend = (roomId, secs = 120) => post(`/rooms/${roomId}/extend`, { by: secs });
  const redo = (roomId) => post(`/rooms/${roomId}/redo`);
  const lock = (roomId) => post(`/rooms/${roomId}/lock`, { inputLocked: true });
  const unlock = (roomId) => post(`/rooms/${roomId}/lock`, { inputLocked: false });

  const startVote = (roomId) => post(`/rooms/${roomId}/vote/start`);
  const closeVote = (roomId) => post(`/rooms/${roomId}/vote/close`);

  // NEW: presenter can close FINAL room (writes abstract + locks)
  const closeFinal = (roomId) => post(`/rooms/${roomId}/final/close`);

  // ── Derived summary for header ──────────────────────────────────────────
  const stageSummary = useMemo(() => {
    const byStage = {};
    for (const s of STAGES) byStage[s] = 0;
    rooms.forEach((r) => {
      const s = r.stage || 'LOBBY';
      if (!byStage[s]) byStage[s] = 0;
      byStage[s] += 1;
    });
    return byStage;
  }, [rooms]);

  const estimatedSeats = useMemo(
    () => rooms.reduce((sum, r) => sum + (Number(r.seats) || 0), 0),
    [rooms]
  );

  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => (a.index || 0) - (b.index || 0)),
    [rooms]
  );

  const closedCount = useMemo(
    () => sortedRooms.filter((r) => (r.stage || '') === 'CLOSED').length,
    [sortedRooms]
  );

  function formatWhen(ms) {
    const n = Number(ms || 0);
    if (!n) return '';
    try {
      return new Date(n).toLocaleString();
    } catch {
      return '';
    }
  }

  async function copyToClipboard(text) {
    try {
      if (!text) return;
      await navigator.clipboard.writeText(text);
      alert('Copied to clipboard ✅');
    } catch (e) {
      console.warn('[Presenter] clipboard failed', e);
      alert('Copy failed — your browser may block clipboard access.');
    }
  }

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />

      <div className="presenter-wrap">
        {/* Top header strip */}
        <header className="presenter-head glass">
          <div>
            <div className="presenter-title">Presenter HUD</div>
            <div className="presenter-subtitle">
              Live control panel for <b>{siteId || '—'}</b> rooms.
            </div>
          </div>

          <div className="presenter-site">
            <label htmlFor="presenter-site-input">SITE ID</label>
            <input
              id="presenter-site-input"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value.toUpperCase())}
              placeholder="E1 / C1 / W1"
            />
          </div>

          <div className="presenter-meta">
            <div>
              Hotkeys on Room 1: <b>N</b> Next, <b>+</b> +2m, <b>R</b> Redo
            </div>
            <div>
              Status: <span className="pill pill-live">{canFetch ? 'Live' : 'Idle'}</span>
            </div>
            <div>
              Rooms: <b>{rooms.length}</b>
            </div>
            <div>
              Participants: <b>{estimatedSeats}</b>
            </div>
            <div>
              Closed: <b>{closedCount}</b>
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button
              type="button"
              className={`btn ${galleryOpen ? 'primary' : ''}`}
              onClick={() => setGalleryOpen((o) => !o)}
              disabled={!canFetch}
              title="Show all closed abstracts for this site"
            >
              {galleryOpen ? 'Hide Gallery' : 'Open Gallery'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                loadRooms();
                if (galleryOpen) loadGallery();
              }}
              disabled={!canFetch}
              title="Manual refresh"
            >
              Refresh
            </button>
          </div>
        </header>

        {/* Stage summary bar */}
        <section className="presenter-stage-strip glass">
          {STAGES.map((s) => (
            <div key={s} className="presenter-stage-pill">
              <span>{s.replace('_', ' ')}</span>
              <b>{stageSummary[s] || 0}</b>
              <span className="presenter-stage-label">rooms</span>
            </div>
          ))}
        </section>

        {/* Gallery (closed abstracts) */}
        {galleryOpen && (
          <section className="presenter-gallery glass" style={{ marginTop: 12, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>
                🖼️ Site Gallery — closed abstracts ({gallery.length})
              </div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                Pulls from <code>/presenter/gallery</code> (gallery table if present, else room
                fallback).
              </div>
              <div style={{ marginLeft: 'auto' }}>
                {galleryLoading ? (
                  <span className="pill">Loading…</span>
                ) : galleryError ? (
                  <span className="pill warn">{galleryError}</span>
                ) : (
                  <span className="pill pill-live">Live</span>
                )}
              </div>
            </div>

            {gallery.length === 0 && !galleryLoading && !galleryError && (
              <div style={{ marginTop: 10, opacity: 0.8 }}>
                No closed abstracts yet for <b>{siteId}</b>.
              </div>
            )}

            {gallery.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: 10,
                  marginTop: 10,
                }}
              >
                {gallery.map((it) => (
                  <div
                    key={`${it.roomId}-${it.closedAt || ''}`}
                    className="glass"
                    style={{
                      borderRadius: 14,
                      padding: 12,
                      border: '1px solid rgba(148,163,184,0.22)',
                      background: 'rgba(15,23,42,0.6)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 800 }}>
                        Room {String(it.roomId || '').split('-')[1] || it.index || '—'}
                      </div>
                      <div style={{ opacity: 0.75, fontSize: 12 }}>{formatWhen(it.closedAt)}</div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
                      <span style={{ opacity: 0.75 }}>Topic:</span> <b>{it.topic || '—'}</b>
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.35,
                        fontSize: 12,
                        maxHeight: 200,
                        overflowY: 'auto',
                        padding: 10,
                        borderRadius: 10,
                        border: '1px solid rgba(148,163,184,0.18)',
                        background: 'rgba(2,6,23,0.55)',
                      }}
                    >
                      {it.abstract || '(no abstract saved)'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => copyToClipboard(it.abstract || '')}
                        disabled={!it.abstract}
                      >
                        Copy Abstract
                      </button>
                      <a
                        className="btn"
                        href={`/room/${it.roomId}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open live room transcript view"
                      >
                        Open Room
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Error / empty */}
        {error && <div className="presenter-empty glass">{error}</div>}

        {!error && !loading && canFetch && rooms.length === 0 && (
          <div className="presenter-empty glass">
            No rooms returned for site <b>{siteId}</b>.<br />
            Check that your codes point to this site ID and that{' '}
            <code>/presenter/rooms?siteId={siteId}</code> is returning rooms.
          </div>
        )}

        {/* Rooms grid */}
        <main className="rooms-grid">
          {sortedRooms.map((r) => {
            const stageNow = r.stage || 'LOBBY';
            const isClosed = stageNow === 'CLOSED';
            const inFinal = stageNow === 'FINAL';

            const topic = r.topic || '—';
            const draftV = Number(r.draftVersion || 0);
            const hasFinal = (r.finalAbstract || '').trim().length > 0;

            return (
              <article key={r.id} className="room-card glass">
                <header className="room-card-head">
                  <div>
                    <div className="room-card-title">
                      Room {r.index} {siteId}
                    </div>
                    <div className="room-card-sub">
                      {stageNow === 'LOBBY'
                        ? 'Waiting for participants.'
                        : isClosed
                        ? 'Session complete — abstract ready.'
                        : inFinal
                        ? 'Final stage — closing soon.'
                        : 'Stage in progress.'}
                    </div>
                  </div>

                  <div className="room-card-stage">
                    <span className="pill pill-stage">{stageNow}</span>
                    <span className={`pill pill-status ${isClosed ? 'pill-closed' : ''}`}>
                      {isClosed ? 'CLOSED' : 'OPEN'}
                    </span>
                  </div>
                </header>

                <section className="room-card-meta">
                  <div>
                    <span className="label">Seats</span> {r.seats ?? '—'}
                  </div>
                  <div>
                    <span className="label">Locked</span> {r.inputLocked ? 'Yes' : 'No'}
                  </div>
                  <div>
                    <span className="label">Draft</span>{' '}
                    {draftV ? `v${draftV}` : '—'}
                  </div>
                  <div className="room-card-topic">
                    <span className="label">Topic</span> {topic}
                  </div>
                </section>

                {/* Final preview (if closed or saved) */}
                {(isClosed || hasFinal) && (
                  <section
                    className="room-card-final"
                    style={{
                      marginTop: 10,
                      borderRadius: 12,
                      padding: 10,
                      background: 'rgba(2,6,23,0.45)',
                      border: '1px solid rgba(148,163,184,0.18)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>🏁 Final Abstract</div>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => copyToClipboard(r.finalAbstract || '')}
                        disabled={!r.finalAbstract}
                        style={{ padding: '6px 10px', fontSize: 12 }}
                      >
                        Copy
                      </button>
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.35,
                        fontSize: 12,
                        maxHeight: 160,
                        overflowY: 'auto',
                      }}
                    >
                      {r.finalAbstract ? r.finalAbstract : '(no final abstract saved)'}
                    </div>
                  </section>
                )}

                {r.vote && (
                  <section className="room-card-vote">
                    <div>
                      <span className="label">Voting</span> {r.vote.open ? 'Open' : 'Closed'}
                    </div>
                    <div>
                      <span className="label">Ballots</span> {r.vote.total ?? 0}
                    </div>
                    {r.vote.tallies && (
                      <details>
                        <summary> Tallies</summary>
                        <ul>
                          {Object.entries(r.vote.tallies).map(([k, v]) => (
                            <li key={k}>
                              #{k}: {v}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </section>
                )}

                <section className="room-card-controls">
                  <div className="room-card-row">
                    <button type="button" onClick={() => next(r.id)} disabled={isClosed}>
                      Next
                    </button>
                    <button type="button" onClick={() => extend(r.id, 120)} disabled={isClosed}>
                      +2m
                    </button>
                    <button type="button" onClick={() => redo(r.id)} disabled={isClosed}>
                      Redo
                    </button>
                    <button type="button" onClick={() => lock(r.id)} className="warn" disabled={isClosed}>
                      Lock
                    </button>
                    <button type="button" onClick={() => unlock(r.id)} className="safe" disabled={isClosed}>
                      Unlock
                    </button>
                  </div>

                  <div className="room-card-row">
                    <button type="button" onClick={() => startVote(r.id)} disabled={isClosed}>
                      Start Voting
                    </button>
                    <button
                      type="button"
                      onClick={() => closeVote(r.id)}
                      className="warn"
                      disabled={isClosed}
                    >
                      Close &amp; Lock Topic
                    </button>

                    <button
                      type="button"
                      onClick={() => closeFinal(r.id)}
                      className="warn"
                      disabled={!inFinal || isClosed}
                      title="FINAL stage only — posts final abstract and locks the room"
                    >
                      Close Room
                    </button>

                    <a
                      href={`/room/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="room-open-link"
                    >
                      Open Room View
                    </a>
                  </div>
                </section>

                <section className="room-card-voting-panel">
                  <PresenterVotingPanel roomId={r.id} isPresenter />
                </section>
              </article>
            );
          })}
        </main>
      </div>

      <PresenterHUD siteId={siteId} rooms={sortedRooms} />
    </>
  );
}
