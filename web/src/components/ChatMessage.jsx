// web/src/components/ChatMessage.jsx
import React from 'react';
import { motion } from 'framer-motion';

export default function ChatMessage({ kind = 'user', who = '🙂', text = '' }) {
  const isAsema = kind === 'asema';

  return (
    <motion.div
      className={`msg ${isAsema ? 'asema' : 'user'}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        marginBottom: 8,
      }}
    >
      <div className="who" style={{ fontSize: 20 }}>
        {isAsema ? '🤖' : who}
      </div>
      <div
        className="bubble"
        style={{
          background: isAsema ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.15)',
          padding: '8px 12px',
          borderRadius: 10,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: '#fff',
          fontSize: 14,
          flex: 1,
        }}
      >
        {text || ''}
      </div>
    </motion.div>
  );
}
