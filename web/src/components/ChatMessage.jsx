// web/src/components/ChatMessage.jsx
import React from 'react';
import { motion } from 'framer-motion';

function normalizePromptLineage(receipt = {}) {
  const out = [];
  const list = Array.isArray(receipt.promptLineage) ? receipt.promptLineage : [];
  for (const item of list) {
    const prompt = String(item?.prompt || '').trim();
    if (!prompt) continue;
    out.push({
      label: String(item?.label || item?.role || 'Prompt').trim() || 'Prompt',
      prompt,
    });
  }
  if (!out.length) {
    const fallback = [
      { label: 'System', prompt: receipt.systemPrompt },
      { label: 'Context', prompt: receipt.contextPrompt },
      { label: 'User', prompt: receipt.userPrompt },
      { label: 'Rewrite', prompt: receipt.editorPrompt },
    ];
    for (const item of fallback) {
      const prompt = String(item.prompt || '').trim();
      if (!prompt) continue;
      out.push({ label: item.label, prompt });
    }
  }
  return out.slice(0, 8);
}

export default function ChatMessage({
  kind,
  who,
  text,
  aiReceipt = null,
  deliveryState = '',
  enableReadAloud = false,
  onUsePromptLineage,
}) {
  const isAsema = kind === 'asema';
  const promptLineage = normalizePromptLineage(aiReceipt || {});
  const policyChecks = aiReceipt?.policyChecks || {};

  function speakMessage(raw) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (typeof window === 'undefined' || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(value);
      utterance.rate = 0.98;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[ChatMessage] read-aloud failed', err);
    }
  }

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
            {enableReadAloud ? (
              <button
                type="button"
                className="msg-read-btn"
                onClick={() => speakMessage(text)}
                aria-label="Read message aloud"
                title="Read aloud"
              >
                Read
              </button>
            ) : null}
          </div>
        )}
        {!isAsema && enableReadAloud ? (
          <div className="bubble-read-wrap">
            <button
              type="button"
              className="msg-read-btn"
              onClick={() => speakMessage(text)}
              aria-label="Read message aloud"
              title="Read aloud"
            >
              Read
            </button>
          </div>
        ) : null}
        <div className="bubble-text">
          {renderText(text)}
        </div>
        {!isAsema && deliveryState ? (
          <div className={`msg-delivery msg-delivery-${deliveryState}`}>
            {deliveryState === 'sending'
              ? 'Sending...'
              : deliveryState === 'queued'
              ? 'Queued for retry (offline)'
              : deliveryState}
          </div>
        ) : null}
        {isAsema && aiReceipt && typeof aiReceipt === 'object' ? (
          <details className="ai-receipt">
            <summary>AI with receipts</summary>
            <div className="ai-receipt-body">
              <div><b>Why:</b> {aiReceipt.reason || 'Phase context + room prompt.'}</div>
              <div><b>Confidence:</b> {Math.round(Number(aiReceipt.confidence || 0) * 100)}%</div>
              <div>
                <b>Policy checks:</b>{' '}
                {policyChecks.passed === false ? 'Flagged' : 'Passed'} • tone:{' '}
                {policyChecks.tone || '—'} • strictness:{' '}
                {policyChecks.strictness || '—'}
              </div>
              <div>
                <b>Safety:</b> age mode {policyChecks.ageSafeMode || '—'} • moderation{' '}
                {policyChecks.moderationLevel || '—'}
              </div>
              {Array.isArray(policyChecks.flags) && policyChecks.flags.length ? (
                <div><b>Flags:</b> {policyChecks.flags.join(', ')}</div>
              ) : null}
              <div><b>Data usage:</b> {policyChecks.dataUsage || aiReceipt.dataUsage || 'NO_TRAINING'}</div>
              <div><b>Source:</b> {aiReceipt.source || 'ai'}</div>
              {promptLineage.length ? (
                <div className="ai-lineage-list">
                  <div className="ai-lineage-title">Editable prompt lineage</div>
                  {promptLineage.map((item, idx) => (
                    <div key={`${item.label}-${idx}`} className="ai-lineage-item">
                      <div className="ai-lineage-head">
                        <b>{item.label}</b>
                        <button
                          type="button"
                          className="btn ghost ai-lineage-btn"
                          onClick={() => onUsePromptLineage?.(item.prompt)}
                        >
                          Use in chat
                        </button>
                      </div>
                      <div className="ai-lineage-prompt">{item.prompt}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </motion.div>
  );
}
