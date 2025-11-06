// web/src/hooks/useRoomVoting.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders, API_BASE } from '../api.js';

export function useRoomVoting(roomId) {
  const [status, setStatus] = useState({
    votingOpen: false,
    options: [],
    votesReceived: 0,
    counts: [],
  });
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote`, {
        method: 'GET',
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const json = await res.json();
      setStatus({
        votingOpen: !!json.votingOpen,
        options: Array.isArray(json.options) ? json.options : [],
        votesReceived: Number(json.votesReceived || 0),
        counts: Array.isArray(json.counts) ? json.counts : [],
      });
    } catch {
      // ignore transient errors
    }
  }, [roomId]);

  const startVoting = useCallback(async () => {
    if (!roomId) return false;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote/start`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start voting');
      }
      await fetchStatus();
      return true;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const submitVote = useCallback(
    async (choice) => {
      if (!roomId) return false;
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/vote/submit`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ choice: Number(choice) }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Failed to submit vote');
        }
        await fetchStatus();
        return true;
      } finally {
        setLoading(false);
      }
    },
    [roomId, fetchStatus]
  );

  const closeVoting = useCallback(async () => {
    if (!roomId) return false;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote/close`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to close voting');
      }
      await fetchStatus();
      return true;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  useEffect(() => {
    fetchStatus();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchStatus, 2000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [fetchStatus]);

  return { status, loading, startVoting, submitVote, closeVoting, refresh: fetchStatus };
}
