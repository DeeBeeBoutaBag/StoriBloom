import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { awsHeaders } from '../lib/awsAuth';

export default function PresenterHUD({ siteId, rooms }) {
  const sorted = useMemo(() =>
    [...(rooms || [])].sort((a, b) => (a.index || 0) - (b.index || 0))
  , [rooms]);

  const [open, setOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [i, setI] = useState(0); // selected room index in sorted
  const room = sorted[i];

  const post = useCallback(async (path, body) => {
    if (!room) return;
    const url = `${import.meta.env.VITE_API_URL}${path.replace(':roomId', room.id)}`;
    const res = await fetch(url, {
      method: 'POST',
      ...(await awsHeaders()),
      body: JSON.stringify(body || {})
    });
    if (!res.ok) {
      const j = await res.json().catch(()=>({}));
      alert(j.error || 'Action failed');
    }
  }, [room]);

  const next = useCallback(()=> post(`/rooms/:roomId/next`, {}), [post]);
  const extend = useCallback(()=> post(`/rooms/:roomId/extend`, { by: 120 }), [post]);
  const redo = useCallback(()=> post(`/rooms/:roomId/redo`, {}), [post]);

  // hotkeys
  useEffect(() => {
    const handler = (e) => {
      // ignore if typing in input
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.isComposing) return;

      if (e.key === 'h' || e.key === 'H') { setOpen(o=>!o); return; }
      if (e.key === '?') { setHelpOpen(h=>!h); return; }

      if (!open) return;

      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); next(); }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); extend(); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); redo(); }

      // change selected room
      if (e.key === '[' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp')) {
        e.preventDefault(); setI((p)=> Math.max(0, p-1));
      }
      if (e.key === ']' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown')) {
        e.preventDefault(); setI((p)=> Math.min(sorted.length-1, p+1));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sorted.length, next, extend, redo]);

  if (!room) return null;

  return (
    <>
      {helpOpen && (
        <div className="hud-help">
          <h4>Presenter Hotkeys</h4>
          <ul>
            <li><b>N</b> — Next stage</li>
            <li><b>E</b> — +2 minutes</li>
            <li><b>R</b> — Redo (reopen Draft)</li>
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
          <div className="hud-pill">Site <b>{siteId}</b></div>
        </div>

        <div className="hud-row" title="Select active room (use [ and ])">
          <div className="hud-pill">Room <b>{room.index}</b></div>
          <div className="hud-pill">Stage <b>{room.stage}</b></div>
          <div className="hud-pill" style={{ marginLeft: 'auto' }}>
            {i+1}/{sorted.length}
          </div>
        </div>

        <div className="hud-row">
          <button className="hud-btn primary" onClick={next}>Next (N)</button>
        </div>
        <div className="hud-row">
          <button className="hud-btn" onClick={extend}>+2m (E)</button>
          <button className="hud-btn" onClick={redo}>Redo (R)</button>
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
