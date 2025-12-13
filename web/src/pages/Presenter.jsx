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

// Merge authHeaders() with presenter role header (fixes presenter_only)
async function presenterAuthHeaders() {
  const base = await authHeaders();
  const mergedHeaders = {
    ...(base.headers || {}),
    'x-user-role': 'PRESENTER',
  };
  return {
    ...base,
    headers: mergedHeaders,
  };
}

function formatClosedAt(ms) {
  const n = Number(ms || 0);
  if (!n) return '';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '';
  }
}

async function copyToClipboard(text) {
  const t = String(text || '');
  if (!t) return false;

  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    // fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteIdFromUrl();
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Gallery state
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState('');
  const [galleryItems, setGalleryItems] = useState([]);
  const [galleryCopiedRoom, setGalleryCopiedRoom] = useState('');

  const canFetch = useMemo(() => !!(siteId && siteId.trim().length), [siteId]);

  // ── Auth bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    ensureGuest().catch((e) => console.warn('[Presenter] ensureGuest failed', e));
    try {
      sessionStorage.setItem('role', 'PRESENTER');
    } catch {}
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
        ...(await presenterAuthHeaders()),
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

  useEffect(() => {
    if (!canFetch) return;
    loadRooms();
    const id = setInterval(loadRooms, 2500);
    return () => clearInterval(id);
  }, [canFetch, loadRooms]);

  // ── Simple POST helper for controls ─────────────────────────────────────
  async function post(path, body) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        ...(await presenterAuthHeaders()),
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

  // NEW: close FINAL room from presenter dashboard
  const closeFinal = (roomId) => post(`/rooms/${roomId}/final/close`);

  // ── Gallery fetch ───────────────────────────────────────────────────────
  const loadGallery = useCallback(async () => {
    if (!canFetch) return;
    setGalleryLoading(true);
    setGalleryError('');
    setGalleryCopiedRoom('');
    try {
      const url = new URL(`${API_BASE}/presenter/gallery`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());

      const res = await fetch(url.toString(), {
        ...(await presenterAuthHeaders()),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `gallery fetch failed (${res.status})`);
      }

      const j = await res.json();
      const items = Array.isArray(j.items) ? j.items : [];

      // Normalize so UI always has: roomId, topic, abstract, closedAt
      const normalized = items
        .map((it) => ({
          siteId: (it.siteId || siteId || '').toUpperCase(),
          roomId: it.roomId || it.id || '',
          index: Number(it.index || 0) || null,
          topic: it.topic || '',
          abstract: it.abstract || it.finalAbstract || '',
          closedAt: it.closedAt || it.finalCompletedAt || null,
          closedBy: it.closedBy || '',
        }))
        .filter((it) => it.roomId);

      // Sort newest first
      normalized.sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0));

      setGalleryItems(normalized);
    } catch (err) {
      console.error('[Presenter] gallery load error:', err);
      setGalleryItems([]);
      setGalleryError(err.message || 'Could not load gallery.');
    } finally {
      setGalleryLoading(false);
    }
  }, [siteId, canFetch]);

  // When opening the modal, load immediately
  useEffect(() => {
    if (!galleryOpen) return;
    loadGallery();
  }, [galleryOpen, loadGallery]);

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
              Status:{' '}
              <span className="pill pill-live">{canFetch ? 'Live' : 'Idle'}</span>
            </div>
            <div>
              Rooms: <b>{rooms.length}</b>
            </div>
            <div>
              Participants: <b>{estimatedSeats}</b>
            </div>

            {/* NEW: Gallery button */}
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setGalleryOpen(true)}
                disabled={!canFetch}
              >
                📚 Gallery
              </button>
            </div>
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
            const isClosed = (r.stage || '') === 'CLOSED';
            const isFinal = (r.stage || '') === 'FINAL';

            return (
              <article key={r.id} className="room-card glass">
                <header className="room-card-head">
                  <div>
                    <div className="room-card-title">
                      Room {r.index} {siteId}
                    </div>
                    <div className="room-card-sub">
                      {r.stage === 'LOBBY'
                        ? 'Waiting for participants.'
                        : isClosed
                        ? 'Session complete — abstract ready.'
                        : 'Stage in progress.'}
                    </div>
                  </div>

                  <div className="room-card-stage">
                    <span className="pill pill-stage">{r.stage || '—'}</span>
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
                  <div className="room-card-topic">
                    <span className="label">Topic</span> {r.topic || '—'}
                  </div>
                  <div>
                    <span className="label">Draft</span>{' '}
                    {Number(r.draftVersion || 0) ? `v${Number(r.draftVersion || 0)}` : '—'}
                  </div>
                  {isClosed && (
                    <div>
                      <span className="label">Closed</span>{' '}
                      {formatClosedAt(r.closedAt) || '—'}
                      {r.closedReason ? ` (${r.closedReason})` : ''}
                    </div>
                  )}
                </section>

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
                    <button type="button" onClick={() => next(r.id)}>
                      Next
                    </button>
                    <button type="button" onClick={() => extend(r.id, 120)}>
                      +2m
                    </button>
                    <button type="button" onClick={() => redo(r.id)}>
                      Redo
                    </button>
                    <button type="button" onClick={() => lock(r.id)} className="warn">
                      Lock
                    </button>
                    <button type="button" onClick={() => unlock(r.id)} className="safe">
                      Unlock
                    </button>
                  </div>

                  <div className="room-card-row">
                    <button type="button" onClick={() => startVote(r.id)}>
                      Start Voting
                    </button>
                    <button type="button" onClick={() => closeVote(r.id)} className="warn">
                      Close &amp; Lock Topic
                    </button>

                    <button
                      type="button"
                      onClick={() => closeFinal(r.id)}
                      className="warn"
                      disabled={!isFinal || isClosed}
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

      {/* Gallery Modal */}
      {galleryOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setGalleryOpen(false)}
        >
          <div
            className="rounded-2xl"
            style={{
              width: 960,
              maxWidth: '96vw',
              maxHeight: '90vh',
              overflow: 'hidden',
              background: 'rgba(20,20,24,0.6)',
              border: '1px solid rgba(255,255,255,0.12)',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
              color: 'white',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              style={{
                padding: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="gold-dot" />
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>
                    Gallery — {siteId || '—'}
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    Closed room abstracts (newest first). Copy, share, export.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={loadGallery}
                  disabled={galleryLoading}
                >
                  {galleryLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setGalleryOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: 16, overflowY: 'auto', maxHeight: 'calc(90vh - 70px)' }}>
              {galleryError && (
                <div className="presenter-empty glass" style={{ marginBottom: 12 }}>
                  {galleryError}
                </div>
              )}

              {!galleryError && galleryLoading && (
                <div className="presenter-empty glass" style={{ marginBottom: 12 }}>
                  Loading gallery…
                </div>
              )}

              {!galleryError && !galleryLoading && galleryItems.length === 0 && (
                <div className="presenter-empty glass">
                  No closed abstracts yet for <b>{siteId}</b>. Close rooms in FINAL to populate.
                </div>
              )}

              {!galleryError && !galleryLoading && galleryItems.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
                  {galleryItems.map((it) => (
                    <div
                      key={it.roomId}
                      className="glass"
                      style={{
                        borderRadius: 16,
                        padding: 14,
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(15,23,42,0.65)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 8,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 14 }}>
                            {it.roomId}{it.index ? ` (Room ${it.index})` : ''}{' '}
                            <span style={{ opacity: 0.65, fontWeight: 600 }}>
                              • {formatClosedAt(it.closedAt) || '—'}
                            </span>
                          </div>
                          <div style={{ opacity: 0.9, fontSize: 13, marginTop: 2 }}>
                            <span style={{ opacity: 0.7 }}>Topic:</span>{' '}
                            <b>{it.topic || '—'}</b>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              const ok = await copyToClipboard(it.abstract || '');
                              setGalleryCopiedRoom(ok ? it.roomId : '');
                              if (!ok) alert('Copy failed — your browser blocked clipboard.');
                              if (ok) {
                                setTimeout(() => setGalleryCopiedRoom(''), 1200);
                              }
                            }}
                            disabled={!it.abstract}
                            title="Copy abstract to clipboard"
                          >
                            {galleryCopiedRoom === it.roomId ? '✅ Copied' : 'Copy'}
                          </button>

                          <a
                            href={`/room/${it.roomId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn"
                            style={{ textDecoration: 'none' }}
                            title="Open room view"
                          >
                            Open
                          </a>
                        </div>
                      </div>

                      <div
                        style={{
                          whiteSpace: 'pre-wrap',
                          fontSize: 13,
                          lineHeight: 1.45,
                          padding: 10,
                          borderRadius: 12,
                          background: 'rgba(0,0,0,0.25)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        {it.abstract ? it.abstract : '— No abstract text —'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <PresenterHUD siteId={siteId} rooms={sortedRooms} />
    </>
  );
}
