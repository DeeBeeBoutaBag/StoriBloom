// web/src/pages/Presenter.jsx
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE, buildSseUrl } from '../api.js';
import PresenterHUD from '../components/PresenterHUD.jsx';
import PresenterVotingPanel from '../components/PresenterVotingPanel.jsx';
import CopilotPanel from '../components/CopilotPanel.jsx';
import MissionControlPanel from '../components/MissionControlPanel.jsx';
import PremiumExportActions from '../components/PremiumExportActions.jsx';

const STAGES = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
];

function useSiteIdFromUrl() {
  const { siteId: siteIdParam } = useParams();
  const [siteId, setSiteId] = useState(() => {
    const fromUrl = (siteIdParam || '').toUpperCase();
    if (fromUrl) {
      sessionStorage.setItem('presenter_siteId', fromUrl);
      return fromUrl;
    }
    return (sessionStorage.getItem('presenter_siteId') || '').toUpperCase();
  });

  useEffect(() => {
    if (siteId) {
      sessionStorage.setItem('presenter_siteId', siteId.toUpperCase());
    }
  }, [siteId]);

  return [siteId, setSiteId];
}

function formatClosedAt(ms) {
  const n = Number(ms || 0);
  if (!n) return '';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '';
  }
}

function describeGateMissing(missing = []) {
  const labels = {
    topic_chosen: 'Topic',
    idea_board_filled: 'Idea board',
    plan_outlined: 'Plan',
    rough_draft_ready: 'Draft',
    evidence_board_complete: 'Evidence board',
    draft_approved: 'Approval',
  };
  return (Array.isArray(missing) ? missing : [])
    .map((id) => labels[id] || id)
    .join(', ');
}

const ACTIVE_STAGES = new Set([
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
]);

function stageLabel(stage = '') {
  return String(stage || 'LOBBY').replace(/_/g, ' ');
}

function secondsLeft(ts) {
  const n = Number(ts || 0);
  if (!n) return null;
  return Math.floor((n - Date.now()) / 1000);
}

