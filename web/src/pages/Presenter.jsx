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
    sessionStorage.setItem('presenter_siteId', siteId.toUpperCase());
  }, [siteId]);

  return [siteId, setSiteId];
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteIdFromUrl();
  const [rooms, setRooms] = useState([]); // [{id, index, stage, inputLocked, topic, seats, vote:{open,total}}]
  const [loading, setLoading] = useState(false);

  // Require a non-empty siteId to fetch
  const canFetch = useMemo(() => !!(siteId && siteId.trim().length), [siteId]);

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
        const url = new URL(`${API_BASE}/presenter/rooms`, window.location.origin);
        url.searchParams.set('siteId', siteId.toUpperCase());

        const res = await fetch(url.toString(), {
          headers: await authHeaders(),
        });
        if (!res.ok) throw new Error('rooms fetch failed');

        const j = await res.json();
        if (!mounted) return;
        setRooms(Array.isArray(j.rooms) ? j.rooms : []);
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

  // hotkeys: Next (N), +2m (= or +), Redo (R)
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

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />

      <div className="presenter-wrap">
        <div className="presenter-head glass">
          <div className="title">Presenter HUD</div>
          <div className="site">
            <label>Site ID</label>
            <input
              value={siteId}
              onChange={(e) => setSiteId(e.target.value.toUpperCase())}
              placeholder="E1 / C1 / W1 etc."
            />
          </div>
          <div className="hint">
            Hotkeys: <b>N</b> Next, <b>+</b> +2m, <b>R</b> Redo
          </div>
        </div>

        {!canFetch && (
          <div className="empty glass">
            Enter a Site ID to load rooms.
          </div>
        )}

        {canFetch && (
          <div className="rooms-grid">
            {loading && <div className="loading">Loading rooms…</div>}
            {rooms.map((r) => (
              <div key={r.id} className="room-card glass">
                <div className="head">
                  <div className="id">Room {r.index}</div>
                  <div className={`stage badge ${r.stage?.toLowerCase() || 'unknown'}`}>
                    {r.stage || '—'}
                  </div>
                </div>

                <div className="meta">
                  <div><span className="label">Seats</span> {r.seats ?? '—'}</div>
                  <div><span className="label">Locked</span> {r.inputLocked ? 'Yes' : 'No'}</div>
                  <div><span className="label">Topic</span> {r.topic || '—'}</div>
                </div>

                {/* Voting status */}
                {r.vote && (
                  <div className="vote meta">
                    <div><span className="label">Voting</span> {r.vote.open ? 'Open' : 'Closed'}</div>
                    <div><span className="label">Ballots</span> {r.vote.total ?? 0}</div>
                    {r.vote.tallies && (
                      <details>
                        <summary>Tallies</summary>
                        <ul className="mini">
                          {Object.entries(r.vote.tallies).map(([k, v]) => (
                            <li key={k}>#{k}: {v}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}

                <div className="controls">
                  <button onClick={() => next(r.id)}>Next</button>
                  <button onClick={() => extend(r.id, 120)}>+2m</button>
                  <button onClick={() => redo(r.id)}>Redo</button>
                  <button onClick={() => lock(r.id)} className="warn">Lock</button>
                  <button onClick={() => unlock(r.id)} className="safe">Unlock</button>
                </div>

                {/* Voting controls (usually used in DISCOVERY) */}
                <div className="controls">
                  <button onClick={() => startVote(r.id)}>Start Voting</button>
                  <button onClick={() => closeVote(r.id)} className="warn">Close &amp; Lock Topic</button>
                </div>
              </div>
            ))}

            {!loading && rooms.length === 0 && (
              <div className="empty glass">
                No rooms returned for site <b>{siteId}</b>.<br />
                Ensure your API endpoint <code>/presenter/rooms?siteId=...</code> is implemented.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
