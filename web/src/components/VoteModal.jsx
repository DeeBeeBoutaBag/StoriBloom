import React, { useMemo, useState } from 'react';

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
  const opts = options && options.length ? options : DEFAULT_ISSUES;

  const valid = useMemo(() => {
    const n = Number(choice);
    return Number.isInteger(n) && n >= 1 && n <= opts.length;
  }, [choice, opts.length]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-2xl bg-white/80 backdrop-blur border border-white/50 shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">🗳️ Topic Vote</h2>
          <button
            className="text-sm px-2 py-1 rounded border"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <p className="text-sm mb-3">
          Reply with the number of your choice (one vote each):
        </p>

        <ol className="list-decimal pl-6 space-y-1 mb-4">
          {opts.map((opt, idx) => (
            <li key={idx}><span className="font-medium">{opt}</span></li>
          ))}
        </ol>

        <div className="grid grid-cols-3 gap-2 mb-4">
          {Array.from({ length: opts.length }).map((_, i) => (
            <button
              key={i}
              onClick={() => setChoice(String(i + 1))}
              className={`h-12 rounded border text-lg font-semibold ${
                choice === String(i + 1) ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'
              }`}
              disabled={busy}
            >
              {i + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <input
            value={choice}
            onChange={(e) => setChoice(e.target.value.replace(/[^\d]/g, ''))}
            className="border rounded px-3 py-2 w-24"
            placeholder="#"
            disabled={busy}
          />
          <button
            onClick={() => valid && onSubmitChoice(Number(choice))}
            disabled={!valid || busy}
            className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Submit Vote'}
          </button>
          {!valid && choice !== '' && (
            <span className="text-xs text-red-600">Enter a number 1–{opts.length}</span>
          )}
        </div>
      </div>
    </div>
  );
}
