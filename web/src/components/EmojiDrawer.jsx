import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const EMOJIS = [
  '🙂','😀','😎','🤖','🧠','🦊','🐼','🐯','🐸','🦉',
  '🌸','🌿','🌙','⭐️','⚡️','🔥','💡','🎯','🎨','🎧',
  '📚','🧩','🛡️','🚀','🛰️','🌍','🗝️','💎','🧭','🕹️'
];

export default function EmojiDrawer({ open, onClose, onPick }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="drawer-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="drawer"
            initial={{ y: 500 }} animate={{ y: 0 }} exit={{ y: 500 }}
            transition={{ type: 'spring', stiffness: 260, damping: 28 }}
          >
            <div className="drawer-header">
              <div style={{ fontWeight: 700 }}>Pick your emoji</div>
              <button className="btn ghost" onClick={onClose}>Close</button>
            </div>
            <div className="drawer-grid">
              {EMOJIS.map((e, i) => (
                <div key={i} className="drawer-emoji" onClick={() => { onPick(e); onClose(); }}>
                  {e}
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
