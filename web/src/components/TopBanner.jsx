import React from 'react';
import { motion } from 'framer-motion';

export default function TopBanner({ siteId, roomIndex, stage }) {
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
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: 'white',
        fontSize: 13,
        fontWeight: 500,
      }}
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
      <div className="tag">Site <b>{siteId}</b></div>
      <div className="tag">Room <b>{roomIndex}</b></div>
      <div className="tag" style={{ marginLeft: 'auto' }}>
        Stage:
        <span
          className="stage-badge"
          style={{
            marginLeft: 6,
            background: 'linear-gradient(90deg,#f0c86b,#ffefb6)',
            color: '#000',
            padding: '2px 8px',
            borderRadius: 12,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          {stage}
        </span>
      </div>
    </motion.div>
  );
}
