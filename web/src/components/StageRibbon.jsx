// web/src/components/StageRibbon.jsx
import React from 'react';
import { motion } from 'framer-motion';

const STAGES = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
];

function prettyLabel(s) {
  return s
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ');
}

export default function StageRibbon({ stage }) {
  return (
    <div
      role="list"
      aria-label="Session stages"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 8,
      }}
    >
      {STAGES.map((s, i) => {
        const active = s === stage;
        const label = prettyLabel(s);

        return (
          <motion.span
            key={s}
            role="listitem"
            aria-current={active ? 'step' : undefined}
            layout
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              fontSize: 12,
              letterSpacing: 0.4,
              fontWeight: 600,
              background: active
                ? 'linear-gradient(90deg,#f0c86b,#ffefb6)'
                : 'rgba(255,255,255,0.08)',
              color: active ? '#000' : '#d1d5db',
              border: active
                ? '1px solid rgba(255,255,255,0.35)'
                : '1px solid rgba(255,255,255,0.12)',
              boxShadow: active
                ? '0 0 10px rgba(255,215,90,0.45)'
                : 'none',
              textTransform: 'none',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                background: active
                  ? 'rgba(0,0,0,0.12)'
                  : 'rgba(255,255,255,0.06)',
              }}
            >
              {i + 1}
            </span>
            <span>{label}</span>
          </motion.span>
        );
      })}
    </div>
  );
}
