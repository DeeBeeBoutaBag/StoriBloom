// web/src/pages/Presenter.jsx

import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE } from '../api.js';

/**
 * Presenter HUD
 * - Enter your Site ID (persisted in sessionStorage, seeded from URL param)
 * - Lists rooms for that site
 * - Controls per-room: Next, +2m, Redo, Lock/Unlock input
 * - Voting controls (Start, Close/Lock)
 * - Live status: stage, seats, topic, inputLocked, vote status
 */

const STAGE_ORDER = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
];

const STAGE_DESCRIPTIONS = {
  LOBBY: 'Participants arriving, testing chat, and picking emojis.',
  DISCOVERY: 'Surfacing lived experiences and issues that matter.',
  IDEA_DUMP: 'Rapid-fire ideas, no judging, just adding to the pile.',
  PLANNING: 'Choosing the angle, character, and story arc together.',
  ROUGH_DRAFT: 'Asema + group co-writing the first version.',
  EDITING: 'Tightening language, structure, and voice as a team.',
  FINAL: 'Polishing the abstract so it’s ready to share back.',
};

function useSiteIdFromUrl() {
  const { siteId: siteIdParam } = useParams();
  const [siteId, setSiteId] = useState(() => {
    // Prefer URL param on first load, then fall back to sessionStorage
    const fromUrl = (siteIdParam || '').toUpperCase();
    if (fromUrl) {
      sessionStorage.setItem('presenter_siteId', fromUrl);
      return fromUrl;
    }
    return (sessionStorage.getItem('presenter_siteId') || '').toUpperCase();
  });

  // Persist on changes typed by the user
  useEffect(() => {
    if (siteId) {
      sessionStorage.setItem('presenter_siteId', siteId.toUpperCase());
    }
  }, [siteId]);

  return [siteId, setSiteId];
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteIdFromUrl();
  const [rooms, setRooms] = useState([]); // [{id, index, stage, inputLocked, topic, seats, vote:{open,total}}]
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Require a non-empty siteId to fetch
  const canFetch = useMemo(
    () => !!(siteId && siteId.trim().length),
    [siteId]
  );

  // auth bootstrap (get a guest token once)
  useEffect(() => {
    ensureGuest().catch(() => {});
  }, []);

  // polling rooms list
  useEffect(() => {
    if (!canFetch) return;
    let mounted = true;

    async function load() {
      setLoading(true);
      try {
        const url = new URL(
          `${API_BASE}/presenter/rooms`,
          window.location.origin
        );
        url.searchParams.set('siteId', siteId.toUpperCase());

        const res = await fetch(url.toString(), {
          headers: await authHeaders(),
        });
        if (!res.ok) throw new Error('rooms fetch failed');

        const j = await res.json();
        if (!mounted) return;
        setRooms(Array.isArray(j.rooms) ? j.rooms : []);
        setLastRefreshed(new Date());
      } catch (err) {
        console.error('[Presenter] rooms load error:', err);
        if (mounted) setRooms([]);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const id = setInterval(load, 2500);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [siteId, canFetch]);

  async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.ok;
  }

  // hotkeys: Next (N), +2m (= or +), Redo (R) on first room
  useEffect(() => {
    function onKey(e) {
      if (!rooms.length) return;
      const r = rooms[0];
      if (!r) return;

      if (e.key.toLowerCase() === 'n') next(r.id);
      if (e.key === '=' || e.key === '+') extend(r.id, 120);
      if (e.key.toLowerCase() === 'r') redo(r.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rooms]);

  async function next(roomId) {
    await post(`/rooms/${roomId}/next`);
  }
  async function extend(roomId, secs = 120) {
    await post(`/rooms/${roomId}/extend`, { by: secs });
  }
  async function redo(roomId) {
    await post(`/rooms/${roomId}/redo`);
  }
  async function lock(roomId) {
    await post(`/rooms/${roomId}/lock`, { inputLocked: true });
  }
  async function unlock(roomId) {
    await post(`/rooms/${roomId}/lock`, { inputLocked: false });
  }

  // Voting controls (Discovery)
  async function startVote(roomId) {
    await post(`/rooms/${roomId}/vote/start`);
  }
  async function closeVote(roomId) {
    await post(`/rooms/${roomId}/vote/close`);
  }

  // --- Global helpers / summaries ---

  const stageCounts = useMemo(() => {
    const counts = {};
    for (const r of rooms) {
      const s = r.stage || 'UNKNOWN';
      counts[s] = (counts[s] || 0) + 1;
    }
    return counts;
  }, [rooms]);

  const totalParticipants = useMemo(() => {
    return rooms.reduce((acc, r) => {
      const seats = Number.isFinite(r.seats) ? Number(r.seats) : 0;
      return acc + seats;
    }, 0);
  }, [rooms]);

  const anyVotingOpen = useMemo(
    () => rooms.some((r) => r.vote && r.vote.open),
    [rooms]
  );

  async function nextAll() {
    await Promise.all(rooms.map((r) => next(r.id)));
  }

  async function extendAll(secs = 120) {
    await Promise.all(rooms.map((r) => extend(r.id, secs)));
  }

  function openRoom(roomId) {
    // Open participant view for debugging / monitoring
    window.open(`/room/${roomId}`, '_blank', 'noopener,noreferrer');
  }

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />

      <div className="presenter-wrap">
        {/* Header bar */}
        <div className="presenter-head glass">
          <div className="title-block">
            <div className="title">Presenter HUD</div>
            <div className="subtitle">
              Live control panel for{' '}
              <strong>{siteId || '—'}</strong> rooms.
            </div>
          </div>

          <div className="site">
            <label>Site ID</label>
            <input
              value={siteId}
              onChange={(e) =>
                setSiteId(e.target.value.toUpperCase())
              }
              placeholder="E1 / C1 / W1 etc."
            />
          </div>

          <div className="head-meta">
            <div className="hint">
              Hotkeys on Room 1:&nbsp;
              <b>N</b> Next, <b>+</b> +2m, <b>R</b> Redo
            </div>
            <div className="status-pill">
              {loading ? 'Syncing…' : 'Live'}
              {lastRefreshed && (
                <span className="status-time">
                  &nbsp;• Updated at{' '}
                  {lastRefreshed.toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>

          {canFetch && rooms.length > 0 && (
            <div className="global-controls">
              <button onClick={nextAll} className="btn small">
                Next Stage: All Rooms
              </button>
              <button
                onClick={() => extendAll(120)}
                className="btn small"
              >
                +2m: All Rooms
              </button>
              <div className="global-summary">
                <span>
                  Rooms: <b>{rooms.length}</b>
                </span>
                <span>
                  Est. Participants:{' '}
                  <b>{totalParticipants || '—'}</b>
                </span>
                {anyVotingOpen && (
                  <span className="pill-warning">
                    Voting open in one or more rooms
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Stage overview chips */}
        {canFetch && rooms.length > 0 && (
          <div className="stage-overview glass">
            {STAGE_ORDER.map((s) => (
              <div
                key={s}
                className={`stage-chip ${
                  stageCounts[s] ? 'active' : ''
                }`}
              >
                <span className="stage-name">{s}</span>
                <span className="stage-count">
                  {stageCounts[s] || 0} rooms
                </span>
              </div>
            ))}
          </div>
        )}

        {!canFetch && (
          <div className="empty glass">
            Enter a Site ID above to load active rooms.
          </div>
        )}

        {canFetch && (
          <div className="rooms-grid">
            {loading && (
              <div className="loading">Loading rooms…</div>
            )}

            {rooms.map((r) => {
              const stage = r.stage || 'LOBBY';
              const desc =
                STAGE_DESCRIPTIONS[stage] ||
                'Stage in progress.';

              return (
                <div
                  key={r.id}
                  className="room-card glass"
                >
                  {/* Card header */}
                  <div className="head">
                    <div className="id">
                      Room {r.index}{' '}
                      <span className="site-tag">
                        {siteId}
                      </span>
                    </div>
                    <div
                      className={`stage badge ${
                        stage.toLowerCase() || 'unknown'
                      }`}
                    >
                      {stage}
                    </div>
                  </div>

                  {/* Stage description */}
                  <div className="stage-desc">
                    {desc}
                  </div>

                  {/* Meta row */}
                  <div className="meta">
                    <div>
                      <span className="label">
                        Seats
                      </span>{' '}
                      {r.seats ?? '—'}
                    </div>
                    <div>
                      <span className="label">
                        Locked
                      </span>{' '}
                      {r.inputLocked ? 'Yes' : 'No'}
                    </div>
                    <div>
                      <span className="label">
                        Topic
                      </span>{' '}
                      {r.topic || '—'}
                    </div>
                  </div>

                  {/* Voting status */}
                  {r.vote && (
                    <div className="vote meta">
                      <div>
                        <span className="label">
                          Voting
                        </span>{' '}
                        {r.vote.open ? 'Open' : 'Closed'}
                      </div>
                      <div>
                        <span className="label">
                          Ballots
                        </span>{' '}
                        {r.vote.total ?? 0}
                      </div>
                      {r.vote.tallies && (
                        <details>
                          <summary>Tallies</summary>
                          <ul className="mini">
                            {Object.entries(
                              r.vote.tallies
                            ).map(([k, v]) => (
                              <li key={k}>
                                #{k}: {v}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}

                  {/* Controls row 1: stage / time / lock */}
                  <div className="controls">
                    <button
                      onClick={() => next(r.id)}
                    >
                      Next
                    </button>
                    <button
                      onClick={() => extend(r.id, 120)}
                    >
                      +2m
                    </button>
                    <button
                      onClick={() => redo(r.id)}
                    >
                      Redo
                    </button>
                    <button
                      onClick={() => lock(r.id)}
                      className="warn"
                    >
                      Lock
                    </button>
                    <button
                      onClick={() => unlock(r.id)}
                      className="safe"
                    >
                      Unlock
                    </button>
                  </div>

                  {/* Controls row 2: voting + open room */}
                  <div className="controls">
                    <button
                      onClick={() => startVote(r.id)}
                    >
                      Start Voting
                    </button>
                    <button
                      onClick={() => closeVote(r.id)}
                      className="warn"
                    >
                      Close &amp; Lock Topic
                    </button>
                    <button
                      onClick={() => openRoom(r.id)}
                      className="ghost"
                    >
                      Open Room View
                    </button>
                  </div>
                </div>
              );
            })}

            {!loading && rooms.length === 0 && (
              <div className="empty glass">
                No rooms returned for site{' '}
                <b>{siteId}</b>.
                <br />
                Check that your codes are pointing to
                this site ID and that the backend
                endpoint{' '}
                <code>
                  /presenter/rooms?siteId={siteId}
                </code>{' '}
                is returning rooms.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
