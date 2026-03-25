import React, { useEffect, useState } from 'react';

export default function CopilotPanel({
  title = 'Copilot',
  subtitle = 'One-click suggestions',
  suggestions = [],
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    function onToggle() {
      setOpen((prev) => !prev);
    }

    window.addEventListener('copilot:toggle', onToggle);
    return () => window.removeEventListener('copilot:toggle', onToggle);
  }, []);

  useEffect(() => {
    if (!status) return undefined;
    const id = setTimeout(() => setStatus(''), 2200);
    return () => clearTimeout(id);
  }, [status]);

  async function runSuggestion(suggestion) {
    if (!suggestion?.onApply) return;
    try {
      await suggestion.onApply();
      setStatus(suggestion.successText || 'Suggestion applied.');
    } catch (err) {
      setStatus(err.message || 'Could not apply suggestion.');
    }
  }

  return (
    <div className={`copilot-shell ${className}`.trim()}>
      <button type="button" className="copilot-fab" onClick={() => setOpen((prev) => !prev)}>
        {open ? 'Close Copilot' : 'Open Copilot'}
      </button>

      <aside className={`copilot-panel ${open ? 'open' : ''}`}>
        <div className="copilot-head">
          <div className="copilot-title">{title}</div>
          <div className="copilot-subtitle">{subtitle}</div>
        </div>

        <div className="copilot-list">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="copilot-item"
              onClick={() => runSuggestion(suggestion)}
            >
              <div className="copilot-item-title">{suggestion.title}</div>
              <div className="copilot-item-body">{suggestion.description}</div>
            </button>
          ))}

          {!suggestions.length ? (
            <div className="empty-state mini">No suggestions in this view.</div>
          ) : null}
        </div>

        {status ? <div className="copilot-status">{status}</div> : null}
      </aside>
    </div>
  );
}
