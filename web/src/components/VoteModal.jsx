// web/src/components/VoteModal.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap',
];

export default function VoteModal({
  open,
  onClose,
  options,
  onSubmitChoice,
  busy = false,
}) {
  const [choice, setChoice] = useState('');
  const dialogRef = useRef(null);
  const firstButtonRef = useRef(null);
  const inputRef = useRef(null);

  // Normalize options -> [{ num, label }]
  const normalized = useMemo(() => {
    const arr = options && options.length ? options : DEFAULT_ISSUES;
    return arr.map((opt, i) =>
      typeof opt === 'string'
        ? { num: i + 1, label: opt }
        : {
            num: opt?.num ?? i + 1,
            label: opt?.label ?? String(opt?.num ?? i + 1),
          }
    );
  }, [options]);

  // Validate choice
  const valid = useMemo(() => {
    const n = Number(choice);
    return Number.isInteger(n) && n >= 1 && n <= normalized.length;
  }, [choice, normalized.length]);

  // Lock scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC to close, Enter to submit; focus trap
  useEffect(() => {
    if (!open) return;

    const onKey = (e) => {
      // Escape closes
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onClose?.();
      }

      // Enter submits (if valid)
      if (e.key === 'Enter') {
        // Avoid colliding with button click (e.g., hitting Enter on the Close button)
        const tag = (e.target?.tagName || '').toLowerCase();
        if ((tag === 'button' || tag === 'a') && !dialogRef.current?.contains(e.target)) {
          return;
        }
        if (valid && !busy) {
          e.preventDefault();
          onSubmitChoice?.(Number(choice));
        }
      }

      // basic focus trap on Tab
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, busy, valid, choice, onClose, onSubmitChoice]);

  // Autofocus first option, fall back to input
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (firstButtonRef.current) {
          firstButtonRef.current.focus();
        } else {
          inputRef.current?.focus();
        }
      }, 0);
    } else {
      setChoice('');
    }
  }, [open]);

  if (!open) return null;

  const selectedOption = normalized.find(
    (opt) => String(opt.num) === String(choice)
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => !busy && onClose?.()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vote-modal-title"
        aria-describedby="vote-modal-desc"
        className="w-full max-w-lg rounded-2xl bg-white/80 backdrop-blur border border-white/50 shadow-xl p-6 text-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 id="vote-modal-title" className="text-xl font-semibold">
              🗳️ Topic Vote
            </h2>
            <p
              id="vote-modal-desc"
              className="text-xs text-gray-700 mt-1"
            >
              Pick one topic that you want your group to dive into today.
            </p>
          </div>
          <button
            className="text-sm px-2 py-1 rounded border hover:bg-white disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <p className="text-sm mb-3">
          Reply with the <span className="font-semibold">number</span> of your choice
          (one vote each):
        </p>

        <ol className="list-decimal pl-6 space-y-1 mb-4">
          {normalized.map((opt) => (
            <li key={opt.num}>
              <span className="font-medium">{opt.label}</span>
            </li>
          ))}
        </ol>

        <div className="grid grid-cols-3 gap-2 mb-4">
          {normalized.map((opt, idx) => (
            <button
              key={opt.num}
              ref={idx === 0 ? firstButtonRef : null}
              onClick={() => setChoice(String(opt.num))}
              className={`h-12 rounded border text-lg font-semibold transition ${
                choice === String(opt.num)
                  ? 'bg-black text-white border-black'
                  : 'bg-white hover:bg-gray-50 border-gray-300'
              }`}
              disabled={busy}
              aria-pressed={choice === String(opt.num)}
              aria-label={`Choose option ${opt.num}: ${opt.label}`}
            >
              {opt.num}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            value={choice}
            onChange={(e) =>
              setChoice(e.target.value.replace(/[^\d]/g, ''))
            }
            className="border rounded px-3 py-2 w-24"
            placeholder="#"
            inputMode="numeric"
            pattern="[0-9]*"
            disabled={busy}
            aria-invalid={choice !== '' && !valid}
            aria-describedby="vote-help-text"
          />
          <button
            onClick={() => valid && onSubmitChoice(Number(choice))}
            disabled={!valid || busy}
            className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Submit Vote'}
          </button>
          {!valid && choice !== '' && (
            <span id="vote-help-text" className="text-xs text-red-600">
              Enter a number 1–{normalized.length}
            </span>
          )}
        </div>

        {selectedOption && (
          <div className="mt-3 text-xs text-gray-700">
            Selected:&nbsp;
            <span className="font-semibold">
              #{selectedOption.num} — {selectedOption.label}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
