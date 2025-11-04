// web/src/components/PresenterVotingPanel.jsx
import React, { useMemo } from 'react';
import { useRoomVoting } from '../hooks/useRoomVoting';

export default function PresenterVotingPanel({ roomId, isPresenter }) {
  const { status, loading, startVoting, closeVoting, refresh } = useRoomVoting(roomId);

  const totalVotes = useMemo(
    () => status.counts.reduce((a, b) => a + b, 0),
    [status.counts]
  );

  return (
    <div className="rounded-xl border bg-white/80 backdrop-blur p-4 shadow">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">Presenter — Topic Voting</h3>
        <div className={`text-xs px-2 py-1 rounded ${status.votingOpen ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
          {status.votingOpen ? 'Open' : 'Closed'}
        </div>
      </div>

      <div className="text-sm mb-3">
        <div className="flex items-center gap-2">
          <span className="opacity-70">Votes received:</span>
          <span className="font-semibold">{status.votesReceived}</span>
          <span className="opacity-50">/ total</span>
        </div>
      </div>

      <ol className="list-decimal pl-6 space-y-1 mb-3">
        {(status.options || []).map((opt, i) => (
          <li key={i} className="flex items-center justify-between">
            <span>{opt}</span>
            <span className="text-xs rounded bg-gray-100 px-2 py-0.5">{status.counts[i] || 0}</span>
          </li>
        ))}
      </ol>

      {isPresenter && (
        <div className="flex items-center gap-2">
          <button
            onClick={startVoting}
            disabled={loading}
            className="px-3 py-2 rounded bg-black text-white disabled:opacity-50"
          >
            {loading ? 'Working…' : (status.votingOpen ? 'Repost Menu' : 'Start Voting')}
          </button>
          <button
            onClick={closeVoting}
            disabled={loading || !status.votingOpen}
            className="px-3 py-2 rounded border disabled:opacity-50"
          >
            Close & Lock Topic
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-2 rounded border disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
