// web/src/hooks/useRoomVoting.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../lib/apiClient';

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
      const json = await apiGet(`/rooms/${roomId}/vote`);
      setStatus(json);
    } catch {
      // ignore transient errors
    }
  }, [roomId]);

  const startVoting = useCallback(async () => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/start`);
      await fetchStatus();
      return json;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const submitVote = useCallback(async (choice) => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/submit`, { choice });
      await fetchStatus();
      return json;
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const closeVoting = useCallback(async () => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/close`);
      await fetchStatus();
      return json;
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
