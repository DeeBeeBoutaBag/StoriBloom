// web/src/components/ChatMessage.jsx
import React from 'react';
import { motion } from 'framer-motion';

export default function ChatMessage({ kind, who, text }) {
  const isAsema = kind === 'asema';

  // Very light formatting: line breaks + clickable links
  function renderText(raw) {
    if (!raw) return null;

    const urlRegex = /(https?:\/\/[^\s]+)/g;

    return raw.split('\n').map((line, lineIdx) => {
      const parts = line.split(urlRegex);

      return (
        <p key={lineIdx} className="msg-line">
          {parts.map((part, i) => {
            if (urlRegex.test(part)) {
              // reset lastIndex for safety
              urlRegex.lastIndex = 0;
              return (
                <a
                  key={i}
                  href={part}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="msg-link"
                >
                  {part}
                </a>
              );
            }
            return <span key={i}>{part}</span>;
          })}
        </p>
      );
    });
  }

  return (
    <motion.div
      className={`msg ${isAsema ? 'asema' : 'user'}`}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.18,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      <div className="avatar" aria-hidden="true">
        {isAsema ? '🤖' : who}
      </div>

      <div className="bubble">
        {isAsema && (
          <div className="bubble-label">
            <span className="bubble-label-dot" />
            <span className="bubble-label-text">Asema</span>
          </div>
        )}
        <div className="bubble-text">
          {renderText(text)}
        </div>
      </div>
    </motion.div>
  );
}
