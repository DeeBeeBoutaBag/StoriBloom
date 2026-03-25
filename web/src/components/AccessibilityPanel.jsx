import React, { useEffect, useMemo, useState } from 'react';
import { loadA11yPrefs, saveA11yPrefs } from '../a11yPrefs.js';

export default function AccessibilityPanel() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(loadA11yPrefs);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.body;
    root.classList.toggle('a11y-high-contrast', !!prefs.highContrast);
    root.classList.toggle('a11y-dyslexic', !!prefs.dyslexicFont);
    root.classList.toggle('a11y-reduce-motion', !!prefs.reduceMotion);
    root.classList.toggle('a11y-captioned-prompts', !!prefs.captionedPrompts);
    saveA11yPrefs(prefs);
  }, [prefs]);

  const toggleLabel = useMemo(() => (open ? 'Close accessibility' : 'Accessibility'), [open]);

  return (
    <div className="a11y-shell" aria-live="polite">
      <button
        type="button"
        className="a11y-fab"
        aria-label={toggleLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? 'Close' : 'A11y'}
      </button>

      {open ? (
        <aside className="a11y-panel" role="dialog" aria-label="Accessibility controls">
          <div className="a11y-title">Accessibility</div>
          <div className="a11y-subtitle">Adjust visuals and motion for comfort.</div>

          <label className="a11y-option">
            <input
              type="checkbox"
              checked={prefs.highContrast}
              onChange={(e) =>
                setPrefs((prev) => ({ ...prev, highContrast: e.target.checked }))
              }
            />
            <span>High contrast</span>
          </label>

          <label className="a11y-option">
            <input
              type="checkbox"
              checked={prefs.dyslexicFont}
              onChange={(e) =>
                setPrefs((prev) => ({ ...prev, dyslexicFont: e.target.checked }))
              }
            />
            <span>Dyslexia-friendly font</span>
          </label>

          <label className="a11y-option">
            <input
              type="checkbox"
              checked={prefs.reduceMotion}
              onChange={(e) =>
                setPrefs((prev) => ({ ...prev, reduceMotion: e.target.checked }))
              }
            />
            <span>Reduce motion (default on)</span>
          </label>

          <label className="a11y-option">
            <input
              type="checkbox"
              checked={!!prefs.captionedPrompts}
              onChange={(e) =>
                setPrefs((prev) => ({ ...prev, captionedPrompts: e.target.checked }))
              }
            />
            <span>Captioned prompts</span>
          </label>

          <label className="a11y-option">
            <input
              type="checkbox"
              checked={!!prefs.readAloud}
              onChange={(e) =>
                setPrefs((prev) => ({ ...prev, readAloud: e.target.checked }))
              }
            />
            <span>Read aloud helper</span>
          </label>
        </aside>
      ) : null}
    </div>
  );
}
