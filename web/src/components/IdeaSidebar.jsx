import React, { useMemo } from 'react';
import { motion } from 'framer-motion';

export default function IdeaSidebar({ summary = '' }) {
  // Convert bullet-style summaries into a visually spaced list
  const formatted = useMemo(() => {
    if (!summary) return null;
    return summary
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, i) => (
        <li key={i} style={{ marginBottom: 4 }}>
          {line.replace(/^[-•]\s*/, '')}
        </li>
      ));
  }, [summary]);

  return (
    <motion.div
      key="idea-sidebar"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.3 }}
      style={{
        minWidth: 280,
        maxWidth: 320,
        alignSelf: 'stretch',
        backdropFilter: 'blur(12px)',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 14,
        padding: 14,
        color: '#e5e7eb',
        fontFamily: 'system-ui, sans-serif',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: 15,
          color: '#f0c86b',
          marginBottom: 8,
          letterSpacing: 0.3,
        }}
      >
        💡 Idea Board
      </div>

      {summary ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 16,
            listStyleType: 'disc',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {formatted}
        </ul>
      ) : (
        <div style={{ fontSize: 14, opacity: 0.7 }}>
          No ideas yet — start brainstorming!
        </div>
      )}
    </motion.div>
  );
}
