// web/src/components/IdeaSidebar.jsx
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';

export default function IdeaSidebar({ summary = '' }) {
  // Turn raw summary text into bullet lines + a "headline" if present
  const { title, items } = useMemo(() => {
    if (!summary) {
      return { title: null, items: [] };
    }

    const lines = summary
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      return { title: null, items: [] };
    }

    // If the first line looks like a sentence and the rest look like bullets,
    // treat that as a header from Asema.
    const [first, ...rest] = lines;
    const bulletish = (line) => /^[-•]/.test(line) || line.length < 80;

    const hasBulletishRest = rest.some(bulletish);
    const title = hasBulletishRest ? first.replace(/^[-•]\s*/, '') : null;

    const contentLines = hasBulletishRest ? rest : lines;

    const items = contentLines.map((line, i) =>
      line.replace(/^[-•]\s*/, '').trim()
    );

    return { title, items };
  }, [summary]);

  return (
    <motion.div
      key="idea-sidebar"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.25 }}
      style={{
        minWidth: 280,
        maxWidth: 320,
        alignSelf: 'stretch',
        backdropFilter: 'blur(12px)',
        background: 'linear-gradient(160deg, rgba(16,18,24,0.9), rgba(24,26,34,0.9))',
        border: '1px solid rgba(240,200,107,0.28)',
        borderRadius: 14,
        padding: 14,
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        overflowY: 'auto',
        boxShadow: '0 14px 40px rgba(0,0,0,0.45)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '999px',
            background: 'radial-gradient(circle at 30% 20%, #ffefb6, #f0c86b)',
            boxShadow: '0 0 12px rgba(240,200,107,0.7)',
          }}
        />
        <div>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: '#f0c86b',
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            Idea Board
          </div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              marginTop: 2,
            }}
          >
            Live summary of what your room is surfacing.
          </div>
        </div>
      </div>

      {/* Optional title extracted from summary */}
      {title && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
            color: '#e5e7eb',
          }}
        >
          {title}
        </div>
      )}

      {/* Content */}
      {items.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 16,
            listStyleType: 'disc',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {items.map((line, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
          No ideas yet — start sharing in the chat and Asema will surface patterns here.
        </div>
      )}

      {/* Footer hint */}
      <div
        style={{
          marginTop: 10,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          paddingTop: 6,
          fontSize: 11,
          opacity: 0.6,
        }}
      >
        Tip: If the board feels stale, add a few clear bullet points or questions in chat —
        the AI summary will refresh as the conversation grows.
      </div>
    </motion.div>
  );
}