function formatTimer(sec) {
  if (!Number.isFinite(Number(sec))) return '—';
  const raw = Number(sec);
  const sign = raw < 0 ? '-' : '';
  const v = Math.abs(Math.floor(raw));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

function formatAgo(ts) {
  const n = Number(ts || 0);
  if (!n) return '—';
  const delta = Math.max(0, Math.floor((Date.now() - n) / 1000));
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusLabel(ok) {
  return ok ? 'Healthy' : 'Issue';
}

async function copyToClipboard(text) {
  const t = String(text || '');
  if (!t) return false;

  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    // fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function Presenter() {
  const [siteId, setSiteId] = useSiteIdFromUrl();
  const [rooms, setRooms] = useState([]);
  const [roomSignals, setRoomSignals] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [voteRefreshSeq, setVoteRefreshSeq] = useState(0);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('presenter_view_mode') || 'control');
  const [autopilotConfig, setAutopilotConfig] = useState({
    enabled: false,
    autoNudgeOnStuck: true,
    autoVote: true,
    autoAdvance: true,
    nudgeBeforeEndSec: 45,
    stuckInactivitySec: 120,
    interventionExtendSec: 120,
  });
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [selectedRoomIds, setSelectedRoomIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [gateDrawerRoomId, setGateDrawerRoomId] = useState('');
  const [drilldownRoomId, setDrilldownRoomId] = useState('');
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownState, setDrilldownState] = useState(null);
  const [drilldownMessages, setDrilldownMessages] = useState([]);
  const [mergeInbox, setMergeInbox] = useState([]);
  const [mergeInboxLoading, setMergeInboxLoading] = useState(false);
  const [alertFeed, setAlertFeed] = useState([]);
  const [healthStatus, setHealthStatus] = useState({
    api: { ok: true, error: '' },
    aws: { ok: false, error: '' },
    openai: { ok: false, error: '' },
    sse: { ok: false, error: 'connecting' },
    updatedAt: 0,
  });
  const [nowTick, setNowTick] = useState(Date.now());
  const roomStallAlertsRef = useRef({});
  const roomsPrimedRef = useRef(false);
  const previousRoomsRef = useRef(new Map());

  // Gallery state
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState('');
  const [galleryItems, setGalleryItems] = useState([]);
  const [galleryCopiedRoom, setGalleryCopiedRoom] = useState('');

  const canFetch = useMemo(() => !!(siteId && siteId.trim().length), [siteId]);

  useEffect(() => {
    localStorage.setItem('presenter_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    const tick = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  const loadRoomSignals = useCallback(async (roomList) => {
    const list = Array.isArray(roomList) ? roomList : [];
    if (!list.length) {
      setRoomSignals({});
      return;
    }

    try {
      const results = await Promise.all(
        list.map(async (room) => {
          const res = await fetch(`${API_BASE}/rooms/${room.id}/presence`, {
            ...(await authHeaders()),
          });
          if (!res.ok) {
            return [room.id, { typing: [], contributionHeat: [], equity: { quietCount: 0 } }];
          }
          const data = await res.json().catch(() => ({}));
          return [
            room.id,
            {
              typing: Array.isArray(data.typing) ? data.typing : [],
              contributionHeat: Array.isArray(data.contributionHeat) ? data.contributionHeat : [],
              equity: data.equity && typeof data.equity === 'object' ? data.equity : { quietCount: 0 },
            },
          ];
        })
      );
      setRoomSignals(Object.fromEntries(results));
    } catch (err) {
      console.warn('[Presenter] room signal load failed', err);
    }
  }, []);

  const pushAlert = useCallback((entry = {}) => {
    const next = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      severity: 'info',
      label: '',
      roomId: '',
      ...entry,
    };
    if (!next.label) return;
    setAlertFeed((prev) => [next, ...prev].slice(0, 80));
  }, []);

  const loadDependencyHealth = useCallback(async () => {
    if (!authReady) return;
    try {
      const res = await fetch(`${API_BASE}/health/dependencies`, {
        ...(await authHeaders()),
      });
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      const deps = body?.dependencies || {};
      setHealthStatus((prev) => ({
        ...prev,
        api: deps.api || prev.api,
        aws: deps.aws || prev.aws,
        openai: deps.openai || prev.openai,
        updatedAt: Date.now(),
      }));
    } catch (err) {
      console.warn('[Presenter] dependency health fetch failed', err);
      setHealthStatus((prev) => ({
        ...prev,
        api: { ok: false, error: 'health_check_failed' },
        updatedAt: Date.now(),
      }));
    }
  }, [authReady]);

  const loadAutopilot = useCallback(async () => {
    if (!siteId || !authReady) return;
    try {
      const url = new URL(`${API_BASE}/presenter/autopilot`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());
      const res = await fetch(url.toString(), {
        ...(await authHeaders()),
      });
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      if (body?.autopilot) {
        setAutopilotConfig((prev) => ({
          ...prev,
          ...body.autopilot,
        }));
      }
    } catch (err) {
      console.warn('[Presenter] autopilot fetch failed', err);
    }
  }, [authReady, siteId]);

  async function saveAutopilot(patch) {
    if (!siteId || !authReady) return;
    const next = {
      ...autopilotConfig,
      ...(patch || {}),
    };
    setAutopilotBusy(true);
    setError('');
    try {
      const url = new URL(`${API_BASE}/presenter/autopilot`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());
      const res = await fetch(url.toString(), {
        method: 'PUT',
        ...(await authHeaders()),
        body: JSON.stringify(next),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `autopilot update failed (${res.status})`);
      }
      setAutopilotConfig((prev) => ({
        ...prev,
        ...(body.autopilot || next),
      }));
      setNotice('Autopilot updated.');
    } catch (err) {
      console.error('[Presenter] autopilot update failed', err);
      setError(err.message || 'Could not update autopilot.');
    } finally {
      setAutopilotBusy(false);
    }
  }

  // ── Auth bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    ensureGuest()
      .then(() => {
        if (active) setAuthReady(true);
      })
      .catch((e) => {
        console.warn('[Presenter] ensureGuest failed', e);
        if (active) setAuthReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // ── Fetch rooms list ────────────────────────────────────────────────────
  const loadRooms = useCallback(async () => {
    if (!canFetch || !authReady) return;
    setLoading(true);
    setError('');
    try {
      const url = new URL(`${API_BASE}/presenter/rooms`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());

      const res = await fetch(url.toString(), {
        ...(await authHeaders()),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `rooms fetch failed (${res.status})`);
      }

      const j = await res.json();
      const list = Array.isArray(j.rooms) ? j.rooms : [];
      setRooms(list);
      void loadRoomSignals(list);
    } catch (err) {
      console.error('[Presenter] rooms load error:', err);
      setRooms([]);
      setRoomSignals({});
      setError(err.message || 'Could not load rooms.');
    } finally {
      setLoading(false);
    }
  }, [siteId, canFetch, authReady, loadRoomSignals]);

  useEffect(() => {
    if (!canFetch || !authReady) return;
    loadRooms();
  }, [canFetch, authReady, loadRooms]);

  useEffect(() => {
    if (!canFetch || !authReady) return;
    loadAutopilot();
  }, [canFetch, authReady, loadAutopilot]);

  useEffect(() => {
    if (!authReady) return;
    loadDependencyHealth();
    const t = setInterval(() => {
      loadDependencyHealth();
    }, 20_000);
    return () => clearInterval(t);
  }, [authReady, loadDependencyHealth]);

  // ── Simple POST helper for controls ─────────────────────────────────────
  async function post(path, body, options = {}) {
    const quiet = !!options.quiet;
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        ...(await authHeaders()),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Action failed (${res.status})`);
      }
      return true;
    } catch (err) {
      console.error('[Presenter] action error', err);
      if (!quiet) {
        alert(err.message || 'Action failed');
      }
      return false;
    }
  }

  const next = (roomId, options) => post(`/rooms/${roomId}/next`, undefined, options);
  const extend = (roomId, secs = 120, options) =>
    post(`/rooms/${roomId}/extend`, { by: secs }, options);
  const redo = (roomId, options) => post(`/rooms/${roomId}/redo`, undefined, options);
  const lock = (roomId, options) =>
    post(`/rooms/${roomId}/lock`, { inputLocked: true }, options);
  const unlock = (roomId, options) =>
    post(`/rooms/${roomId}/lock`, { inputLocked: false }, options);

  const startVote = (roomId, options) => post(`/rooms/${roomId}/vote/start`, undefined, options);
  const closeVote = (roomId, options) => post(`/rooms/${roomId}/vote/close`, undefined, options);
  const intervene = (roomId, kind, body = {}) =>
    post(`/rooms/${roomId}/intervention`, { kind, ...(body || {}) });
  const reopenVoting = (roomId, options) =>
    post(`/rooms/${roomId}/intervention`, { kind: 'reopen_voting' }, options);
  const nudgeQuiet = (roomId, options) =>
    post(`/rooms/${roomId}/intervention`, { kind: 'nudge_quiet' }, options);

  // NEW: close FINAL room from presenter dashboard
  const closeFinal = (roomId, options) => post(`/rooms/${roomId}/final/close`, undefined, options);

  async function sendRoomNudge(roomId, { skipRefresh = false } = {}) {
    const nudge =
      'Facilitator nudge: each person share one concrete line now (fact, feeling, or key story beat), then pick one to build on together.';
    const ok = await post(`/rooms/${roomId}/messages`, {
      text: nudge,
      phase: 'DISCOVERY',
      personaIndex: 0,
      emoji: '🧭',
    });
    if (ok) {
      setNotice(`Nudge sent to room ${roomId}.`);
      if (!skipRefresh) await loadRooms();
    }
    return ok;
  }

  async function runIntervention(roomId, intervention = 'monitor') {
    const kind = String(intervention || 'monitor').trim().toLowerCase();
    let changed = false;
    if (kind === 'nudge_extend') {
      const nudgeOk = await sendRoomNudge(roomId, { skipRefresh: true });
      const extendOk = await extend(roomId, 120);
      changed = nudgeOk || extendOk;
      if (changed) setNotice(`Auto intervention run for ${roomId}: nudge +2m.`);
    } else if (kind === 'extend_next') {
      const extendOk = await extend(roomId, 120);
      changed = !!extendOk;
      if (changed) setNotice(`Auto intervention run for ${roomId}: timer extended.`);
    } else if (kind === 'unlock_nudge') {
      const unlockOk = await unlock(roomId);
      const nudgeOk = await sendRoomNudge(roomId, { skipRefresh: true });
      changed = unlockOk || nudgeOk;
      if (changed) setNotice(`Auto intervention run for ${roomId}: unlocked + nudge.`);
    } else if (kind === 'nudge') {
      changed = await sendRoomNudge(roomId, { skipRefresh: true });
      if (changed) setNotice(`Auto intervention run for ${roomId}: nudge sent.`);
    } else {
      setNotice(`Monitoring ${roomId}. No intervention recommended yet.`);
    }
    if (changed) await loadRooms();
  }

  function toggleRoomSelection(roomId) {
    const id = String(roomId || '').trim();
    if (!id) return;
    setSelectedRoomIds((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    );
  }

  function clearSelectedRooms() {
    setSelectedRoomIds([]);
  }

  async function runBulkAction(kind) {
    const ids = selectedRoomIds.slice();
    if (!ids.length) {
      setNotice('Select at least one room for bulk actions.');
      return;
    }
    setBulkBusy(true);
    setError('');
    const tasks = ids.map(async (roomId) => {
      if (kind === 'extend') return extend(roomId, 120, { quiet: true });
      if (kind === 'unlock') return unlock(roomId, { quiet: true });
      if (kind === 'nudge') return nudgeQuiet(roomId, { quiet: true });
      if (kind === 'reopen_vote') return reopenVoting(roomId, { quiet: true });
      return false;
    });
    const settled = await Promise.allSettled(tasks);
    const okCount = settled.filter((row) => row.status === 'fulfilled' && row.value).length;
    const failCount = settled.length - okCount;
    if (okCount > 0) {
      setNotice(`Bulk action complete: ${okCount}/${ids.length} rooms updated.`);
    }
    if (failCount > 0) {
      setError(`${failCount} room action${failCount === 1 ? '' : 's'} failed.`);
    }
    setBulkBusy(false);
    await loadRooms();
  }

  async function runPlaybook(kind) {
    const selected = selectedRoomIds.length
      ? sortedRooms.filter((room) => selectedRoomIds.includes(room.id))
      : priorityQueue.filter((row) => row.needsAttention).slice(0, 4).map((row) => row.room);
    if (!selected.length) {
      setNotice('No target rooms available for this playbook.');
      return;
    }
    setBulkBusy(true);
    setError('');
    let executed = 0;
    try {
      for (const room of selected) {
        const roomId = room.id;
        if (kind === 'recover_stuck') {
          // eslint-disable-next-line no-await-in-loop
          const a = await unlock(roomId, { quiet: true });
          // eslint-disable-next-line no-await-in-loop
          const b = await extend(roomId, 120, { quiet: true });
          // eslint-disable-next-line no-await-in-loop
          const c = await nudgeQuiet(roomId, { quiet: true });
          if (a || b || c) executed += 1;
        } else if (kind === 'finalize_3m') {
          // eslint-disable-next-line no-await-in-loop
          const a = await closeVote(roomId, { quiet: true });
          // eslint-disable-next-line no-await-in-loop
          const b = await extend(roomId, 180, { quiet: true });
          // eslint-disable-next-line no-await-in-loop
          const c = await nudgeQuiet(roomId, { quiet: true });
          if (a || b || c) executed += 1;
        } else if (kind === 'rebalance') {
          // eslint-disable-next-line no-await-in-loop
          const ok = await nudgeQuiet(roomId, { quiet: true });
          if (ok) executed += 1;
        }
      }
      if (executed > 0) {
        setNotice(`Playbook applied to ${executed}/${selected.length} rooms.`);
      } else {
        setError('Playbook ran but no room accepted updates.');
      }
    } finally {
      setBulkBusy(false);
    }
    await loadRooms();
  }

  const loadRoomDrilldown = useCallback(
    async (roomId) => {
      const id = String(roomId || '').trim();
      if (!id || !authReady) return;
      setDrilldownLoading(true);
      try {
        const [stateRes, msgRes] = await Promise.all([
          fetch(`${API_BASE}/rooms/${id}/state`, {
            ...(await authHeaders()),
          }),
          fetch(`${API_BASE}/rooms/${id}/messages?limit=50`, {
            ...(await authHeaders()),
          }),
        ]);
        const stateBody = await stateRes.json().catch(() => ({}));
        const msgBody = await msgRes.json().catch(() => ({}));
        if (!stateRes.ok) {
          throw new Error(stateBody.error || `room state failed (${stateRes.status})`);
        }
        setDrilldownState(stateBody);
        setDrilldownMessages(Array.isArray(msgBody.messages) ? msgBody.messages : []);
      } catch (err) {
        console.error('[Presenter] room drilldown failed', err);
        setError(err.message || 'Could not load room drilldown.');
      } finally {
        setDrilldownLoading(false);
      }
    },
    [authReady]
  );

  async function openRoomDrilldown(roomId) {
    const id = String(roomId || '').trim();
    if (!id) return;
    setDrilldownRoomId(id);
    await loadRoomDrilldown(id);
  }

  const loadMergeInbox = useCallback(async () => {
    if (!authReady) return;
    const roomTargets = [...rooms]
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .filter((room) => Number(room?.privateDraftQueueCount || 0) > 0)
      .slice(0, 16);
    if (!roomTargets.length) {
      setMergeInbox([]);
      return;
    }
    setMergeInboxLoading(true);
    try {
      const headers = await authHeaders();
      const rows = await Promise.all(
        roomTargets.map(async (room) => {
          const res = await fetch(`${API_BASE}/rooms/${room.id}/private-draft`, {
            ...headers,
          });
          if (!res.ok) return [];
          const body = await res.json().catch(() => ({}));
          const submissions = Array.isArray(body.submissions) ? body.submissions : [];
          return submissions
            .filter((submission) => !Number(submission?.mergedAt || 0))
            .map((submission) => ({
              ...submission,
              roomId: room.id,
              roomIndex: room.index,
              roomStage: room.stage || 'LOBBY',
            }));
        })
      );
      setMergeInbox(
        rows
          .flat()
          .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0))
          .slice(0, 60)
      );
    } catch (err) {
      console.warn('[Presenter] merge inbox fetch failed', err);
      setMergeInbox([]);
    } finally {
      setMergeInboxLoading(false);
    }
  }, [authReady, rooms]);

  async function mergeSubmission(roomId, sourceUid, mode = 'append') {
    const ok = await post(
      `/rooms/${roomId}/private-draft/merge`,
      {
        sourceUid,
        mode,
      },
      { quiet: true }
    );
    if (ok) {
      setNotice(
        mode === 'replace'
          ? `Merged ${sourceUid} into Room ${roomId} as replacement draft.`
          : `Merged ${sourceUid} into Room ${roomId} shared draft.`
      );
      await Promise.all([loadRooms(), loadMergeInbox()]);
    } else {
      setError(`Could not merge ${sourceUid} for ${roomId}.`);
    }
  }

  async function approveRoomDraft(roomId) {
    const ok = await post(`/rooms/${roomId}/draft/approve`, { approved: true }, { quiet: true });
    if (ok) {
      setNotice(`Draft approved for ${roomId}.`);
      await loadRooms();
    } else {
      setError(`Draft approval failed for ${roomId}.`);
    }
  }

  // ── Gallery fetch ───────────────────────────────────────────────────────
  const loadGallery = useCallback(async () => {
    if (!canFetch || !authReady) return;
    setGalleryLoading(true);
    setGalleryError('');
    setGalleryCopiedRoom('');
    try {
      const url = new URL(`${API_BASE}/presenter/gallery`, window.location.origin);
      url.searchParams.set('siteId', siteId.toUpperCase());

      const res = await fetch(url.toString(), {
        ...(await authHeaders()),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `gallery fetch failed (${res.status})`);
      }

      const j = await res.json();
      const items = Array.isArray(j.items) ? j.items : [];

      // Normalize so UI always has: roomId, topic, abstract, closedAt
      const normalized = items
        .map((it) => ({
          siteId: (it.siteId || siteId || '').toUpperCase(),
          roomId: it.roomId || it.id || '',
          index: Number(it.index || 0) || null,
          topic: it.topic || '',
          abstract: it.abstract || it.finalAbstract || '',
          closedAt: it.closedAt || it.finalCompletedAt || null,
          closedBy: it.closedBy || '',
        }))
        .filter((it) => it.roomId);

      // Sort newest first
      normalized.sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0));

      setGalleryItems(normalized);
    } catch (err) {
      console.error('[Presenter] gallery load error:', err);
      setGalleryItems([]);
      setGalleryError(err.message || 'Could not load gallery.');
    } finally {
      setGalleryLoading(false);
    }
  }, [siteId, canFetch, authReady]);

  // When opening the modal, load immediately
  useEffect(() => {
    if (!galleryOpen) return;
    loadGallery();
  }, [galleryOpen, loadGallery]);

  useEffect(() => {
    if (!canFetch || !authReady) return;

    const es = new EventSource(
      buildSseUrl(`/presenter/events?siteId=${encodeURIComponent(siteId.toUpperCase())}`)
    );

    const onRoomUpdate = (event) => {
      let payload = {};
      try {
        payload = JSON.parse(String(event?.data || '{}'));
      } catch {}
      if (payload?.roomId && payload?.event === 'vote_update') {
        pushAlert({
          severity: 'warn',
          roomId: payload.roomId,
          label: `Vote activity updated for ${payload.roomId}.`,
        });
      }
      if (payload?.roomId && payload?.event === 'final_closed') {
        pushAlert({
          severity: 'critical',
          roomId: payload.roomId,
          label: `${payload.roomId} closed.`,
        });
      }
      loadRooms();
      if (galleryOpen) loadGallery();
      setVoteRefreshSeq((n) => n + 1);
      setHealthStatus((prev) => ({
        ...prev,
        sse: { ok: true, error: '' },
      }));
    };
    const onReady = () => {
      setHealthStatus((prev) => ({
        ...prev,
        sse: { ok: true, error: '' },
      }));
      loadRooms();
    };

    es.addEventListener('room_update', onRoomUpdate);
    es.addEventListener('ready', onReady);
    es.onerror = () => {
      // Browser EventSource auto-reconnects.
      setHealthStatus((prev) => ({
        ...prev,
        sse: { ok: false, error: 'reconnecting' },
      }));
    };

    return () => {
      es.removeEventListener('room_update', onRoomUpdate);
      es.removeEventListener('ready', onReady);
      es.close();
    };
  }, [canFetch, authReady, galleryOpen, loadGallery, loadRooms, pushAlert, siteId]);

  // ── Derived summary for header ──────────────────────────────────────────
  const stageSummary = useMemo(() => {
    const byStage = {};
    for (const s of STAGES) byStage[s] = 0;
    rooms.forEach((r) => {
      const s = r.stage || 'LOBBY';
      if (!byStage[s]) byStage[s] = 0;
      byStage[s] += 1;
    });
    return byStage;
  }, [rooms]);

  const estimatedSeats = useMemo(
    () => rooms.reduce((sum, r) => sum + (Number(r.seats) || 0), 0),
    [rooms]
  );
  const blockedRoomCount = useMemo(
    () => rooms.filter((room) => room?.phaseExitGate?.ok === false).length,
    [rooms]
  );
  const fallbackActiveCount = useMemo(
    () => rooms.filter((room) => room?.aiFallback?.active).length,
    [rooms]
  );

  const priorityQueue = useMemo(() => {
    const stuckThresholdSec = Math.max(30, Number(autopilotConfig.stuckInactivitySec || 120) || 120);
    const now = nowTick;
    return rooms
      .map((room) => {
        const signal = roomSignals[room.id] || {};
        const stage = String(room.stage || 'LOBBY').toUpperCase();
        const activeStage = ACTIVE_STAGES.has(stage);
        const gateBlocked = room?.phaseExitGate?.ok === false;
        const quality = Math.max(0, Math.min(100, Number(room?.qualityScorecard?.total || 0)));
        const quietCount = Math.max(0, Number(signal?.equity?.quietCount || 0) || 0);
        const fallbackActive = !!room?.aiFallback?.active;
        const mergeQueueCount = Number(room?.privateDraftQueueCount || 0) || 0;
        const approvalsNeeded =
          Math.max(0, Number(room?.draftApproval?.requiredApprovals || 1)) -
          Math.max(0, Number(room?.draftApproval?.approvedCount || 0));
        const lastMsgAt = Number(room?.lastParticipantMessageAt || 0) || 0;
        const idleSec = lastMsgAt ? Math.floor((now - lastMsgAt) / 1000) : null;
        const hasIdle = idleSec !== null;
        const stuck = !!(activeStage && hasIdle && Number(idleSec) >= stuckThresholdSec);
        const stageLeftSec = secondsLeft(room?.stageEndsAt);
        const stageOverrunSec = Number.isFinite(Number(stageLeftSec)) && Number(stageLeftSec) < 0
          ? Math.abs(Number(stageLeftSec))
          : 0;
        const pendingApprovals = approvalsNeeded > 0 && ['EDITING', 'FINAL'].includes(stage);
        const draftUpdatedAt = Number(room?.draftUpdatedAt || 0) || 0;
        const approvalAgeSec = pendingApprovals && draftUpdatedAt
          ? Math.floor((now - draftUpdatedAt) / 1000)
          : null;
        const stuckCountdownSec = hasIdle ? stuckThresholdSec - Number(idleSec) : null;

        const reasons = [];
        let score = 0;
        if (gateBlocked) {
          score += 40;
          reasons.push('Gate blocked');
        }
        if (quality < 75) {
          score += Math.ceil((75 - quality) * 0.7);
          reasons.push(`Low quality (${quality})`);
        }
        if (quietCount > 0) {
          score += Math.min(24, quietCount * 8);
          reasons.push(`${quietCount} quiet`);
        }
        if (fallbackActive) {
          score += 20;
          reasons.push('AI fallback active');
        }
        if (stuck) {
          score += 28;
          reasons.push('Room stalled');
        }
        if (stageOverrunSec > 0) {
          score += Math.min(16, Math.ceil(stageOverrunSec / 30));
          reasons.push('Phase overrun');
        }
        if (pendingApprovals) {
          score += Math.min(14, approvalsNeeded * 7);
          reasons.push(`Approvals pending (${approvalsNeeded})`);
        }
        if (mergeQueueCount > 0) {
          score += Math.min(10, mergeQueueCount * 2);
          reasons.push(`Merge queue (${mergeQueueCount})`);
        }

        return {
          room,
          score: Math.max(0, Math.min(100, score)),
          reasons,
          gateBlocked,
          quality,
          quietCount,
          fallbackActive,
          stuck,
          stageLeftSec,
          stageOverrunSec,
          pendingApprovals,
          approvalsNeeded,
          approvalAgeSec,
          mergeQueueCount,
          stuckCountdownSec,
          idleSec,
          needsAttention: score >= 45,
        };
      })
      .sort((a, b) => b.score - a.score || (a.room.index || 0) - (b.room.index || 0));
  }, [autopilotConfig.stuckInactivitySec, nowTick, roomSignals, rooms]);

  const approvalQueue = useMemo(
    () =>
      rooms
        .map((room) => {
          const stage = String(room.stage || 'LOBBY').toUpperCase();
          if (!['EDITING', 'FINAL'].includes(stage)) return null;
          const approvedCount = Math.max(0, Number(room?.draftApproval?.approvedCount || 0));
          const requiredApprovals = Math.max(1, Number(room?.draftApproval?.requiredApprovals || 1));
          if (approvedCount >= requiredApprovals) return null;
          const roster = Array.isArray(room?.draftApproval?.roster) ? room.draftApproval.roster : [];
          const missingApprovals = roster.filter((row) => !row?.approved);
          const staleSeconds = room?.draftUpdatedAt
            ? Math.max(0, Math.floor((nowTick - Number(room.draftUpdatedAt || 0)) / 1000))
            : 0;
          return {
            room,
            approvedCount,
            requiredApprovals,
            roster,
            missingApprovals,
            staleSeconds,
          };
        })
        .filter(Boolean)
        .sort(
          (a, b) =>
            Number(b.missingApprovals?.length || 0) - Number(a.missingApprovals?.length || 0) ||
            Number(b.staleSeconds || 0) - Number(a.staleSeconds || 0)
        ),
    [rooms, nowTick]
  );

  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => (a.index || 0) - (b.index || 0)),
    [rooms]
  );
  const leadRoom = sortedRooms[0] || null;
  const compactMode = viewMode === 'control';
  const gateDrawerRoom = useMemo(
    () => rooms.find((room) => room.id === gateDrawerRoomId) || null,
    [rooms, gateDrawerRoomId]
  );
  const drilldownRoomSummary = useMemo(
    () => rooms.find((room) => room.id === drilldownRoomId) || null,
    [rooms, drilldownRoomId]
  );
  const selectedRoomSet = useMemo(() => new Set(selectedRoomIds), [selectedRoomIds]);
  const attentionQueue = useMemo(
    () => priorityQueue.filter((row) => row.needsAttention),
    [priorityQueue]
  );
  const priorityByRoomId = useMemo(
    () =>
      Object.fromEntries(priorityQueue.map((row) => [row.room.id, row])),
    [priorityQueue]
  );

  const copilotSuggestions = useMemo(
    () => [
      {
        id: 'copilot-room-script',
        title: 'Copy facilitation nudge',
        description: 'Copy a one-line room nudge for quiet groups.',
        successText: 'Facilitation nudge copied.',
        onApply: async () => {
          const ok = await copyToClipboard(
            'Quick pulse check: each table share one bold sentence and one blocker before we move on.'
          );
          if (!ok) throw new Error('Clipboard is blocked in this browser.');
        },
      },
      {
        id: 'copilot-gallery-review',
        title: 'Open final gallery',
        description: 'Jump to closed-room outputs for fast quality review.',
        successText: 'Gallery opened.',
        onApply: async () => {
          setGalleryOpen(true);
          await loadGallery();
        },
      },
      {
        id: 'copilot-refresh-floor',
        title: 'Refresh room floor',
        description: 'Pull live room updates and vote status immediately.',
        successText: 'Room floor refreshed.',
        onApply: async () => {
          await loadRooms();
        },
      },
    ],
    [loadGallery, loadRooms]
  );

  const mergeQueueSignature = useMemo(
    () =>
      sortedRooms
        .map((room) => `${room.id}:${Number(room?.privateDraftQueueCount || 0)}`)
        .join('|'),
    [sortedRooms]
  );

  useEffect(() => {
    setSelectedRoomIds((prev) => prev.filter((id) => rooms.some((room) => room.id === id)));
  }, [rooms]);

  useEffect(() => {
    if (!authReady) return;
    loadMergeInbox();
  }, [authReady, loadMergeInbox, mergeQueueSignature]);

  useEffect(() => {
    if (!rooms.length) return;
    const prevMap = previousRoomsRef.current;
    const nextMap = new Map();
    if (!roomsPrimedRef.current) {
      for (const room of rooms) nextMap.set(room.id, room);
      previousRoomsRef.current = nextMap;
      roomsPrimedRef.current = true;
      return;
    }

    for (const room of rooms) {
      const prior = prevMap.get(room.id);
      nextMap.set(room.id, room);
      if (!prior) continue;
      const roomId = room.id;
      const prevStage = String(prior.stage || '');
      const nextStage = String(room.stage || '');
      if (prevStage !== nextStage) {
        pushAlert({
          severity: nextStage === 'CLOSED' ? 'critical' : 'info',
          roomId,
          label:
            nextStage === 'CLOSED'
              ? `${roomId} closed.`
              : `${roomId} moved to ${stageLabel(nextStage)}.`,
        });
      }
      const prevVoteOpen = !!prior?.vote?.open;
      const nextVoteOpen = !!room?.vote?.open;
      if (prevVoteOpen !== nextVoteOpen) {
        pushAlert({
          severity: 'warn',
          roomId,
          label: `${roomId} vote ${nextVoteOpen ? 'opened' : 'closed'}.`,
        });
      }
      const prevFallback = !!prior?.aiFallback?.active;
      const nextFallback = !!room?.aiFallback?.active;
      if (prevFallback !== nextFallback) {
        pushAlert({
          severity: nextFallback ? 'critical' : 'info',
          roomId,
          label: `${roomId} AI fallback ${nextFallback ? 'activated' : 'cleared'}.`,
        });
      }
      const prevGateBlocked = prior?.phaseExitGate?.ok === false;
      const nextGateBlocked = room?.phaseExitGate?.ok === false;
      if (prevGateBlocked !== nextGateBlocked) {
        pushAlert({
          severity: nextGateBlocked ? 'warn' : 'info',
          roomId,
          label: nextGateBlocked
            ? `${roomId} is gate-blocked.`
            : `${roomId} gate cleared.`,
        });
      }
    }
    previousRoomsRef.current = nextMap;
  }, [rooms, pushAlert]);

  useEffect(() => {
    const thresholdSec = Math.max(30, Number(autopilotConfig.stuckInactivitySec || 120) || 120);
    const prior = roomStallAlertsRef.current || {};
    const next = {};
    for (const row of priorityQueue) {
      const roomId = row?.room?.id;
      if (!roomId) continue;
      next[roomId] = Number(row?.idleSec || 0);
      const wasOver = Number(prior[roomId] || 0) >= thresholdSec;
      const nowOver = Number(row?.idleSec || 0) >= thresholdSec;
      if (!wasOver && nowOver) {
        pushAlert({
          severity: 'critical',
          roomId,
          label: `${roomId} appears stalled (${Math.floor(Number(row.idleSec || 0) / 60)}m inactive).`,
        });
      }
    }
    roomStallAlertsRef.current = next;
  }, [autopilotConfig.stuckInactivitySec, priorityQueue, pushAlert]);

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />

      <div className="presenter-wrap page-reveal">
        {/* Top header strip */}
        <header className="presenter-head glass stagger-item">
          <div>
            <div className="presenter-title">Presenter HUD</div>
            <div className="presenter-subtitle">
              Live control panel for <b>{siteId || '—'}</b> rooms.
            </div>
          </div>

          <div className="presenter-site">
            <label htmlFor="presenter-site-input">SITE ID</label>
            <input
              id="presenter-site-input"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value.toUpperCase())}
              placeholder="E1 / C1 / W1"
            />
          </div>

          <div className="presenter-meta">
            <div>
              Hotkeys on Room 1: <b>N</b> Next, <b>+</b> +2m, <b>R</b> Redo
            </div>
            <div>
              Status:{' '}
              <span className="pill pill-live">{canFetch ? 'Live' : 'Idle'}</span>
            </div>
            <div>
              Rooms: <b>{rooms.length}</b>
            </div>
            <div>
              Participants: <b>{estimatedSeats}</b>
            </div>
            <div>
              Gate Blocked: <b>{blockedRoomCount}</b>
            </div>
            <div>
              AI Fallback Active: <b>{fallbackActiveCount}</b>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className={`btn ${compactMode ? 'primary' : 'ghost'}`}
                onClick={() => setViewMode('control')}
              >
                Control Mode
              </button>
              <button
                type="button"
                className={`btn ${!compactMode ? 'primary' : 'ghost'}`}
                onClick={() => setViewMode('expanded')}
              >
                Expanded Mode
              </button>
            </div>

            {/* NEW: Gallery button */}
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setGalleryOpen(true)}
                disabled={!canFetch}
              >
                📚 Gallery
              </button>
            </div>
          </div>
        </header>

        <section className="glass stagger-item" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Facilitator Autopilot</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Auto nudges, stuck-room interventions, and vote open/close controls.
              </div>
            </div>
            <button
              type="button"
              className={`btn ${autopilotConfig.enabled ? 'primary' : ''}`}
              onClick={() => saveAutopilot({ enabled: !autopilotConfig.enabled })}
              disabled={autopilotBusy}
            >
              {autopilotConfig.enabled ? 'Autopilot On' : 'Autopilot Off'}
            </button>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Nudge before end (sec)
              <input
                className="input"
                type="number"
                min="10"
                max="300"
                value={autopilotConfig.nudgeBeforeEndSec}
                onChange={(e) => setAutopilotConfig((prev) => ({ ...prev, nudgeBeforeEndSec: Number(e.target.value || 45) }))}
                onBlur={() => saveAutopilot({ nudgeBeforeEndSec: Number(autopilotConfig.nudgeBeforeEndSec || 45) })}
                disabled={autopilotBusy}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Stuck threshold (sec)
              <input
                className="input"
                type="number"
                min="30"
                max="900"
                value={autopilotConfig.stuckInactivitySec}
                onChange={(e) => setAutopilotConfig((prev) => ({ ...prev, stuckInactivitySec: Number(e.target.value || 120) }))}
                onBlur={() => saveAutopilot({ stuckInactivitySec: Number(autopilotConfig.stuckInactivitySec || 120) })}
                disabled={autopilotBusy}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Extend on stuck (sec)
              <input
                className="input"
                type="number"
                min="30"
                max="600"
                value={autopilotConfig.interventionExtendSec}
                onChange={(e) => setAutopilotConfig((prev) => ({ ...prev, interventionExtendSec: Number(e.target.value || 120) }))}
                onBlur={() => saveAutopilot({ interventionExtendSec: Number(autopilotConfig.interventionExtendSec || 120) })}
                disabled={autopilotBusy}
              />
            </label>
          </div>
          <div className="row mt8" style={{ gap: 8 }}>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={!!autopilotConfig.autoNudgeOnStuck}
                onChange={(e) => saveAutopilot({ autoNudgeOnStuck: e.target.checked })}
                disabled={autopilotBusy}
              />
              Auto Nudge + Intervene
            </label>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={!!autopilotConfig.autoVote}
                onChange={(e) => saveAutopilot({ autoVote: e.target.checked })}
                disabled={autopilotBusy}
              />
              Auto Vote Open/Close
            </label>
          </div>
        </section>

        <MissionControlPanel
          rooms={sortedRooms}
          roomSignals={roomSignals}
          onExtend={extend}
          onUnlock={unlock}
          onNudge={sendRoomNudge}
          onNext={next}
          onStartVote={startVote}
          onIntervene={runIntervention}
        />

        {/* Stage summary bar */}
        {!compactMode && (
          <section className="presenter-stage-strip glass stagger-item">
            {STAGES.map((s) => (
              <div key={s} className="presenter-stage-pill">
                <span>{s.replace('_', ' ')}</span>
                <b>{stageSummary[s] || 0}</b>
                <span className="presenter-stage-label">rooms</span>
              </div>
            ))}
          </section>
        )}

        {/* Error / empty */}
        {error && <div className="presenter-empty glass">{error}</div>}
        {notice && <div className="presenter-empty glass">{notice}</div>}

        <section className="presenter-trust-strip glass stagger-item">
          <div className="presenter-trust-title">Trust / Health</div>
          <div className="presenter-trust-badges">
            <span className={`pill ${healthStatus?.api?.ok ? 'pill-live' : 'pill-alert'}`}>
              API {statusLabel(healthStatus?.api?.ok)}
            </span>
            <span className={`pill ${healthStatus?.aws?.ok ? 'pill-live' : 'pill-alert'}`}>
              AWS {statusLabel(healthStatus?.aws?.ok)}
            </span>
            <span className={`pill ${healthStatus?.openai?.ok ? 'pill-live' : 'pill-alert'}`}>
              OpenAI {statusLabel(healthStatus?.openai?.ok)}
            </span>
            <span className={`pill ${healthStatus?.sse?.ok ? 'pill-live' : 'pill-alert'}`}>
              SSE {healthStatus?.sse?.ok ? 'Connected' : 'Reconnecting'}
            </span>
          </div>
          <div className="presenter-trust-sub">
            Updated {formatAgo(healthStatus.updatedAt)}
            {healthStatus?.openai?.ok ? '' : ' • AI fallback may activate'}
          </div>
        </section>

        <section className="presenter-enhanced-grid">
          <article className="glass presenter-panel">
            <header className="presenter-panel-head">
              <div>
                <div className="presenter-panel-title">Priority Queue</div>
                <div className="presenter-panel-subtitle">
                  Rooms auto-sorted by risk. Needs attention now stays at the top.
                </div>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="pill">Needs attention: <b>{attentionQueue.length}</b></span>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setSelectedRoomIds(priorityQueue.slice(0, 5).map((row) => row.room.id))
                  }
                  disabled={!priorityQueue.length}
                >
                  Select Top 5
                </button>
              </div>
            </header>

            <div className="priority-room-list">
              {priorityQueue.slice(0, 12).map((row) => {
                const room = row.room;
                const selected = selectedRoomSet.has(room.id);
                const riskClass =
                  row.score >= 75 ? 'risk-critical' : row.score >= 50 ? 'risk-warn' : 'risk-ok';
                const approvalSlaSec =
                  row.pendingApprovals && Number.isFinite(Number(row.approvalAgeSec))
                    ? 180 - Number(row.approvalAgeSec || 0)
                    : null;
                return (
                  <div key={room.id} className={`priority-room-row ${riskClass}`}>
                    <label className="priority-room-check">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRoomSelection(room.id)}
                      />
                    </label>
                    <div className="priority-room-main">
                      <div className="priority-room-head">
                        <b>
                          Room {room.index} ({room.id})
                        </b>
                        <span className="pill">Risk {row.score}</span>
                        <span className="pill">{stageLabel(room.stage)}</span>
                      </div>
                      <div className="priority-room-reasons">
                        {row.reasons.length ? row.reasons.join(' • ') : 'Healthy room'}
                      </div>
                      <div className="priority-room-sla">
                        <span>
                          Stuck SLA: <b className={Number(row.stuckCountdownSec || 0) < 0 ? 'sla-bad' : ''}>{formatTimer(row.stuckCountdownSec)}</b>
                        </span>
                        <span>
                          Phase: <b className={Number(row.stageLeftSec || 0) < 0 ? 'sla-bad' : ''}>{formatTimer(row.stageLeftSec)}</b>
                        </span>
                        <span>
                          Approval SLA:{' '}
                          <b className={Number(approvalSlaSec || 0) < 0 ? 'sla-bad' : ''}>
                            {approvalSlaSec === null ? '—' : formatTimer(approvalSlaSec)}
                          </b>
                        </span>
                      </div>
                    </div>
                    <div className="priority-room-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setGateDrawerRoomId(room.id)}
                        disabled={!row.gateBlocked}
                      >
                        Gate Detail
                      </button>
                      <button type="button" className="btn" onClick={() => openRoomDrilldown(room.id)}>
                        Drilldown
                      </button>
                    </div>
                  </div>
                );
              })}
              {!priorityQueue.length && <div className="empty-state mini">No rooms found.</div>}
            </div>
          </article>

          <article className="glass presenter-panel">
            <header className="presenter-panel-head">
              <div>
                <div className="presenter-panel-title">Bulk Actions + Playbooks</div>
                <div className="presenter-panel-subtitle">
                  Run presenter interventions across selected rooms.
                </div>
              </div>
              <span className="pill">Selected: <b>{selectedRoomIds.length}</b></span>
            </header>

            <div className="presenter-action-grid">
              <button type="button" className="btn" onClick={() => runBulkAction('extend')} disabled={bulkBusy || !selectedRoomIds.length}>
                +2m Selected
              </button>
              <button type="button" className="btn" onClick={() => runBulkAction('unlock')} disabled={bulkBusy || !selectedRoomIds.length}>
                Unlock Selected
              </button>
              <button type="button" className="btn" onClick={() => runBulkAction('nudge')} disabled={bulkBusy || !selectedRoomIds.length}>
                Nudge Selected
              </button>
              <button type="button" className="btn" onClick={() => runBulkAction('reopen_vote')} disabled={bulkBusy || !selectedRoomIds.length}>
                Reopen Vote
              </button>
            </div>

            <div className="presenter-playbook-grid mt12">
              <button type="button" className="btn primary" onClick={() => runPlaybook('recover_stuck')} disabled={bulkBusy}>
                Recover Stuck Room
              </button>
              <button type="button" className="btn" onClick={() => runPlaybook('finalize_3m')} disabled={bulkBusy}>
                Finalize in 3 Minutes
              </button>
              <button type="button" className="btn" onClick={() => runPlaybook('rebalance')} disabled={bulkBusy}>
                Rebalance Participation
              </button>
              <button type="button" className="btn ghost" onClick={clearSelectedRooms} disabled={!selectedRoomIds.length || bulkBusy}>
                Clear Selection
              </button>
            </div>
          </article>

          <article className="glass presenter-panel">
            <header className="presenter-panel-head">
              <div>
                <div className="presenter-panel-title">Approval Queue</div>
                <div className="presenter-panel-subtitle">
                  Rooms waiting on draft approvals and who is still pending.
                </div>
              </div>
              <span className="pill">Waiting: <b>{approvalQueue.length}</b></span>
            </header>
            <div className="presenter-queue-list">
              {approvalQueue.slice(0, 12).map((item) => (
                <div key={item.room.id} className="presenter-queue-row">
                  <div>
                    <div className="presenter-queue-title">
                      Room {item.room.index} ({item.room.id})
                    </div>
                    <div className="presenter-queue-sub">
                      Approvals {item.approvedCount}/{item.requiredApprovals} • Pending:{' '}
                      {item.missingApprovals.length
                        ? item.missingApprovals.map((row) => row.label || row.uid || 'Seat').join(', ')
                        : '—'}
                    </div>
                    <div className="presenter-queue-sub">
                      Pending SLA: <b className={item.staleSeconds > 180 ? 'sla-bad' : ''}>{formatTimer(180 - item.staleSeconds)}</b>
                    </div>
                  </div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <button type="button" className="btn" onClick={() => approveRoomDraft(item.room.id)}>
                      Approve
                    </button>
                    <button type="button" className="btn" onClick={() => openRoomDrilldown(item.room.id)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
              {!approvalQueue.length && (
                <div className="empty-state mini">No pending approvals.</div>
              )}
            </div>
          </article>

          <article className="glass presenter-panel">
            <header className="presenter-panel-head">
              <div>
                <div className="presenter-panel-title">Merge Queue Inbox</div>
                <div className="presenter-panel-subtitle">
                  Submitted private drafts across rooms with merge shortcuts.
                </div>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="pill">Items: <b>{mergeInbox.length}</b></span>
                <button type="button" className="btn" onClick={loadMergeInbox} disabled={mergeInboxLoading}>
                  {mergeInboxLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </header>
            <div className="presenter-queue-list">
              {mergeInbox.slice(0, 16).map((item) => (
                <div key={`${item.roomId}-${item.uid}-${item.submittedAt}`} className="presenter-queue-row">
                  <div>
                    <div className="presenter-queue-title">
                      Room {item.roomIndex} ({item.roomId}) • {item.uid || 'seat'}
                    </div>
                    <div className="presenter-queue-sub">
                      Submitted {formatAgo(item.submittedAt)} • Stage {stageLabel(item.roomStage)}
                    </div>
                    <div className="presenter-queue-preview">
                      {item.preview || item.text || 'No preview'}
                    </div>
                  </div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => mergeSubmission(item.roomId, item.uid, 'append')}
                    >
                      Merge
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => mergeSubmission(item.roomId, item.uid, 'replace')}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => approveRoomDraft(item.roomId)}
                    >
                      Approve
                    </button>
                    <button type="button" className="btn" onClick={() => openRoomDrilldown(item.roomId)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
              {!mergeInboxLoading && !mergeInbox.length && (
                <div className="empty-state mini">No submitted private drafts waiting for merge.</div>
              )}
            </div>
          </article>

          <article className="glass presenter-panel">
            <header className="presenter-panel-head">
              <div>
                <div className="presenter-panel-title">Live Alert Feed</div>
                <div className="presenter-panel-subtitle">
                  Critical room events for votes, fallback, stalls, and closures.
                </div>
              </div>
            </header>
            <div className="presenter-alert-feed">
              {alertFeed.map((item) => (
                <div key={item.id} className={`presenter-alert-row severity-${item.severity || 'info'}`}>
                  <div className="presenter-alert-time">{formatAgo(item.at)}</div>
                  <div className="presenter-alert-label">{item.label}</div>
                </div>
              ))}
              {!alertFeed.length && <div className="empty-state mini">No active alerts.</div>}
            </div>
          </article>
        </section>

        {!error && loading && rooms.length === 0 && canFetch && (
          <main className="rooms-grid">
            {Array.from({ length: 3 }).map((_, idx) => (
              <article key={idx} className="room-card glass skeleton-card-large">
                <div className="skeleton-line" style={{ width: '42%', height: 16 }} />
                <div className="skeleton-line" style={{ width: '80%' }} />
                <div className="skeleton-line" style={{ width: '90%' }} />
                <div className="skeleton-line" style={{ width: '64%' }} />
              </article>
            ))}
          </main>
        )}

        {!error && !loading && canFetch && rooms.length === 0 && (
          <div className="presenter-empty glass empty-state">
            <div className="empty-state-title">No rooms live for {siteId}</div>
            <div className="empty-state-subtitle">
              Check code-to-site mapping or generate new access codes for this site.
            </div>
            <div className="row mt12">
              <button className="btn" onClick={loadRooms}>
                Refresh rooms
              </button>
              <a href="/super-admin" className="btn ghost" style={{ textDecoration: 'none' }}>
                Generate codes
              </a>
            </div>
          </div>
        )}

        {/* Rooms grid */}
        <main className="rooms-grid">
          {sortedRooms.map((r) => {
            const isClosed = (r.stage || '') === 'CLOSED';
            const isFinal = (r.stage || '') === 'FINAL';
            const signals = roomSignals[r.id] || {};
            const typingNow = Array.isArray(signals.typing) ? signals.typing.length : 0;
            const heatRows = Array.isArray(signals.contributionHeat) ? signals.contributionHeat : [];
            const activeContributors = heatRows.filter((row) => Number(row?.count || 0) > 0).length;
            const quietCount = Math.max(
              0,
              Number(signals?.equity?.quietCount || 0) || 0
            );
            const seatCount = Math.max(0, Number(r.seats || 0) || 0);
            const gateBlocked = r?.phaseExitGate?.ok === false;
            const gateMissing = describeGateMissing(r?.phaseExitGate?.missing || []);
            const qualityTotal = Math.max(0, Math.min(100, Number(r?.qualityScorecard?.total || 0)));
            const mergeQueueCount = Number(r?.privateDraftQueueCount || 0) || 0;
            const approvalCount = Number(r?.draftApproval?.approvedCount || 0) || 0;
            const approvalRequired = Number(r?.draftApproval?.requiredApprovals || 1) || 1;
            const fallbackActive = !!r?.aiFallback?.active;
            const priorityRow = priorityByRoomId[r.id] || null;
            const approvalSlaSec =
              priorityRow?.pendingApprovals && Number.isFinite(Number(priorityRow?.approvalAgeSec))
                ? 180 - Number(priorityRow.approvalAgeSec || 0)
                : null;

            return (
              <article key={r.id} className="room-card glass">
                <header className="room-card-head">
                  <div>
                    <div className="room-card-title">
                      <label className="row" style={{ gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={selectedRoomSet.has(r.id)}
                          onChange={() => toggleRoomSelection(r.id)}
                        />
                        <span>
                          Room {r.index} {siteId}
                        </span>
                      </label>
                    </div>
                    <div className="room-card-sub">
                      {r.stage === 'LOBBY'
                        ? 'Waiting for participants.'
                        : isClosed
                        ? 'Session complete — abstract ready.'
                        : 'Stage in progress.'}
                    </div>
                  </div>

                  <div className="room-card-stage">
                    <span className="pill pill-stage">{r.stage || '—'}</span>
                    <span className={`pill pill-status ${isClosed ? 'pill-closed' : ''}`}>
                      {isClosed ? 'CLOSED' : 'OPEN'}
                    </span>
                  </div>
                </header>

                <section className="room-card-meta">
                  <div>
                    <span className="label">Seats</span> {r.seats ?? '—'}
                  </div>
                  <div>
                    <span className="label">Locked</span> {r.inputLocked ? 'Yes' : 'No'}
                  </div>
                  <div className="room-card-topic">
                    <span className="label">Topic</span> {r.topic || '—'}
                  </div>
                  {!compactMode && (
                    <div>
                      <span className="label">Draft</span>{' '}
                      {Number(r.draftVersion || 0) ? `v${Number(r.draftVersion || 0)}` : '—'}
                    </div>
                  )}
                  <div>
                    <span className="label">Quality</span> {qualityTotal}/100
                  </div>
                  <div>
                    <span className="label">Gate</span> {gateBlocked ? 'Blocked' : 'Ready'}
                  </div>
                  {!compactMode && (
                    <div>
                      <span className="label">Merge Queue</span> {mergeQueueCount}
                    </div>
                  )}
                  {!compactMode && (
                    <div>
                      <span className="label">Approvals</span> {approvalCount}/{approvalRequired}
                    </div>
                  )}
                  {!compactMode && (
                    <div>
                      <span className="label">AI Fallback</span> {fallbackActive ? 'Active' : 'Normal'}
                    </div>
                  )}
                  {isClosed && (
                    <div>
                      <span className="label">Closed</span>{' '}
                      {formatClosedAt(r.closedAt) || '—'}
                      {r.closedReason ? ` (${r.closedReason})` : ''}
                    </div>
                  )}
                </section>

                {gateBlocked ? (
                  <section className="room-card-vote">
                    <div>
                      <span className="label">Phase Exit Blocked</span>{' '}
                      {gateMissing || 'Required outputs missing'}
                    </div>
                  </section>
                ) : null}

                <section className="room-card-presence">
                  <div>
                    <span className="label">Live Presence</span>{' '}
                    {typingNow > 0 ? `${typingNow} typing` : 'No active typing'}
                  </div>
                  <div>
                    <span className="label">Contributors</span>{' '}
                    {seatCount > 0 ? `${activeContributors}/${seatCount}` : '—'}
                  </div>
                  {!compactMode && (
                    <div>
                      <span className="label">Quiet Seats</span> {quietCount}
                    </div>
                  )}
                </section>

                <section className="room-card-vote">
                  <div>
                    <span className="label">Stuck SLA</span>{' '}
                    <b className={Number(priorityRow?.stuckCountdownSec || 0) < 0 ? 'sla-bad' : ''}>
                      {priorityRow ? formatTimer(priorityRow.stuckCountdownSec) : '—'}
                    </b>
                  </div>
                  <div>
                    <span className="label">Phase SLA</span>{' '}
                    <b className={Number(priorityRow?.stageLeftSec || 0) < 0 ? 'sla-bad' : ''}>
                      {priorityRow ? formatTimer(priorityRow.stageLeftSec) : '—'}
                    </b>
                  </div>
                  <div>
                    <span className="label">Approval SLA</span>{' '}
                    <b className={Number(approvalSlaSec || 0) < 0 ? 'sla-bad' : ''}>
                      {approvalSlaSec === null ? '—' : formatTimer(approvalSlaSec)}
                    </b>
                  </div>
                </section>

                {!compactMode && r.vote && (
                  <section className="room-card-vote">
                    <div>
                      <span className="label">Voting</span> {r.vote.open ? 'Open' : 'Closed'}
                    </div>
                    <div>
                      <span className="label">Ballots</span> {r.vote.total ?? 0}
                    </div>
                    {r.vote.tallies && (
                      <details>
                        <summary> Tallies</summary>
                        <ul>
                          {Object.entries(r.vote.tallies).map(([k, v]) => (
                            <li key={k}>
                              #{k}: {v}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </section>
                )}

                  <section className="room-card-controls">
                  <div className="room-card-row">
                    <button
                      type="button"
                      onClick={() => next(r.id)}
                      disabled={gateBlocked}
                      title={gateBlocked ? `Blocked: ${gateMissing || 'complete required outputs'}` : ''}
                    >
                      Next
                    </button>
                    <button type="button" onClick={() => extend(r.id, 120)}>
                      +2m
                    </button>
                    <button type="button" onClick={() => redo(r.id)}>
                      Redo
                    </button>
                    <button type="button" onClick={() => lock(r.id)} className="warn">
                      Lock
                    </button>
                    <button type="button" onClick={() => unlock(r.id)} className="safe">
                      Unlock
                    </button>
                    <button
                      type="button"
                      onClick={() => setGateDrawerRoomId(r.id)}
                      disabled={!gateBlocked}
                    >
                      Gate Detail
                    </button>
                  </div>

                  <div className="room-card-row">
                    <button type="button" onClick={() => startVote(r.id)}>
                      Start Voting
                    </button>
                    <button type="button" onClick={() => closeVote(r.id)} className="warn">
                      Close &amp; Lock Topic
                    </button>
                    <button type="button" onClick={() => nudgeQuiet(r.id)}>
                      Nudge Quiet
                    </button>
                    <button
                      type="button"
                      onClick={() => reopenVoting(r.id)}
                      disabled={(r.stage || '') !== 'DISCOVERY'}
                      title="Discovery stage only"
                    >
                      Reopen Vote
                    </button>

                    <button
                      type="button"
                      onClick={() => closeFinal(r.id)}
                      className="warn"
                      disabled={!isFinal || isClosed}
                      title="FINAL stage only — posts final abstract and locks the room"
                    >
                      Close Room
                    </button>

                    <a
                      href={`/room/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="room-open-link"
                    >
                      Open Room View
                    </a>
                    <button type="button" onClick={() => openRoomDrilldown(r.id)}>
                      Drilldown
                    </button>
                  </div>
                </section>

                {!compactMode && (
                  <section className="room-card-voting-panel">
                    <PresenterVotingPanel
                      roomId={r.id}
                      isPresenter
                      refreshKey={voteRefreshSeq}
                    />
                  </section>
                )}
              </article>
            );
          })}
        </main>

        {gateDrawerRoom && (
          <div className="presenter-drawer-backdrop" onClick={() => setGateDrawerRoomId('')}>
            <aside className="presenter-gate-drawer glass" onClick={(e) => e.stopPropagation()}>
              <header className="presenter-panel-head">
                <div>
                  <div className="presenter-panel-title">
                    Gate Detail: Room {gateDrawerRoom.index} ({gateDrawerRoom.id})
                  </div>
                  <div className="presenter-panel-subtitle">
                    Missing outputs and one-click fixes before stage advance.
                  </div>
                </div>
                <button type="button" className="btn" onClick={() => setGateDrawerRoomId('')}>
                  Close
                </button>
              </header>
              <div className="presenter-gate-list">
                {(gateDrawerRoom?.phaseExitGate?.missing || []).map((missingKey) => (
                  <div key={missingKey} className="presenter-gate-item">
                    <div>
                      <div className="presenter-queue-title">{describeGateMissing([missingKey]) || missingKey}</div>
                      <div className="presenter-queue-sub">Required before stage progression.</div>
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button type="button" className="btn" onClick={() => extend(gateDrawerRoom.id, 120)}>
                        +2m
                      </button>
                      <button type="button" className="btn" onClick={() => unlock(gateDrawerRoom.id)}>
                        Unlock
                      </button>
                      <button type="button" className="btn" onClick={() => nudgeQuiet(gateDrawerRoom.id)}>
                        Nudge
                      </button>
                      <button type="button" className="btn" onClick={() => openRoomDrilldown(gateDrawerRoom.id)}>
                        Drilldown
                      </button>
                    </div>
                  </div>
                ))}
                {!Array.isArray(gateDrawerRoom?.phaseExitGate?.missing) ||
                !gateDrawerRoom.phaseExitGate.missing.length ? (
                  <div className="empty-state mini">No active gate blockers for this room.</div>
                ) : null}
              </div>
            </aside>
          </div>
        )}

        {drilldownRoomId && (
          <div className="presenter-drawer-backdrop" onClick={() => setDrilldownRoomId('')}>
            <div className="presenter-drilldown-modal glass" onClick={(e) => e.stopPropagation()}>
              <header className="presenter-panel-head">
                <div>
                  <div className="presenter-panel-title">
                    Room Drilldown: {drilldownRoomSummary?.id || drilldownRoomId}
                  </div>
                  <div className="presenter-panel-subtitle">
                    Monitor chat, evidence, and quality without leaving Presenter.
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => loadRoomDrilldown(drilldownRoomId)}
                    disabled={drilldownLoading}
                  >
                    {drilldownLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <button type="button" className="btn primary" onClick={() => setDrilldownRoomId('')}>
                    Close
                  </button>
                </div>
              </header>

              {drilldownLoading ? (
                <div className="empty-state mini">Loading room detail…</div>
              ) : (
                <>
                  <section className="presenter-drilldown-metrics">
                    <div>
                      <span className="label">Stage</span> {stageLabel(drilldownState?.stage)}
                    </div>
                    <div>
                      <span className="label">Topic</span> {drilldownState?.topic || '—'}
                    </div>
                    <div>
                      <span className="label">Quality</span>{' '}
                      {Math.max(0, Math.min(100, Number(drilldownState?.qualityScorecard?.total || 0)))}/100
                    </div>
                    <div>
                      <span className="label">Gate</span>{' '}
                      {drilldownState?.phaseExitGate?.ok === false
                        ? describeGateMissing(drilldownState?.phaseExitGate?.missing || [])
                        : 'Ready'}
                    </div>
                    <div>
                      <span className="label">Evidence</span>{' '}
                      {drilldownState?.cerGate?.ok
                        ? `Ready (${Number(drilldownState?.cerGate?.citations || 0)} citations)`
                        : 'Needs citation coverage'}
                    </div>
                  </section>

                  <section className="presenter-drilldown-controls">
                    <button type="button" className="btn" onClick={() => extend(drilldownRoomId, 120)}>
                      +2m
                    </button>
                    <button type="button" className="btn" onClick={() => unlock(drilldownRoomId)}>
                      Unlock
                    </button>
                    <button type="button" className="btn" onClick={() => nudgeQuiet(drilldownRoomId)}>
                      Nudge Quiet
                    </button>
                    <button type="button" className="btn" onClick={() => startVote(drilldownRoomId)}>
                      Start Vote
                    </button>
                  </section>

                  <section className="presenter-drilldown-chat">
                    <div className="presenter-queue-title">Recent Chat</div>
                    <div className="presenter-drilldown-chat-list">
                      {drilldownMessages.slice(0, 30).map((message) => (
                        <div
                          key={`${message.createdAt}-${message.uid || message.authorType}`}
                          className="presenter-chat-row"
                        >
                          <div className="presenter-chat-meta">
                            <span>{message.emoji || '💬'}</span>
                            <span>{message.authorType || 'user'}</span>
                            <span>{formatAgo(message.createdAt)}</span>
                          </div>
                          <div className="presenter-chat-text">{message.text || ''}</div>
                        </div>
                      ))}
                      {!drilldownMessages.length && (
                        <div className="empty-state mini">No recent room messages.</div>
                      )}
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mobile-action-bar presenter-mobile-bar">
        <button type="button" onClick={loadRooms} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button type="button" onClick={() => setGalleryOpen(true)}>
          Gallery
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!leadRoom?.id) return;
            const ok = await next(leadRoom.id);
            if (ok) {
              setNotice(`Room ${leadRoom.index || 1} advanced to next stage.`);
              await loadRooms();
            }
          }}
          disabled={!leadRoom?.id}
        >
          Next Room
        </button>
      </div>

      {/* Gallery Modal */}
      {galleryOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setGalleryOpen(false)}
        >
          <div
            className="rounded-2xl"
            style={{
              width: 960,
              maxWidth: '96vw',
              maxHeight: '90vh',
              overflow: 'hidden',
              background: 'rgba(20,20,24,0.6)',
              border: '1px solid rgba(255,255,255,0.12)',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
              color: 'white',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              style={{
                padding: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="gold-dot" />
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>
                    Gallery — {siteId || '—'}
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    Closed room abstracts (newest first). Copy, share, export.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={loadGallery}
                  disabled={galleryLoading}
                >
                  {galleryLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setGalleryOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: 16, overflowY: 'auto', maxHeight: 'calc(90vh - 70px)' }}>
              {galleryError && (
                <div className="presenter-empty glass" style={{ marginBottom: 12 }}>
                  {galleryError}
                </div>
              )}

              {!galleryError && galleryLoading && (
                <div className="presenter-empty glass" style={{ marginBottom: 12 }}>
                  Loading gallery…
                </div>
              )}

              {!galleryError && !galleryLoading && galleryItems.length === 0 && (
                <div className="presenter-empty glass">
                  No closed abstracts yet for <b>{siteId}</b>. Close rooms in FINAL to populate.
                </div>
              )}

              {!galleryError && !galleryLoading && galleryItems.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
                  {galleryItems.map((it) => (
                    <div
                      key={it.roomId}
                      className="glass"
                      style={{
                        borderRadius: 16,
                        padding: 14,
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(15,23,42,0.65)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 8,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 14 }}>
                            {it.roomId}{it.index ? ` (Room ${it.index})` : ''}{' '}
                            <span style={{ opacity: 0.65, fontWeight: 600 }}>
                              • {formatClosedAt(it.closedAt) || '—'}
                            </span>
                          </div>
                          <div style={{ opacity: 0.9, fontSize: 13, marginTop: 2 }}>
                            <span style={{ opacity: 0.7 }}>Topic:</span>{' '}
                            <b>{it.topic || '—'}</b>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              const ok = await copyToClipboard(it.abstract || '');
                              setGalleryCopiedRoom(ok ? it.roomId : '');
                              if (!ok) alert('Copy failed — your browser blocked clipboard.');
                              if (ok) {
                                setTimeout(() => setGalleryCopiedRoom(''), 1200);
                              }
                            }}
                            disabled={!it.abstract}
                            title="Copy abstract to clipboard"
                          >
                            {galleryCopiedRoom === it.roomId ? '✅ Copied' : 'Copy'}
                          </button>

                          <a
                            href={`/room/${it.roomId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn"
                            style={{ textDecoration: 'none' }}
                            title="Open room view"
                          >
                            Open
                          </a>
                        </div>
                      </div>

                      <div
                        style={{
                          whiteSpace: 'pre-wrap',
                          fontSize: 13,
                          lineHeight: 1.45,
                          padding: 10,
                          borderRadius: 12,
                          background: 'rgba(0,0,0,0.25)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        {it.abstract ? it.abstract : '— No abstract text —'}
                      </div>
                      <PremiumExportActions
                        className="mt12"
                        title={`Room ${it.index || it.roomId} Story`}
                        topic={it.topic || ''}
                        content={it.abstract || ''}
                        orgLabel={siteId || 'StoryBloom'}
                        roomId={it.roomId}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <PresenterHUD siteId={siteId} rooms={sortedRooms} />
      <CopilotPanel
        className="copilot-presenter"
        title="Presenter Copilot"
        subtitle="Rapid facilitation assists"
        suggestions={copilotSuggestions}
      />
    </>
  );
}
