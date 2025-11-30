// web/src/pages/Login.jsx
import React, { useState, useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import EmojiDrawer from '../components/EmojiDrawer.jsx';
import { ensureGuest, authHeaders, API_BASE } from '../api';

export default function Login() {
  const [code, setCode] = useState('');
  const [mode, setMode] = useState('individual');
  const [emoji1, setEmoji1] = useState('🙂');
  const [emoji2, setEmoji2] = useState('🦊');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activePicker, setActivePicker] = useState(1);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef(null);

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
  function onMouseLeave() {
    x.set(0);
    y.set(0);
  }

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed) {
      alert('Please enter your session code.');
      return;
    }

    try {
      setBusy(true);

      // Ensure guest token
      await ensureGuest();

      // Consume code -> get site + role
      const res = await fetch(`${API_BASE}/codes/consume`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ code: trimmed }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.error || 'Login failed. Check your code and try again.');
        setBusy(false);
        return;
      }

      const role = json.role || 'PARTICIPANT';
      const siteId = json.siteId || 'E1';
      sessionStorage.setItem('role', role);

      if (role === 'PRESENTER') {
        // Presenter HUD
        window.location.href = '/presenter';
        return;
      }

      // Participant: store personas + mode
      const personas = mode === 'pair' ? [emoji1, emoji2] : [emoji1];
      sessionStorage.setItem('personas', JSON.stringify(personas));
      sessionStorage.setItem('mode', mode);

      // Ask API to assign a room (max 6 per room, rolls across rooms)
      let roomId = `${siteId}-1`;
      try {
        const assignRes = await fetch(`${API_BASE}/rooms/assign`, {
          method: 'POST',
          ...(await authHeaders()),
          body: JSON.stringify({ siteId }),
        });
        const assignJson = await assignRes.json().catch(() => ({}));
        if (assignRes.ok && assignJson.roomId) {
          roomId = assignJson.roomId;
        }
      } catch (e) {
        console.warn('[login] /rooms/assign failed, falling back to first room', e);
      }

      window.location.href = `/room/${roomId}`;
    } catch (e) {
      console.error(e);
      alert('Could not reach API. Check your API_BASE and CORS.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      {/* Top site header */}
      <div className="site-header">
        <div className="site-header-left">
          <span className="site-logo">🌸</span>
          <span className="site-title">Asema Academy</span>
        </div>
        <div className="site-header-right">
          <span className="site-tagline">
            Unmasking AI — one story at a time.
          </span>
        </div>
      </div>

      <div className="center-wrap">
        <motion.div
          ref={cardRef}
          className="glass tilt"
          style={{ rotateX, rotateY }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          transition={{
            type: 'spring',
            stiffness: 120,
            damping: 12,
          }}
        >
          <div className="brand">
            <div className="brand-badge tilt-raise-sm">
              SESSION ACCESS
            </div>
            <div className="brand-title tilt-raise">
              StoriBloom.AI
            </div>
          </div>
          <div className="brand-sub tilt-raise-sm">
            Live AI collaboration for your site. Enter the session
            code from your facilitator to join your group.
          </div>

          <div className="mt16">
            <label
              style={{
                fontSize: 12,
                color: '#b9bec6',
              }}
            >
              SESSION CODE
              <span
                style={{
                  fontSize: 11,
                  color: '#9aa0a6',
                  marginLeft: 6,
                }}
              >
                (On your handout or screen)
              </span>
            </label>
            <input
              className="input mt6"
              placeholder="U-TEST1 or P-1234"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              disabled={busy}
            />
          </div>

          <div className="row mt16">
            <button
              className={`btn ${mode === 'individual' ? '' : 'ghost'}`}
              onClick={() => setMode('individual')}
              disabled={busy}
            >
              Individual
            </button>
            <button
              className={`btn ${mode === 'pair' ? '' : 'ghost'}`}
              onClick={() => setMode('pair')}
              disabled={busy}
            >
              Pair
            </button>
            <div
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: '#9aa0a6',
              }}
            >
              You’ll appear anonymous, identified by
              your emoji only.
            </div>
          </div>

          <div className="mt16">
            <label
              style={{
                fontSize: 12,
                color: '#b9bec6',
              }}
            >
              EMOJI PERSONA
              {mode === 'pair' ? 'S' : ''}
            </label>
            <div className="row mt6">
              <button
                className="chip tilt-raise-sm"
                onClick={() => {
                  setActivePicker(1);
                  setDrawerOpen(true);
                }}
                disabled={busy}
              >
                {emoji1}
              </button>

              {mode === 'pair' && (
                <button
                  className="chip tilt-raise-sm"
                  onClick={() => {
                    setActivePicker(2);
                    setDrawerOpen(true);
                  }}
                  disabled={busy}
                >
                  {emoji2}
                </button>
              )}

              <button
                className="btn ghost"
                onClick={() => {
                  setActivePicker(1);
                  setDrawerOpen(true);
                }}
                disabled={busy}
              >
                Open emoji drawer
              </button>
            </div>
          </div>

          <div className="row mt24">
            <button
              className="btn primary tilt-raise"
              onClick={submit}
              disabled={busy}
            >
              {busy ? 'Entering…' : 'Enter Session'}
            </button>
            <div
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: '#b9bec6',
              }}
            >
              Tip: press{' '}
              <span style={{ color: 'var(--gold)' }}>
                Enter
              </span>{' '}
              to submit.
            </div>
          </div>

          <div
            className="mt12"
            style={{
              fontSize: 11,
              color: '#7b818a',
            }}
          >
            Proceeding implies acceptance of session
            guidelines. Unauthorized access will be logged.
          </div>
        </motion.div>

        {/* How it works strip */}
        <div className="login-how-it-works">
          <div className="step">
            <div className="step-num">1</div>
            <div className="step-body">
              <div className="step-title">Enter your code</div>
              <div className="step-text">
                Use the session code your facilitator shared for your
                site and time slot.
              </div>
            </div>
          </div>
          <div className="step">
            <div className="step-num">2</div>
            <div className="step-body">
              <div className="step-title">Choose your emoji</div>
              <div className="step-text">
                Your emoji is your identity. No names, just vibes and ideas.
              </div>
            </div>
          </div>
          <div className="step">
            <div className="step-num">3</div>
            <div className="step-body">
              <div className="step-title">Build with Asema</div>
              <div className="step-text">
                Join your group room and co-create a story or abstract
                with AI as your collaborator.
              </div>
            </div>
          </div>
        </div>
      </div>

      <EmojiDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onPick={(e) =>
          activePicker === 1 ? setEmoji1(e) : setEmoji2(e)
        }
      />
    </>
  );
}
