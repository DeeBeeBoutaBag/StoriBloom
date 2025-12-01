// web/src/components/PresenterHUD.jsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authHeaders, API_BASE } from '../api.js';

export default function PresenterHUD({ siteId, rooms }) {
  const sorted = useMemo(
    () => [...(rooms || [])].sort((a, b) => (a.index || 0) - (b.index || 0)),
    [rooms]
  );

  const [open, setOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [i, setI] = useState(0); // selected room index in sorted
  const room = sorted[i];

  const post = useCallback(
  async (path, body) => {
    if (!room) return;
    try {
      const url = `${API_BASE}${path.replace(':roomId', encodeURIComponent(room.id))}`;
      const res = await fetch(url, {
        method: 'POST',
        // IMPORTANT: spread authHeaders, don't put it under `headers:` yourself
        ...(await authHeaders()),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Action failed');
      }
    } catch (err) {
      alert(err.message || 'Action failed');
    }
  },
  [room]
);


  const next = useCallback(
    () => post(`/rooms/:roomId/next`, {}),
    [post]
  );
  const extend = useCallback(
    () => post(`/rooms/:roomId/extend`, { by: 120 }),
    [post]
  );
  const redo = useCallback(
    () => post(`/rooms/:roomId/redo`, {}),
    [post]
  );
  const lock = useCallback(
    () => post(`/rooms/:roomId/lock`, { inputLocked: true }),
    [post]
  );
  const unlock = useCallback(
    () => post(`/rooms/:roomId/lock`, { inputLocked: false }),
    [post]
  );
  const startVote = useCallback(
    () => post(`/rooms/:roomId/vote/start`, {}),
    [post]
  );
  const closeVote = useCallback(
    () => post(`/rooms/:roomId/vote/close`, {}),
    [post]
  );

  // hotkeys
  useEffect(() => {
    const handler = (e) => {
      // ignore if typing in input
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.isComposing) return;

      // HUD + help toggles
      if (e.key === 'h' || e.key === 'H') {
        setOpen((o) => !o);
        return;
      }
      if (e.key === '?') {
        setHelpOpen((h) => !h);
        return;
      }

      if (!open || !room) return;

      // core flow
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        next();
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        extend();
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        redo();
      }

      // lock / unlock
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        lock();
      }
      if (e.key === 'u' || e.key === 'U') {
        e.preventDefault();
        unlock();
      }

      // voting
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        startVote();
      }
      if (e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        closeVote();
      }

      // change selected room
      if (e.key === '[' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp')) {
        e.preventDefault();
        setI((p) => Math.max(0, p - 1));
      }
      if (e.key === ']' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown')) {
        e.preventDefault();
        setI((p) => Math.min(sorted.length - 1, p + 1));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sorted.length, next, extend, redo, lock, unlock, startVote, closeVote, room]);

  if (!room) return null;

  const votingOpen = !!room.vote?.open;
  const ballots = room.vote?.total ?? room.vote?.ballots ?? undefined;

  return (
    <>
      {helpOpen && (
        <div className="hud-help">
          <h4>Presenter Hotkeys</h4>
          <ul>
            <li><b>N</b> — Next stage</li>
            <li><b>E</b> — +2 minutes</li>
            <li><b>R</b> — Redo (reopen draft / stage)</li>
            <li><b>L</b> — Lock input</li>
            <li><b>U</b> — Unlock input</li>
            <li><b>V</b> — Start voting</li>
            <li><b>Shift + V</b> — Close &amp; lock topic</li>
            <li><b>[</b> or <b>Ctrl/⌘ + ↑</b> — Previous room</li>
            <li><b>]</b> or <b>Ctrl/⌘ + ↓</b> — Next room</li>
            <li><b>H</b> — Toggle HUD</li>
            <li><b>?</b> — Toggle this help</li>
          </ul>
        </div>
      )}

      <div className={`hud ${open ? '' : 'hidden'}`}>
        <div className="hud-row" style={{ justifyContent: 'space-between' }}>
          <div className="hud-title">Presenter HUD</div>
          <div className="hud-pill">
            Site <b>{siteId || '—'}</b>
          </div>
        </div>

        <div className="hud-row" title="Select active room (use [ and ])">
          <div className="hud-pill">
            Room <b>{room.index}</b>
          </div>
          <div className="hud-pill">
            Stage <b>{room.stage}</b>
          </div>
          <div className="hud-pill">
            Seats <b>{room.seats ?? '—'}</b>
          </div>
          <div className="hud-pill" style={{ marginLeft: 'auto' }}>
            {i + 1}/{sorted.length}
          </div>
        </div>

        {room.topic && (
          <div className="hud-row">
            <div className="hud-pill wide">
              Topic:&nbsp;
              <b>{room.topic}</b>
            </div>
          </div>
        )}

        {room.vote && (
          <div className="hud-row">
            <div className="hud-pill">
              Voting:&nbsp;
              <b>{votingOpen ? 'Open' : 'Closed'}</b>
            </div>
            {ballots !== undefined && (
              <div className="hud-pill">
                Ballots:&nbsp;<b>{ballots}</b>
              </div>
            )}
          </div>
        )}

        <div className="hud-row">
          <button className="hud-btn primary" onClick={next}>
            Next (N)
          </button>
        </div>
        <div className="hud-row">
          <button className="hud-btn" onClick={extend}>
            +2m (E)
          </button>
          <button className="hud-btn" onClick={redo}>
            Redo (R)
          </button>
        </div>
        <div className="hud-row">
          <button className="hud-btn warn" onClick={lock}>
            Lock (L)
          </button>
          <button className="hud-btn safe" onClick={unlock}>
            Unlock (U)
          </button>
        </div>
        <div className="hud-row">
          <button className="hud-btn" onClick={startVote}>
            Start Vote (V)
          </button>
          <button className="hud-btn warn" onClick={closeVote}>
            Close Vote (Shift+V)
          </button>
        </div>

        <div className="hud-footer">
          <span className="hud-kbd">H</span> HUD
          <span className="hud-kbd">?</span> Help
          <span className="hud-kbd">[</span>/<span className="hud-kbd">]</span> Room
          <span className="hud-kbd">Ctrl/⌘</span> + <span className="hud-kbd">↑/↓</span>
        </div>
      </div>
    </>
  );
}
