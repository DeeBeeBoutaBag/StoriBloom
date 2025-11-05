// web/src/hooks/useRoomVoting.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../lib/apiClient';

function normalizeVote(vote) {
  // vote shape from API:
  // { open: boolean, options: [{n, text}], votesByUid: { [uid]: number }, lockedAt: number, chosen: {n,text}|null }
  const open = !!vote?.open;
  const options = Array.isArray(vote?.options) ? vote.options : [];
  const votesByUid = vote?.votesByUid && typeof vote.votesByUid === 'object' ? vote.votesByUid : {};
  const lockedAt = Number(vote?.lockedAt || 0);
  const chosen = vote?.chosen || null;

  const totalVotes = Object.keys(votesByUid).length;
  const countsMap = {};
  for (const n of Object.values(votesByUid)) {
    const key = String(n);
    countsMap[key] = (countsMap[key] || 0) + 1;
  }

  const counts = options.map(o => {
    const c = countsMap[String(o.n)] || 0;
    const percent = totalVotes > 0 ? Math.round((c / totalVotes) * 100) : 0;
    return { n: o.n, text: o.text, count: c, percent };
  });

  return { open, options, totalVotes, counts, lockedAt, chosen };
}

export function useRoomVoting(roomId) {
  const [status, setStatus] = useState(() => normalizeVote(null));
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);
  const submittedOnceRef = useRef(false); // local UX hint; server still enforces one vote per uid

  const fetchStatus = useCallback(async () => {
    try {
      const json = await apiGet(`/rooms/${roomId}/vote`);
      // API returns { vote: {...} } or { vote: null }
      const norm = normalizeVote(json?.vote || null);
      setStatus(norm);
      return norm;
    } catch {
      // ignore transient errors
      return null;
    }
  }, [roomId]);

  const startVoting = useCallback(async () => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/start`);
      await fetchStatus();
      return json; // { ok, options }
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const submitVote = useCallback(async (choice) => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/submit`, { choice });
      submittedOnceRef.current = true;
      await fetchStatus();
      return json; // { ok, choice }
    } finally {
      setLoading(false);
    }
  }, [roomId, fetchStatus]);

  const closeVoting = useCallback(async () => {
    setLoading(true);
    try {
      const json = await apiPost(`/rooms/${roomId}/vote/close`);
      await fetchStatus();
      return json; // { ok, chosen }
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

  return {
    status,           // { open, options, totalVotes, counts:[{n,text,count,percent}], lockedAt, chosen }
    loading,
    startVoting,
    submitVote,
    closeVoting,
    refresh: fetchStatus,
    // optional UX hint (client-side only; server is source of truth)
    submittedOnce: submittedOnceRef.current,
  };
}
