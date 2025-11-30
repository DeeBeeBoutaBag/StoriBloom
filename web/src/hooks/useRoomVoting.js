// web/src/hooks/useRoomVoting.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders, API_BASE as API } from '../api';

// Small helper so we don't repeat the same pattern everywhere
async function getHeaders() {
  const cfg = await authHeaders();
  // authHeaders is used as the full fetch options object elsewhere,
  // but here we only need the headers object.
  return cfg.headers || cfg;
}

export function useRoomVoting(roomId) {
  const [status, setStatus] = useState({
    votingOpen: false,
    options: [],
    votesReceived: 0,
    counts: [],
  });
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote`, {
        headers: await getHeaders(),
      });
      if (!res.ok) {
        // Non-200s are usually transient (room not ready, etc.)
        return;
      }
      const json = await res.json();

      if (!mountedRef.current) return;

      setStatus({
        votingOpen: !!json.votingOpen,
        options: Array.isArray(json.options) ? json.options : [],
        votesReceived: Number(json.votesReceived || 0),
        counts: Array.isArray(json.counts) ? json.counts : [],
      });
    } catch (err) {
      if (!mountedRef.current) return;
      // Keep UI quiet, but log for debugging
      console.warn('[useRoomVoting] fetchStatus error', err);
    }
  }, [roomId]);

  const startVoting = useCallback(async () => {
    if (!roomId) return false;
    setLoading(true);
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote/start`, {
        method: 'POST',
        headers: await getHeaders(),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start voting');
      }
      await fetchStatus();
      return true;
    } catch (err) {
      console.error('[useRoomVoting] startVoting error', err);
      return false;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const submitVote = useCallback(
    async (choice) => {
      if (!roomId) return false;
      setLoading(true);
      try {
        const res = await fetch(`${API}/rooms/${roomId}/vote/submit`, {
          method: 'POST',
          headers: await getHeaders(),
          body: JSON.stringify({ choice }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Failed to submit vote');
        }
        await fetchStatus();
        return true;
      } catch (err) {
        console.error('[useRoomVoting] submitVote error', err);
        return false;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [roomId, fetchStatus]
  );

  const closeVoting = useCallback(async () => {
    if (!roomId) return false;
    setLoading(true);
    try {
      const res = await fetch(`${API}/rooms/${roomId}/vote/close`, {
        method: 'POST',
        headers: await getHeaders(),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to close voting');
      }
      await fetchStatus();
      return true;
    } catch (err) {
      console.error('[useRoomVoting] closeVoting error', err);
      return false;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [roomId, fetchStatus]);

  // Polling lifecycle
  useEffect(() => {
    // If no roomId, stop polling and reset status to a safe default
    if (!roomId) {
      setStatus({
        votingOpen: false,
        options: [],
        votesReceived: 0,
        counts: [],
      });
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    // Initial fetch
    fetchStatus();

    // Start polling
    if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    pollRef.current = setInterval(fetchStatus, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [roomId, fetchStatus]);

  return {
    status,
    loading,
    startVoting,
    submitVote,
    closeVoting,
    refresh: fetchStatus,
  };
}
