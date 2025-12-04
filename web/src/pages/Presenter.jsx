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
  'CLOSED', // include CLOSED in presenter summary
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canFetch = useMemo(
    () => !!(siteId && siteId.trim().length),
    [siteId]
  );

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

      // IMPORTANT: spread authHeaders so headers/credentials are correct
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
        ...(await authHeaders()),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Action failed (${res.status})`);
      }
      // let polling pick up new state; no need to do anything here
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
        {error && (
          <div className="presenter-empty glass">
            {error}
          </div>
        )}

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
                </section>

                {r.vote && (
                  <section className="room-card-vote">
                    <div>
                      <span className="label">Voting</span>{' '}
                      {r.vote.open ? 'Open' : 'Closed'}
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
                    <button
                      type="button"
                      onClick={() => lock(r.id)}
                      className="warn"
                    >
                      Lock
                    </button>
                    <button
                      type="button"
                      onClick={() => unlock(r.id)}
                      className="safe"
                    >
                      Unlock
                    </button>
                  </div>

                  <div className="room-card-row">
                    <button type="button" onClick={() => startVote(r.id)}>
                      Start Voting
                    </button>
                    <button
                      type="button"
                      onClick={() => closeVote(r.id)}
                      className="warn"
                    >
                      Close &amp; Lock Topic
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

                {/* Optional inline presenter voting panel */}
                <section className="room-card-voting-panel">
                  <PresenterVotingPanel roomId={r.id} isPresenter />
                </section>
              </article>
            );
          })}
        </main>
      </div>

      {/* Floating keyboard-hotkey HUD (bottom-right) */}
      <PresenterHUD siteId={siteId} rooms={sortedRooms} />
    </>
  );
}
