import React, { useEffect, useMemo, useState } from 'react';
import { ensureGuest, bearer as bearerHeaders, API_BASE } from '../api';

/**
 * Presenter HUD
 * - Enter your Site ID (persisted in sessionStorage)
 * - Lists rooms for that site
 * - Controls per-room: Next, +2m, Redo, Lock/Unlock input
 * - Voting controls (Start, Close/Lock)
 * - Live status: stage, seats, topic, inputLocked, vote status
 */

function useSiteId() {
  const [siteId, setSiteId] = useState(() => sessionStorage.getItem('presenter_siteId') || '');
  useEffect(() => { sessionStorage.setItem('presenter_siteId', siteId); }, [siteId]);
  return [siteId, setSiteId];
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteId();
  const [rooms, setRooms] = useState([]); // [{id, index, stage, inputLocked, topic, seats, vote:{open,total}}]
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const canFetch = useMemo(() => !!siteId && /^[A-Z]\d$/.test(siteId) || siteId.length >= 1, [siteId]);

  // auth bootstrap
  useEffect(() => { ensureGuest(); }, []);

  // polling rooms list
  useEffect(() => {
    if (!canFetch) return;
    let mounted = true;

    async function load() {
      setLoading(true);
      try {
        const url = new URL(`${API_BASE}/presenter/rooms`);
        url.searchParams.set('siteId', siteId);
        const res = await fetch(url, await bearerHeaders());
        if (!res.ok) throw new Error('rooms fetch failed');
        const j = await res.json();
        if (!mounted) return;
        setRooms(Array.isArray(j.rooms) ? j.rooms : []);
      } catch {
        if (mounted) setRooms([]);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const id = setInterval(() => { setTick(x => x + 1); load(); }, 2500);
    return () => { mounted = false; clearInterval(id); };
  }, [siteId, canFetch]);

  async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      ...(await bearerHeaders()),
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.ok;
  }

  // hotkeys: Next (N), +2m (=), Redo (R)
  useEffect(() => {
    function onKey(e) {
      if (!rooms.length) return;
      // target = first room without SUBMITTED/CLOSED? Or just room 1:
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

        {(!canFetch) && (
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
                  <div className={`stage badge ${r.stage?.toLowerCase() || 'unknown'}`}>{r.stage || '—'}</div>
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
                          {Object.entries(r.vote.tallies).map(([k,v]) => (
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
                  <button onClick={() => closeVote(r.id)} className="warn">Close & Lock Topic</button>
                </div>
              </div>
            ))}

            {!loading && rooms.length === 0 && (
              <div className="empty glass">
                No rooms returned for site <b>{siteId}</b>.
                Ensure your API endpoint <code>/presenter/rooms?siteId=...</code> is implemented.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
