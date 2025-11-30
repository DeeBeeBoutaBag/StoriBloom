// web/src/components/TopBanner.jsx
import React from 'react';
import { motion } from 'framer-motion';

function prettyStage(stage) {
  if (!stage) return '—';
  return stage
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ');
}

export default function TopBanner({ siteId, roomIndex, stage }) {
  const safeSite = siteId || '—';
  const safeRoom = Number.isFinite(roomIndex)
    ? roomIndex
    : roomIndex || '—';
  const labelStage = prettyStage(stage);

  return (
    <motion.div
      className="banner glass"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 14,
        backdropFilter: 'blur(14px)',
        background: 'rgba(15,15,20,0.75)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: 'white',
        fontSize: 13,
        fontWeight: 500,
      }}
      aria-label={`Site ${safeSite}, room ${safeRoom}, stage ${labelStage}`}
    >
      <div
        className="dot"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'linear-gradient(90deg,#f0c86b,#ffefb6)',
          boxShadow: '0 0 6px rgba(255,215,90,0.5)',
        }}
      />

      <div className="tag">
        Site&nbsp;<b>{safeSite}</b>
      </div>

      <div className="tag">
        Room&nbsp;<b>{safeRoom}</b>
      </div>

      <div
        className="tag"
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ opacity: 0.8 }}>Stage</span>
        <span
          className="stage-badge"
          style={{
            background: 'linear-gradient(90deg,#f0c86b,#ffefb6)',
            color: '#000',
            padding: '2px 9px',
            borderRadius: 12,
            fontWeight: 700,
            letterSpacing: 0.3,
            fontSize: 12,
            textTransform: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {labelStage}
        </span>
      </div>
    </motion.div>
  );
}
