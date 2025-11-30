// web/src/components/EmojiDrawer.jsx
import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const EMOJIS = [
  // Faces / vibes
  '🙂','😀','😎','🧠','🤖','🥷','🧑🏾‍🏫','🧑🏾‍💻',
  // Animals / mascots
  '🦊','🐼','🐯','🐸','🦉','🦁','🐻','🐢',
  // Nature / symbols
  '🌸','🌿','🌙','⭐️','⚡️','🔥','🌈','🌊',
  // Creative / focus
  '💡','🎯','🎨','🎧','📚','🧩','🕹️','🎮',
  // Future / mission
  '🚀','🛰️','🌍','🗝️','💎','🧭','📡','🏙️'
];

export default function EmojiDrawer({ open, onClose, onPick }) {
  const drawerRef = useRef(null);
  const firstEmojiRef = useRef(null);

  // Lock page scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // ESC + focus trap
  useEffect(() => {
    if (!open) return;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }

      if (!drawerRef.current) return;

      // trap Tab focus within drawer
      if (e.key === 'Tab') {
        const focusables = drawerRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  // Autofocus first emoji when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => firstEmojiRef.current?.focus(), 0);
    }
  }, [open]);

  function handleRandom() {
    const idx = Math.floor(Math.random() * EMOJIS.length);
    const e = EMOJIS[idx];
    onPick?.(e);
    onClose?.();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(2px)',
              zIndex: 50,
            }}
          />
          <motion.div
            ref={drawerRef}
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="emoji-drawer-title"
            aria-describedby="emoji-drawer-help"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 28 }}
            style={{
              position: 'fixed',
              left: '50%',
              bottom: 24,
              transform: 'translateX(-50%)',
              width: 'min(640px, 92vw)',
              maxHeight: '60vh',
              overflow: 'auto',
              background: 'rgba(20,20,24,0.75)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 16,
              padding: 16,
              color: '#fff',
              zIndex: 60,
              boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div
              className="drawer-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <div>
                <div
                  id="emoji-drawer-title"
                  style={{ fontWeight: 700, fontSize: 16 }}
                >
                  Pick your emoji persona
                </div>
                <div
                  id="emoji-drawer-help"
                  style={{
                    fontSize: 11,
                    opacity: 0.7,
                    marginTop: 2,
                  }}
                >
                  Click to choose, or use Tab / Shift+Tab and Enter. Press Esc to close.
                </div>
              </div>
              <button
                className="btn ghost"
                onClick={handleRandom}
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  paddingInline: 10,
                }}
              >
                🎲 Random
              </button>
              <button
                className="btn ghost"
                onClick={onClose}
                style={{
                  fontSize: 12,
                  paddingInline: 10,
                }}
              >
                Close
              </button>
            </div>

            <div
              className="drawer-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(10, minmax(0, 1fr))',
                gap: 8,
              }}
            >
              {EMOJIS.map((e, i) => (
                <button
                  key={i}
                  ref={i === 0 ? firstEmojiRef : null}
                  className="drawer-emoji"
                  onClick={() => {
                    onPick?.(e);
                    onClose?.();
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onPick?.(e);
                      onClose?.();
                    }
                  }}
                  aria-label={`Choose ${e}`}
                  style={{
                    fontSize: 22,
                    lineHeight: '36px',
                    height: 40,
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s ease, transform 0.12s ease, box-shadow 0.15s ease',
                  }}
                  onMouseEnter={(ev) => {
                    ev.currentTarget.style.background = 'rgba(255,255,255,0.16)';
                    ev.currentTarget.style.transform = 'translateY(-1px)';
                    ev.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.35)';
                  }}
                  onMouseLeave={(ev) => {
                    ev.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                    ev.currentTarget.style.transform = 'translateY(0)';
                    ev.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
