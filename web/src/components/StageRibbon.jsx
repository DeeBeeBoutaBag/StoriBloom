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

export default function StageRibbon({ stage }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 8,
      }}
    >
      {STAGES.map((s, i) => {
        const active = s === stage;
        return (
          <motion.span
            key={s}
            layout
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            style={{
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
                ? '1px solid rgba(255,255,255,0.3)'
                : '1px solid rgba(255,255,255,0.1)',
              boxShadow: active
                ? '0 0 6px rgba(255,215,90,0.5)'
                : 'none',
              textTransform: 'capitalize',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            {s.replace('_', ' ')}
          </motion.span>
        );
      })}
    </div>
  );
}
