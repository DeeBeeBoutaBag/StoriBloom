// web/src/components/PresenterVotingPanel.jsx
import React, { useMemo } from 'react';
import { useRoomVoting } from '../hooks/useRoomVoting.js';

export default function PresenterVotingPanel({ roomId, isPresenter }) {
  const { status, loading, startVoting, closeVoting, refresh } = useRoomVoting(roomId);

  // Normalize options to { label, num? } for display
  const options = useMemo(() => {
    const arr = Array.isArray(status.options) ? status.options : [];
    return arr.map((opt, i) => {
      if (typeof opt === 'string') return { label: opt, num: i + 1 };
      if (opt && typeof opt === 'object') {
        return {
          label: opt.label ?? String(opt.num ?? i + 1),
          num: opt.num ?? i + 1,
        };
      }
      return { label: String(opt), num: i + 1 };
    });
  }, [status.options]);

  const counts = Array.isArray(status.counts) ? status.counts : [];
  const votesReceived = Number.isFinite(status.votesReceived) ? status.votesReceived : 0;

  const totalVotes = useMemo(
    () => counts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0),
    [counts]
  );

  const maxCount = useMemo(
    () => counts.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0),
    [counts]
  );

  const topic = status.topic || status.selectedTopic || '';

  return (
    <div className="rounded-xl border bg-white/80 backdrop-blur p-4 shadow text-black">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-semibold">Presenter — Topic Voting</h3>
          {topic && (
            <div className="text-xs text-gray-700">
              Selected topic:&nbsp;<span className="font-semibold">{topic}</span>
            </div>
          )}
        </div>
        <div
          className={`text-xs px-2 py-1 rounded ${
            status.votingOpen ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
          }`}
        >
          {status.votingOpen ? 'Voting Open' : 'Voting Closed'}
        </div>
      </div>

      {/* Stats */}
      <div className="text-sm mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="opacity-70">Votes received:</span>
          <span className="font-semibold">{votesReceived}</span>
        </div>
        <div className="flex items-center gap-1 text-xs opacity-70">
          <span>Total counted:</span>
          <span className="font-semibold">{totalVotes}</span>
        </div>
      </div>

      {/* Options list with mini bars */}
      <ol className="list-decimal pl-5 space-y-1.5 mb-3">
        {options.map((opt, i) => {
          const count = counts[i] ?? 0;
          const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;

          return (
            <li key={i} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  {opt.label}
                </span>
                <span className="text-xs rounded bg-gray-100 px-2 py-0.5 min-w-[2.5rem] text-center">
                  {count}
                </span>
              </div>
              {/* result bar */}
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gray-800 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}

        {options.length === 0 && (
          <li className="opacity-60 text-sm">
            No options provided yet.
          </li>
        )}
      </ol>

      {/* Controls for presenter only */}
      {isPresenter && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={startVoting}
            disabled={loading}
            className="px-3 py-2 rounded bg-black text-white text-xs sm:text-sm disabled:opacity-50"
          >
            {loading
              ? 'Working…'
              : status.votingOpen
              ? 'Repost Menu to Room'
              : 'Start Voting'}
          </button>
          <button
            onClick={closeVoting}
            disabled={loading || !status.votingOpen}
            className="px-3 py-2 rounded border text-xs sm:text-sm disabled:opacity-50"
          >
            Close &amp; Lock Topic
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-2 rounded border text-xs sm:text-sm disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
