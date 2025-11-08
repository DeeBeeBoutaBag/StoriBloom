import React from 'react';
import { motion } from 'framer-motion';

export default function ChatMessage({ kind, who, text }) {
  const isAsema = kind === 'asema';

  return (
    <motion.div
      className={`msg ${isAsema ? 'asema' : 'user'}`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="avatar">
        {isAsema ? '🤖' : who}
      </div>
      <div className="bubble">
        {text}
      </div>
    </motion.div>
  );
}
