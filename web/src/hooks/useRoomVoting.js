// web/src/hooks/useRoomVoting.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { awsHeaders } from '../lib/awsAuth';

const API = import.meta.env.VITE_API_URL || '/api';

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
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote`, { ...(await awsHeaders()) });
      if (!res.ok) return;
      const json = await res.json();
      setStatus({
        votingOpen: !!json.votingOpen,
        options: json.options || [],
        votesReceived: Number(json.votesReceived || 0),
        counts: json.counts || [],
      });
    } catch {
      // ignore transient errors
    }
  }, [roomId]);

  const startVoting = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote/start`, {
        method: 'POST',
        ...(await awsHeaders()),
      });
      if (!res.ok) {
        const j = await res.json().catch(()=>({}));
        throw new Error(j.error || 'Failed to start voting');
      }
      await fetchStatus();
      return true;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const submitVote = useCallback(async (choice) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote/submit`, {
        method: 'POST',
        ...(await awsHeaders()),
        body: JSON.stringify({ choice })
      });
      if (!res.ok) {
        const j = await res.json().catch(()=>({}));
        throw new Error(j.error || 'Failed to submit vote');
      }
      await fetchStatus();
      return true;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const closeVoting = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote/close`, {
        method: 'POST',
        ...(await awsHeaders()),
      });
      if (!res.ok) {
        const j = await res.json().catch(()=>({}));
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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  return { status, loading, startVoting, submitVote, closeVoting, refresh: fetchStatus };
}
