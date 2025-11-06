// web/src/pages/Login.jsx

import React, { useState, useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import EmojiDrawer from '../components/EmojiDrawer.jsx';
import { ensureGuest, authHeaders, API_BASE } from '../api.js';

export default function Login() {
  const [code, setCode] = useState('');
  const [mode, setMode] = useState('individual');
  const [emoji1, setEmoji1] = useState('🙂');
  const [emoji2, setEmoji2] = useState('🦊');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activePicker, setActivePicker] = useState(1);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef(null);

  // 3D tilt with framer-motion
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useTransform(y, [-50, 50], [10, -10]);
  const rotateY = useTransform(x, [-50, 50], [-12, 12]);

  function onMouseMove(e) {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = e.clientX - (rect.left + rect.width / 2);
    const relY = e.clientY - (rect.top + rect.height / 2);
    x.set(relX / 6);
    y.set(relY / 6);
  }
  function onMouseLeave() { x.set(0); y.set(0); }

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed) { alert('Please enter your session code.'); return; }

    try {
      setBusy(true);

      // Ensure guest token exists
      await ensureGuest();

      // Consume code via API (uses Authorization: Bearer <token>)
      const res = await fetch(`${API_BASE}/codes/consume`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ code: trimmed }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.error || 'Login failed. Check your code and try again.');
        setBusy(false);
        return;
      }

      // Route based on role
      if (json.role === 'PRESENTER') {
        // Your router expects /presenter/:siteId
        if (!json.siteId) {
          alert('Missing siteId for presenter.');
          setBusy(false);
          return;
        }
        location.href = `/presenter/${json.siteId}`;
      } else {
        const personas = mode === 'pair' ? [emoji1, emoji2] : [emoji1];
        sessionStorage.setItem('personas', JSON.stringify(personas));
        sessionStorage.setItem('mode', mode);

        // Demo route: /room/<siteId>-1 (can change when server assigns exact room)
        if (!json.siteId) {
          alert('Missing siteId.');
          setBusy(false);
          return;
        }
        location.href = `/room/${json.siteId}-1`;
      }
    } catch (e) {
      console.error(e);
      alert('Could not reach API. Check your API proxy/rewrites.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="center-wrap">
        <motion.div
          ref={cardRef}
          className="glass tilt"
          style={{ rotateX, rotateY }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          transition={{ type: 'spring', stiffness: 120, damping: 12 }}
        >
          {/* Badge + Title */}
          <div className="brand">
            <div className="brand-badge tilt-raise-sm">ACCESS: GRANTED</div>
            <div className="brand-title tilt-raise">StoriBloom.AI</div>
          </div>
          <div className="brand-sub tilt-raise-sm">
            Classified Collaboration Console — Enter your session code to proceed.
          </div>

          {/* Code input */}
          <div className="mt16">
            <label style={{ fontSize: 12, color: '#b9bec6' }}>SESSION CODE</label>
            <input
              className="input mt6"
              placeholder="U-TEST1 or P-1234"
              value={code}
              onChange={(e)=>setCode(e.target.value)}
              onKeyDown={(e)=> (e.key==='Enter') && submit()}
              disabled={busy}
            />
          </div>

          {/* Mode select */}
          <div className="row mt16">
            <button
              className={`btn ${mode==='individual'?'':'ghost'}`}
              onClick={()=>setMode('individual')}
              title="One person per device"
              disabled={busy}
            >Individual</button>
            <button
              className={`btn ${mode==='pair'?'':'ghost'}`}
              onClick={()=>setMode('pair')}
              title="Two personas on this device"
              disabled={busy}
            >Pair</button>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0a6' }}>
              You’ll appear anonymous, identified by your emoji.
            </div>
          </div>

          {/* Emoji chips */}
          <div className="mt16">
            <label style={{ fontSize: 12, color: '#b9bec6' }}>EMOJI PERSONA{mode==='pair'?'S':''}</label>
            <div className="row mt6">
              <button
                className="chip tilt-raise-sm"
                onClick={()=>{ setActivePicker(1); setDrawerOpen(true); }}
                aria-label="Choose first emoji"
                disabled={busy}
              >{emoji1}</button>

              {mode==='pair' && (
                <button
                  className="chip tilt-raise-sm"
                  onClick={()=>{ setActivePicker(2); setDrawerOpen(true); }}
                  aria-label="Choose second emoji"
                  disabled={busy}
                >{emoji2}</button>
              )}

              <button
                className="btn ghost"
                onClick={()=>{ setActivePicker(1); setDrawerOpen(true); }}
                disabled={busy}
              >
                Open emoji drawer
              </button>
            </div>
          </div>

          {/* Action row */}
          <div className="row mt24">
            <button className="btn primary tilt-raise" onClick={submit} disabled={busy}>
              {busy ? 'Entering…' : 'Enter StoriBloom'}
            </button>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: '#b9bec6' }}>
              Tip: press <span style={{ color: 'var(--gold)' }}>Enter</span> to submit.
            </div>
          </div>

          {/* Footer */}
          <div className="mt12" style={{ fontSize: 11, color: '#7b818a' }}>
            Proceeding implies acceptance of session guidelines. Unauthorized access will be logged.
          </div>
        </motion.div>
      </div>

      {/* Emoji Drawer */}
      <EmojiDrawer
        open={drawerOpen}
        onClose={()=>setDrawerOpen(false)}
        onPick={(e)=> activePicker===1 ? setEmoji1(e) : setEmoji2(e)}
      />
    </>
  );
}
