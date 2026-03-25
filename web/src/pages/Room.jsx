// web/src/pages/Room.jsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE, buildSseUrl } from '../api';

import TopBanner from '../components/TopBanner.jsx';
import CountdownRing from '../components/CountdownRing.jsx';
import ChatMessage from '../components/ChatMessage.jsx';
import IdeaSidebar from '../components/IdeaSidebar.jsx';
import StageTimelineRail from '../components/StageTimelineRail.jsx';
import CollaborativeCanvas from '../components/CollaborativeCanvas.jsx';
import ReplayModal from '../components/ReplayModal.jsx';
import PremiumExportActions from '../components/PremiumExportActions.jsx';
import { loadA11yPrefs, subscribeA11yPrefs } from '../a11yPrefs.js';

const ORDER = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
];

const CANVAS_PHASES = ORDER.filter((stage) => stage !== 'LOBBY' && stage !== 'CLOSED');

// Fallback if backend stageDurationSec is unavailable.
const TOTAL_BY_STAGE = {
  LOBBY: 1200, // 20 min
  DISCOVERY: 600, // 10 min
  IDEA_DUMP: 600, // 10 min
  PLANNING: 600, // 10 min
  ROUGH_DRAFT: 240, // 4 min
  EDITING: 600, // 10 min
  FINAL: 360, // 6 min
};

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function describeCerMissing(missing = []) {
  const labels = {
    claim: 'Claim section',
    evidence: 'Evidence section',
    reasoning: 'Reasoning section',
    citation: 'At least one citation',
  };
  return (Array.isArray(missing) ? missing : [])
    .map((item) => labels[item] || item)
    .join(', ');
}

function isPolicyBlockedError(errorCode = '') {
  const normalized = String(errorCode || '').trim().toLowerCase();
  return (
    normalized === 'content_blocked_by_policy' ||
    normalized === 'content_blocked_by_school_policy'
  );
}

function formatTimestamp(ts) {
  const ms = Number(ts || 0);
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function roleLabel(role = '') {
  return String(role || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

const STAGE_DESCRIPTIONS = {
  LOBBY: 'Everyone lands, tests chat, and gets oriented.',
  DISCOVERY: 'Share first thoughts and stories about the topic.',
  IDEA_DUMP: 'Rapid-fire ideas; volume over perfection.',
  PLANNING: 'Group chooses a focus and rough structure.',
  ROUGH_DRAFT: 'Asema drafts a first version from your ideas.',
  EDITING: 'Team revises, sharpens, and corrects the draft.',
  FINAL:
    'Final touches and “we’re done” check-in. Session wraps when everyone types “done” or “submit”.',
  CLOSED: 'Session is complete, scroll and copy your abstract.',
};

const STAGE_GOALS = {
  LOBBY: 'Get everyone connected, seated, and comfortable with chat.',
  DISCOVERY: 'Surface lived experiences and pick themes worth exploring.',
  IDEA_DUMP: 'Generate many possible angles without over-editing.',
  PLANNING: 'Agree on story structure, voice, and key narrative beats.',
  ROUGH_DRAFT: 'Produce a first full draft that captures the room direction.',
  EDITING: 'Sharpen clarity, tighten language, and remove ambiguity.',
  FINAL: 'Lock final edits and confirm everyone is ready to submit.',
  CLOSED: 'Share outcomes, capture highlights, and export the final story.',
};

const NEXT_ACTION_HINTS = {
  LOBBY: 'Kick off with a warm prompt and ask everyone to post one sentence.',
  DISCOVERY: 'Mark ready to vote as soon as your group identifies top options.',
  IDEA_DUMP: 'Cluster similar ideas and identify the most urgent thread.',
  PLANNING: 'Use the planning board and share it with the room before drafting.',
  ROUGH_DRAFT: 'Generate the draft, then tag edits with concrete suggestions.',
  EDITING: 'Resolve contradictions and lock one final version together.',
  FINAL: 'Type “done” or “submit” once your table signs off.',
  CLOSED: 'Open gallery/presenter view to showcase your final abstract.',
};

function StageLegendPill({ stage, open, onToggle }) {
  const niceStage = (stage || 'LOBBY').replace('_', ' ');
  return (
    <div className="stage-legend-pill">
      <button
        type="button"
        className="stage-legend-trigger"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="Show stage legend"
      >
        <span className="stage-legend-dot" />
        <span className="stage-legend-label">{niceStage}</span>
        <span className="stage-legend-help">?</span>
      </button>

      {open && (
        <div className="stage-legend-panel" role="dialog" aria-label="Stage legend">
          <div className="stage-legend-header">
            <span className="stage-legend-title">Stage Legend</span>
            <button type="button" className="stage-legend-close" onClick={onToggle}>
              ✕
            </button>
          </div>
          <ul className="stage-legend-list">
            {ORDER.map((s) => (
              <li key={s}>
                <span className="stage-legend-stage">{s.replace('_', ' ')}</span>
                <span className="stage-legend-desc">{STAGE_DESCRIPTIONS[s] || ''}</span>
              </li>
            ))}
          </ul>
          <div className="stage-legend-footer">
            Tip: this panel is for facilitators if anyone asks, “What are we supposed to be
            doing right now?”
          </div>
        </div>
      )}
    </div>
  );
}

export default function Room() {
  const { roomId } = useParams();

  // Role (from login)
  const role = useMemo(() => sessionStorage.getItem('role') || 'PARTICIPANT', []);
  const isPresenter = role === 'PRESENTER';

  // Room meta + stage
  const [stage, setStage] = useState('LOBBY');
  const [stageEndsAt, setStageEndsAt] = useState(null);
  const [roomMeta, setRoomMeta] = useState({
    siteId: '',
    index: 1,
    inputLocked: false,
    topic: '',
    seats: 0,
    finalReadyCount: 0,
    finalCompletedAt: null,

    // NEW: draft/final meta (from server.js /state)
    draftVersion: 0,
    draftUpdatedAt: null,
    finalAbstract: '',
    closedAt: null,
    closedReason: null,
    stageDurationSec: 0,
  });

  // Messages + ideas
  const [messages, setMessages] = useState([]);
  const [ideaSummary, setIdeaSummary] = useState('');

  // Compose
  const [text, setText] = useState('');
  const [activePersona, setActivePersona] = useState(0);

  // Personas from login
  const personas = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem('personas') || '["🙂"]');
    } catch {
      return ['🙂'];
    }
  }, []);
  const mode = sessionStorage.getItem('mode') || 'individual';

  // Utilities
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sentWelcome, setSentWelcome] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // Voting (frontend glue; backend handles real logic)
  const [voteOpen, setVoteOpen] = useState(false); // backend: votingOpen
  const [voteModalOpen, setVoteModalOpen] = useState(false); // local: modal visibility
  const [voteOptions, setVoteOptions] = useState([]);
  const [hasVoted, setHasVoted] = useState(false);
  const [voteCounts, setVoteCounts] = useState(null);
  const [voteTopic, setVoteTopic] = useState('');
  const [voteReadyCount, setVoteReadyCount] = useState(0);
  const [voteSubmittedCount, setVoteSubmittedCount] = useState(0);
  const [voteSeats, setVoteSeats] = useState(0);
  const [hasMarkedReady, setHasMarkedReady] = useState(false);

  // Rough draft local flags
  const [hasDraft, setHasDraft] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false); // lock while generating

  // Legend toggle
  const [legendOpen, setLegendOpen] = useState(false);

  // Planning stage local state (interactive panel)
  const [planningFocus, setPlanningFocus] = useState('');
  const [planningStructure, setPlanningStructure] = useState('');
  const [planningKeyPoints, setPlanningKeyPoints] = useState('');
  const [planningBusy, setPlanningBusy] = useState(false);

  // Role-specific UX mode
  const [viewMode, setViewMode] = useState(
    () => localStorage.getItem('participant_view_mode') || 'simple'
  );

  // Collaborative canvas + replay + social presence
  const [canvasPhase, setCanvasPhase] = useState('DISCOVERY');
  const [canvas, setCanvas] = useState({
    stickyNotes: '',
    outlineMap: '',
    evidenceBoard: '',
    narrativeMap: '',
    ideas: '',
    structure: '',
    map: '',
    updatedAt: 0,
    updatedBy: '',
  });
  const [canvasDirty, setCanvasDirty] = useState(false);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [presenceTyping, setPresenceTyping] = useState([]);
  const [contributionHeat, setContributionHeat] = useState([]);
  const [presenceEquity, setPresenceEquity] = useState({
    rows: [],
    totalMessages: 0,
    quietCount: 0,
    balanceScore: 100,
    dominantSharePct: 0,
    nudge: '',
  });
  const [cerGate, setCerGate] = useState({
    ok: true,
    phase: '',
    citations: 0,
    missing: [],
  });
  const [phaseExitGate, setPhaseExitGate] = useState({
    ok: true,
    stage: 'LOBBY',
    requirements: [],
    missing: [],
  });
  const [roleRotation, setRoleRotation] = useState({
    enabled: true,
    stage: 'LOBBY',
    myRole: '',
    assignments: [],
  });
  const [draftApproval, setDraftApproval] = useState({
    approvedByUids: [],
    approvedCount: 0,
    requiredApprovals: 1,
    approvedVersion: 0,
    approvedAt: 0,
  });
  const [privateDraft, setPrivateDraft] = useState({
    text: '',
    updatedAt: 0,
    submittedAt: 0,
    submitted: false,
  });
  const [sharedDraftSubmissions, setSharedDraftSubmissions] = useState([]);
  const [decisionLog, setDecisionLog] = useState([]);
  const [qualityScorecard, setQualityScorecard] = useState({
    total: 0,
    completion: 0,
    evidenceQuality: 0,
    participationBalance: 0,
    policyAdherence: 0,
    draftVersion: 0,
    finalReadyCount: 0,
    seats: 0,
  });
  const [aiFallback, setAiFallback] = useState({
    active: false,
    templates: [],
    lastFallbackAt: 0,
    lastFallbackReason: '',
    lastFallbackStage: '',
  });
  const [privateDraftBusy, setPrivateDraftBusy] = useState(false);
  const [draftApprovalBusy, setDraftApprovalBusy] = useState(false);
  const [interventionBusy, setInterventionBusy] = useState('');
  const [roomError, setRoomError] = useState('');
  const [prefs, setPrefs] = useState(loadA11yPrefs);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayEntries, setReplayEntries] = useState([]);
  const [replayCursor, setReplayCursor] = useState(0);
  const typingPingRef = useRef({ at: 0 });
  const privateDraftDirtyRef = useRef(false);
  const privateDraftUpdatedAtRef = useRef(0);
  const [optimisticMessages, setOptimisticMessages] = useState([]);
  const [offlineQueueDepth, setOfflineQueueDepth] = useState(0);
  const [offlineFlushBusy, setOfflineFlushBusy] = useState(false);
  const offlineFlushRef = useRef(false);
  const offlineQueueKey = useMemo(() => `storibloom_offline_queue_v1:${roomId}`, [roomId]);

  useEffect(() => {
    localStorage.setItem('participant_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    return subscribeA11yPrefs((next) => setPrefs(next));
  }, []);

  useEffect(() => {
    privateDraftUpdatedAtRef.current = Number(privateDraft.updatedAt || 0) || 0;
  }, [privateDraft.updatedAt]);

  useEffect(() => {
    if (CANVAS_PHASES.includes(stage)) {
      setCanvasPhase(stage);
    }
  }, [stage]);

  // --- Auth bootstrap ---
  useEffect(() => {
    let active = true;
    ensureGuest()
      .then(() => {
        if (active) setAuthReady(true);
      })
      .catch((e) => {
        console.error('[Room] ensureGuest failed', e);
        if (active) setAuthReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const speakText = useCallback((raw) => {
    const textValue = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!textValue) return;
    if (typeof window === 'undefined' || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(textValue);
      utterance.rate = 0.98;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[Room] read-aloud failed', err);
    }
  }, []);

  useEffect(() => {
    if (!prefs.readAloud) return;
    const goal = STAGE_GOALS[stage] || '';
    const hint = NEXT_ACTION_HINTS[stage] || '';
    const script = [
      `Phase ${String(stage || 'LOBBY').replace(/_/g, ' ')}`,
      goal ? `Goal: ${goal}` : '',
      hint ? `Next action: ${hint}` : '',
    ]
      .filter(Boolean)
      .join('. ');
    if (script) speakText(script);
  }, [prefs.readAloud, speakText, stage]);

  const fetchCanvas = useCallback(
    async (phase) => {
      if (!authReady) return;
      const targetPhase =
        CANVAS_PHASES.includes(String(phase || '').toUpperCase())
          ? String(phase || '').toUpperCase()
          : canvasPhase;
      try {
        const res = await fetch(
          `${API_BASE}/rooms/${roomId}/canvas?phase=${encodeURIComponent(targetPhase)}`,
          await authHeaders()
        );
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        const next = data.canvas || {};
        setCanvas({
          stickyNotes: String(next.stickyNotes || next.ideas || ''),
          outlineMap: String(next.outlineMap || next.structure || ''),
          evidenceBoard: String(next.evidenceBoard || ''),
          narrativeMap: String(next.narrativeMap || next.map || ''),
          ideas: String(next.ideas || next.stickyNotes || ''),
          structure: String(next.structure || next.outlineMap || ''),
          map: String(next.map || next.narrativeMap || ''),
          updatedAt: Number(next.updatedAt || 0),
          updatedBy: String(next.updatedBy || ''),
        });
        setCanvasDirty(false);
      } catch (e) {
        console.warn('[Room] fetchCanvas error', e);
      }
    },
    [authReady, canvasPhase, roomId]
  );

  const saveCanvas = useCallback(async () => {
    if (!authReady || !canvasDirty || canvasSaving) return;
    setCanvasSaving(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/canvas`, {
        method: 'PUT',
        ...(await authHeaders()),
        body: JSON.stringify({
          phase: canvasPhase,
          stickyNotes: canvas.stickyNotes || canvas.ideas || '',
          outlineMap: canvas.outlineMap || canvas.structure || '',
          evidenceBoard: canvas.evidenceBoard || '',
          narrativeMap: canvas.narrativeMap || canvas.map || '',
        }),
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const next = data.canvas || {};
      setCanvas({
        stickyNotes: String(next.stickyNotes || next.ideas || ''),
        outlineMap: String(next.outlineMap || next.structure || ''),
        evidenceBoard: String(next.evidenceBoard || ''),
        narrativeMap: String(next.narrativeMap || next.map || ''),
        ideas: String(next.ideas || next.stickyNotes || ''),
        structure: String(next.structure || next.outlineMap || ''),
        map: String(next.map || next.narrativeMap || ''),
        updatedAt: Number(next.updatedAt || 0),
        updatedBy: String(next.updatedBy || ''),
      });
      setCanvasDirty(false);
    } catch (e) {
      console.warn('[Room] saveCanvas error', e);
    } finally {
      setCanvasSaving(false);
    }
  }, [authReady, canvas, canvasDirty, canvasPhase, canvasSaving, roomId]);

  const fetchPresence = useCallback(async () => {
    if (!authReady) return;
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/presence`, await authHeaders());
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      setPresenceTyping(Array.isArray(data.typing) ? data.typing : []);
      setContributionHeat(Array.isArray(data.contributionHeat) ? data.contributionHeat : []);
      setPresenceEquity(
        data?.equity && typeof data.equity === 'object'
          ? {
              rows: Array.isArray(data.equity.rows) ? data.equity.rows : [],
              totalMessages: Number(data.equity.totalMessages || 0),
              quietCount: Number(data.equity.quietCount || 0),
              balanceScore: Number.isFinite(Number(data.equity.balanceScore))
                ? Number(data.equity.balanceScore)
                : 100,
              dominantSharePct: Number(data.equity.dominantSharePct || 0),
              nudge: String(data.equity.nudge || ''),
            }
          : {
              rows: [],
              totalMessages: 0,
              quietCount: 0,
              balanceScore: 100,
              dominantSharePct: 0,
              nudge: '',
            }
      );
    } catch (e) {
      console.warn('[Room] fetchPresence error', e);
    }
  }, [authReady, roomId]);

  const pingTyping = useCallback(async () => {
    if (!authReady) return;
    const now = Date.now();
    if (now - Number(typingPingRef.current.at || 0) < 2200) return;
    typingPingRef.current.at = now;
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/presence/typing`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({
          emoji: personas[activePersona] || personas[0] || '🙂',
        }),
      });
    } catch {
      // best effort only
    }
  }, [activePersona, authReady, personas, roomId]);

  const loadReplay = useCallback(async () => {
    if (!authReady) return;
    setReplayLoading(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/replay?limit=900`, await authHeaders());
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      setReplayEntries(entries);
      setReplayCursor(Math.max(0, entries.length - 1));
    } catch (e) {
      console.warn('[Room] loadReplay error', e);
      setReplayEntries([]);
      setReplayCursor(0);
    } finally {
      setReplayLoading(false);
    }
  }, [authReady, roomId]);

  const readOfflineQueue = useCallback(() => {
    if (typeof sessionStorage === 'undefined') return [];
    try {
      const parsed = JSON.parse(sessionStorage.getItem(offlineQueueKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [offlineQueueKey]);

  const persistOfflineQueue = useCallback(
    (items = []) => {
      const safeItems = Array.isArray(items) ? items : [];
      if (typeof sessionStorage !== 'undefined') {
        try {
          if (safeItems.length) {
            sessionStorage.setItem(offlineQueueKey, JSON.stringify(safeItems));
          } else {
            sessionStorage.removeItem(offlineQueueKey);
          }
        } catch {}
      }
      setOfflineQueueDepth(safeItems.length);
    },
    [offlineQueueKey]
  );

  const flushOfflineQueue = useCallback(async () => {
    if (!authReady) return;
    if (offlineFlushRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let queue = readOfflineQueue();
    if (!queue.length) {
      setOfflineQueueDepth(0);
      return;
    }

    offlineFlushRef.current = true;
    setOfflineFlushBusy(true);
    try {
      for (const item of queue) {
        const textValue = String(item?.text || '').trim();
        if (!textValue) continue;
        try {
          const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
            method: 'POST',
            ...(await authHeaders()),
            body: JSON.stringify({
              text: textValue,
              phase: item?.phase || stage || 'LOBBY',
              personaIndex: Number(item?.personaIndex || 0),
              emoji: item?.emoji || null,
            }),
          });
          if (!res.ok) {
            throw new Error(`queued_message_failed_${res.status}`);
          }

          if (item?.triggerAsk && String(item.askText || '').trim()) {
            await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
              method: 'POST',
              ...(await authHeaders()),
              body: JSON.stringify({ text: String(item.askText || '') }),
            }).catch(() => {});
          }

          if (item?.triggerDraftGenerate) {
            await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
              method: 'POST',
              ...(await authHeaders()),
              body: JSON.stringify({ mode: 'ask' }),
            }).catch(() => {});
          }

          if (item?.triggerIdeas) {
            await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
              method: 'POST',
              ...(await authHeaders()),
            }).catch(() => {});
          }

          setOptimisticMessages((prev) => prev.filter((row) => row.id !== item.id));
          queue = queue.filter((row) => row.id !== item.id);
          persistOfflineQueue(queue);
        } catch {
          break;
        }
      }
    } finally {
      offlineFlushRef.current = false;
      setOfflineFlushBusy(false);
    }
  }, [authReady, roomId, stage, readOfflineQueue, persistOfflineQueue]);

  useEffect(() => {
    if (!canvasDirty) return undefined;
    const id = setTimeout(() => {
      void saveCanvas();
    }, 1400);
    return () => clearTimeout(id);
  }, [canvasDirty, canvas, saveCanvas]);

  // --- Live countdown tick ---
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (!CANVAS_PHASES.includes(canvasPhase)) return;
    fetchCanvas(canvasPhase);
  }, [authReady, canvasPhase, fetchCanvas]);

  useEffect(() => {
    if (!authReady) return;
    fetchPresence();
  }, [authReady, fetchPresence]);

  useEffect(() => {
    if (!replayOpen) return;
    loadReplay();
  }, [replayOpen, loadReplay]);

  useEffect(() => {
    const queued = readOfflineQueue();
    setOfflineQueueDepth(queued.length);
    setOptimisticMessages(
      queued.map((item) => ({
        id: item.id,
        authorType: 'user',
        phase: item.phase || 'LOBBY',
        text: item.text || '',
        emoji: item.emoji || '',
        personaIndex: Number(item.personaIndex || 0),
        deliveryState: 'queued',
      }))
    );
  }, [readOfflineQueue]);

  useEffect(() => {
    if (!authReady) return undefined;
    const onOnline = () => {
      void flushOfflineQueue();
    };
    window.addEventListener('online', onOnline);
    void flushOfflineQueue();
    return () => window.removeEventListener('online', onOnline);
  }, [authReady, flushOfflineQueue]);

  // --- Poll room state + messages ---
  useEffect(() => {
    if (!authReady) return;
    let mounted = true;

    async function loadState() {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/state`, await authHeaders());
        if (!res.ok) return;
        const j = await res.json();
        if (!mounted) return;

        setStage(j.stage || 'LOBBY');
        setStageEndsAt(j.stageEndsAt ? new Date(j.stageEndsAt) : null);

        setRoomMeta({
          siteId: j.siteId || roomId.split('-')[0],
          index: j.index || 1,
          inputLocked: !!j.inputLocked,
          topic: j.topic || '',
          seats: j.seats || 0,
          finalReadyCount: Number(j.finalReadyCount || 0),
          finalCompletedAt: j.finalCompletedAt || null,

          draftVersion: Number(j.draftVersion || 0),
          draftUpdatedAt: j.draftUpdatedAt || null,
          finalAbstract: j.finalAbstract || '',
          closedAt: j.closedAt || null,
          closedReason: j.closedReason || null,
          stageDurationSec: Number(j.stageDurationSec || 0),
        });

        setIdeaSummary(j.ideaSummary || '');
        setPresenceTyping(Array.isArray(j.typing) ? j.typing : []);
        setCerGate(
          j?.cerGate && typeof j.cerGate === 'object'
            ? {
                ok: j.cerGate.ok !== false,
                phase: String(j.cerGate.phase || ''),
                citations: Number(j.cerGate.citations || 0),
                missing: Array.isArray(j.cerGate.missing) ? j.cerGate.missing : [],
              }
            : { ok: true, phase: '', citations: 0, missing: [] }
        );
        setPhaseExitGate(
          j?.phaseExitGate && typeof j.phaseExitGate === 'object'
            ? {
                ok: j.phaseExitGate.ok !== false,
                stage: String(j.phaseExitGate.stage || j.stage || 'LOBBY'),
                requirements: Array.isArray(j.phaseExitGate.requirements)
                  ? j.phaseExitGate.requirements
                  : [],
                missing: Array.isArray(j.phaseExitGate.missing)
                  ? j.phaseExitGate.missing
                  : [],
              }
            : { ok: true, stage: j.stage || 'LOBBY', requirements: [], missing: [] }
        );
        setRoleRotation(
          j?.roleRotation && typeof j.roleRotation === 'object'
            ? {
                enabled: j.roleRotation.enabled !== false,
                stage: String(j.roleRotation.stage || j.stage || 'LOBBY'),
                myRole: String(j.roleRotation.myRole || ''),
                assignments: Array.isArray(j.roleRotation.assignments)
                  ? j.roleRotation.assignments
                  : [],
              }
            : { enabled: true, stage: j.stage || 'LOBBY', myRole: '', assignments: [] }
        );
        setDraftApproval(
          j?.draftApproval && typeof j.draftApproval === 'object'
            ? {
                approvedByUids: Array.isArray(j.draftApproval.approvedByUids)
                  ? j.draftApproval.approvedByUids
                  : [],
                approvedCount: Number(j.draftApproval.approvedCount || 0),
                requiredApprovals: Number(j.draftApproval.requiredApprovals || 1),
                approvedVersion: Number(j.draftApproval.approvedVersion || 0),
                approvedAt: Number(j.draftApproval.approvedAt || 0) || 0,
              }
            : {
                approvedByUids: [],
                approvedCount: 0,
                requiredApprovals: 1,
                approvedVersion: 0,
                approvedAt: 0,
              }
        );
        const incomingPrivateDraft =
          j?.privateDraft && typeof j.privateDraft === 'object'
            ? {
                text: String(j.privateDraft.text || ''),
                updatedAt: Number(j.privateDraft.updatedAt || 0) || 0,
                submittedAt: Number(j.privateDraft.submittedAt || 0) || 0,
                submitted: !!j.privateDraft.submitted,
              }
            : { text: '', updatedAt: 0, submittedAt: 0, submitted: false };
        const incomingUpdatedAt = Number(incomingPrivateDraft.updatedAt || 0) || 0;
        const localUpdatedAt = Number(privateDraftUpdatedAtRef.current || 0) || 0;
        if (!privateDraftDirtyRef.current || incomingUpdatedAt >= localUpdatedAt) {
          setPrivateDraft(incomingPrivateDraft);
          if (incomingUpdatedAt >= localUpdatedAt) privateDraftDirtyRef.current = false;
        }
        setSharedDraftSubmissions(
          Array.isArray(j.sharedDraftSubmissions) ? j.sharedDraftSubmissions : []
        );
        setDecisionLog(Array.isArray(j.decisionLog) ? j.decisionLog : []);
        setQualityScorecard(
          j?.qualityScorecard && typeof j.qualityScorecard === 'object'
            ? {
                total: Number(j.qualityScorecard.total || 0),
                completion: Number(j.qualityScorecard.completion || 0),
                evidenceQuality: Number(j.qualityScorecard.evidenceQuality || 0),
                participationBalance: Number(j.qualityScorecard.participationBalance || 0),
                policyAdherence: Number(j.qualityScorecard.policyAdherence || 0),
                draftVersion: Number(j.qualityScorecard.draftVersion || 0),
                finalReadyCount: Number(j.qualityScorecard.finalReadyCount || 0),
                seats: Number(j.qualityScorecard.seats || 0),
              }
            : {
                total: 0,
                completion: 0,
                evidenceQuality: 0,
                participationBalance: 0,
                policyAdherence: 0,
                draftVersion: 0,
                finalReadyCount: 0,
                seats: 0,
              }
        );
        setAiFallback(
          j?.aiFallback && typeof j.aiFallback === 'object'
            ? {
                active: !!j.aiFallback.active,
                templates: Array.isArray(j.aiFallback.templates) ? j.aiFallback.templates : [],
                lastFallbackAt: Number(j.aiFallback.lastFallbackAt || 0) || 0,
                lastFallbackReason: String(j.aiFallback.lastFallbackReason || ''),
                lastFallbackStage: String(j.aiFallback.lastFallbackStage || ''),
              }
            : {
                active: false,
                templates: [],
                lastFallbackAt: 0,
                lastFallbackReason: '',
                lastFallbackStage: '',
              }
        );
      } catch (e) {
        if (mounted) console.error('[Room] loadState error', e);
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, await authHeaders());
        if (!res.ok) return;
        const j = await res.json();
        if (!mounted) return;
        const arr = (j.messages || []).map((m, idx) => ({
          id: String(m.createdAt || idx),
          ...m,
        }));
        setMessages(arr);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch (e) {
        if (mounted) console.error('[Room] loadMessages error', e);
      }
    }

    loadState();
    loadMessages();

    const es = new EventSource(
      buildSseUrl(`/rooms/${encodeURIComponent(roomId)}/events`)
    );
    const refreshRoom = () => {
      loadState();
      loadMessages();
      fetchCanvas(canvasPhase);
    };
    const refreshVote = () => {
      loadState();
      loadMessages();
      fetchVoteStatus();
    };
    const refreshPresence = () => {
      fetchPresence();
    };
    const refreshCanvas = () => {
      fetchCanvas(canvasPhase);
    };
    es.addEventListener('ready', refreshRoom);
    es.addEventListener('room_state', refreshRoom);
    es.addEventListener('message', loadMessages);
    es.addEventListener('vote_update', refreshVote);
    es.addEventListener('presence_update', refreshPresence);
    es.addEventListener('canvas_update', refreshCanvas);
    es.onerror = () => {
      // Browser EventSource auto-reconnects.
    };

    return () => {
      mounted = false;
      es.removeEventListener('ready', refreshRoom);
      es.removeEventListener('room_state', refreshRoom);
      es.removeEventListener('message', loadMessages);
      es.removeEventListener('vote_update', refreshVote);
      es.removeEventListener('presence_update', refreshPresence);
      es.removeEventListener('canvas_update', refreshCanvas);
      es.close();
    };
  }, [authReady, roomId, canvasPhase, fetchCanvas, fetchPresence]);

  // --- Auto-greet when DISCOVERY begins (once per mount) ---
  useEffect(() => {
    (async () => {
      if (!authReady) return;
      if (stage === 'DISCOVERY' && !sentWelcome) {
        setSentWelcome(true);
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/welcome`, {
            method: 'POST',
            ...(await authHeaders()),
          });
        } catch (e) {
          console.warn('[Room] welcome failed', e);
        }
      }
    })();
  }, [authReady, stage, sentWelcome, roomId]);

  // --- Voting helpers (simple glue to backend) ---
  async function fetchVoteStatus() {
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote`, {
        method: 'GET',
        ...(await authHeaders()),
      });
      if (!res.ok) return;
      const j = await res.json();
      setVoteOpen(!!j.votingOpen);
      setVoteOptions(Array.isArray(j.options) ? j.options : []);
      setVoteCounts(j.counts || null);
      setVoteTopic(j.topic || '');
      setVoteReadyCount(Number(j.voteReadyCount || 0));
      setVoteSubmittedCount(Number(j.voteSubmittedCount || 0));
      setVoteSeats(j.seats || 0);

      if (!j.votingOpen) {
        setHasVoted(false);
        setVoteModalOpen(false);
      }
    } catch (e) {
      console.warn('[Room] fetchVoteStatus error', e);
    }
  }

  async function startVote() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/start`, {
        method: 'POST',
        ...(await authHeaders()),
      });
      await fetchVoteStatus();
    } catch (e) {
      console.warn('[Room] startVote error', e);
    }
  }

  async function submitVote(choiceNum) {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/submit`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ choice: Number(choiceNum) }),
      });
      setHasVoted(true);
      await fetchVoteStatus();
    } catch (e) {
      console.warn('[Room] submitVote error', e);
    }
  }

  async function closeVote() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/close`, {
        method: 'POST',
        ...(await authHeaders()),
      });
      await fetchVoteStatus();
    } catch (e) {
      console.warn('[Room] closeVote error', e);
    }
  }

  async function markReadyToVote() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/ready`, {
        method: 'POST',
        ...(await authHeaders()),
      });
      setHasMarkedReady(true);
      await fetchVoteStatus();
    } catch (e) {
      console.warn('[Room] markReadyToVote error', e);
    }
  }

  useEffect(() => {
    if (!authReady) return;
    if (stage !== 'DISCOVERY') {
      setVoteOpen(false);
      setVoteModalOpen(false);
      setHasMarkedReady(false);
      return;
    }
    fetchVoteStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, stage, roomId]);

  // --- Rough Draft: Generate / Regenerate via backend ---
  async function generateRough(requestMode) {
    if (draftBusy) return;
    setDraftBusy(true);
    try {
      const m = requestMode || (hasDraft ? 'regen' : undefined);

      const opts = { method: 'POST', ...(await authHeaders()) };
      if (m) opts.body = JSON.stringify({ mode: m });

      const res = await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, opts);
      if (!res.ok) {
        console.error('[Room] draft/generate failed', await res.text().catch(() => ''));
        return;
      }
      setHasDraft(true);
    } catch (e) {
      console.error('[Room] generateRough error', e);
    } finally {
      setDraftBusy(false);
    }
  }

  // --- Planning: share outline as a single chat message ---
  async function sharePlanningOutline() {
    if (planningBusy) return;
    const focus = planningFocus.trim();
    const structure = planningStructure.trim();
    const keyPointsRaw = planningKeyPoints.trim();
    if (!focus && !structure && !keyPointsRaw) return;

    setPlanningBusy(true);
    try {
      const bullets = keyPointsRaw
        ? keyPointsRaw
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => `- ${s}`)
            .join('\n')
        : '';

      const msg = [
        '🧩 **Planning Outline**',
        focus ? `**1️⃣ Focus / angle:** ${focus}` : '',
        structure ? `**2️⃣ Structure:** ${structure}` : '',
        bullets ? `**3️⃣ Key beats:**\n${bullets}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({
          text: msg,
          phase: 'PLANNING',
          personaIndex: activePersona,
          emoji: personas[activePersona] || personas[0],
        }),
      });
    } catch (e) {
      console.error('[Room] sharePlanningOutline error', e);
    } finally {
      setPlanningBusy(false);
    }
  }

  async function savePrivateDraft() {
    if (privateDraftBusy) return;
    const textValue = String(privateDraft.text || '').trim();
    if (!textValue) return;
    setPrivateDraftBusy(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/private-draft`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ text: textValue }),
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => ({}));
      if (payload?.privateDraft && typeof payload.privateDraft === 'object') {
        setPrivateDraft({
          text: String(payload.privateDraft.text || ''),
          updatedAt: Number(payload.privateDraft.updatedAt || 0) || 0,
          submittedAt: Number(payload.privateDraft.submittedAt || 0) || 0,
          submitted: !!payload.privateDraft.submitted,
        });
        privateDraftDirtyRef.current = false;
      }
    } catch (err) {
      console.warn('[Room] savePrivateDraft error', err);
    } finally {
      setPrivateDraftBusy(false);
    }
  }

  async function submitPrivateDraft() {
    if (privateDraftBusy) return;
    const textValue = String(privateDraft.text || '').trim();
    if (!textValue) return;
    setPrivateDraftBusy(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/private-draft/submit`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ text: textValue }),
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => ({}));
      if (payload?.privateDraft && typeof payload.privateDraft === 'object') {
        setPrivateDraft({
          text: String(payload.privateDraft.text || ''),
          updatedAt: Number(payload.privateDraft.updatedAt || 0) || 0,
          submittedAt: Number(payload.privateDraft.submittedAt || 0) || 0,
          submitted: !!payload.privateDraft.submitted,
        });
        privateDraftDirtyRef.current = false;
      }
      if (Array.isArray(payload?.submissions)) {
        setSharedDraftSubmissions(payload.submissions);
      }
    } catch (err) {
      console.warn('[Room] submitPrivateDraft error', err);
    } finally {
      setPrivateDraftBusy(false);
    }
  }

  async function mergeSharedDraft(sourceUid, mode = 'append') {
    const uid = String(sourceUid || '').trim();
    if (!uid || privateDraftBusy) return;
    setPrivateDraftBusy(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/private-draft/merge`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ sourceUid: uid, mode }),
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => ({}));
      if (Array.isArray(payload?.submissions)) {
        setSharedDraftSubmissions(payload.submissions);
      }
      if (Number(payload?.version || 0) > 0) {
        setRoomMeta((prev) => ({ ...prev, draftVersion: Number(payload.version || prev.draftVersion || 0) }));
        setHasDraft(true);
      }
      privateDraftDirtyRef.current = false;
    } catch (err) {
      console.warn('[Room] mergeSharedDraft error', err);
    } finally {
      setPrivateDraftBusy(false);
    }
  }

  async function approveRoomDraft(approved = true) {
    if (draftApprovalBusy) return;
    setDraftApprovalBusy(true);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/draft/approve`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => ({}));
      setDraftApproval((prev) => ({
        ...prev,
        approvedByUids: Array.isArray(payload.approvedByUids) ? payload.approvedByUids : [],
        approvedCount: Number(payload.approvedCount || 0),
        requiredApprovals: Number(payload.requiredApprovals || prev.requiredApprovals || 1),
        approvedVersion: Number(payload.approvedVersion || 0),
        approvedAt: Number(payload.approvedAt || 0) || 0,
      }));
    } catch (err) {
      console.warn('[Room] approveRoomDraft error', err);
    } finally {
      setDraftApprovalBusy(false);
    }
  }

  async function runRoomIntervention(kind) {
    if (!isPresenter || !kind) return;
    setInterventionBusy(kind);
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/intervention`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ kind }),
      });
    } catch (err) {
      console.warn('[Room] runRoomIntervention error', err);
    } finally {
      setInterventionBusy('');
    }
  }

  function applyFallbackTemplate(prompt) {
    const textValue = String(prompt || '').trim();
    if (!textValue) return;
    setText(textValue);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // --- Send message (user) ---
  async function send() {
    const t = text.trim();
    if (!t) return;
    setRoomError('');

    if (stage === 'ROUGH_DRAFT' && draftBusy) return;
    if (stage === 'CLOSED') return;
    if (roomMeta.inputLocked && stage !== 'FINAL' && stage !== 'ROUGH_DRAFT') return;

    const emoji = personas[activePersona] || personas[0];

    const lower = t.toLowerCase();
    const addressedAsema = /(^|\s)asema[\s,!?]/i.test(t) || /^asema\b/i.test(t);
    const wantsRoughDraft =
      /rough\s+draft/i.test(lower) ||
      /(generate|write|make|create|spin up).*(draft|abstract)/i.test(lower);
    const shouldTriggerIdeas =
      stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING';
    const triggerDraftGenerate = stage === 'ROUGH_DRAFT' && wantsRoughDraft;
    const triggerAsk = addressedAsema && !triggerDraftGenerate;
    const optimisticId = `local-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;

    setOptimisticMessages((prev) =>
      prev.concat({
        id: optimisticId,
        authorType: 'user',
        phase: stage,
        text: t,
        emoji: emoji || null,
        personaIndex: activePersona,
        deliveryState: 'sending',
      })
    );

    let queuedOffline = false;
    let keepInput = false;
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({
          text: t,
          phase: stage,
          personaIndex: activePersona,
          emoji,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const message =
          payload.reason ||
          payload.error ||
          payload.message ||
          `send_failed_${res.status}`;
        if (isPolicyBlockedError(payload.error)) {
          setRoomError(
            payload.reason ||
              'Blocked by organization safety policy. Use policy-safe language and remove personal identifiers.'
          );
          keepInput = true;
        }
        throw new Error(message);
      }
      const payload = await res.json().catch(() => ({}));
      if (payload?.blocked === 'cer_required') {
        const missing = describeCerMissing(payload?.cerGate?.missing || []);
        setRoomError(
          missing
            ? `Final output gate: complete ${missing} in the Evidence Board before close.`
            : 'Final output gate: complete Claim, Evidence, Reasoning, and at least one citation.'
        );
      }
      setOptimisticMessages((prev) => prev.filter((row) => row.id !== optimisticId));
    } catch (e) {
      const transientNetworkError =
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        /fetch|network|offline/i.test(String(e?.message || ''));
      if (transientNetworkError) {
        queuedOffline = true;
        setOptimisticMessages((prev) =>
          prev.map((row) =>
            row.id === optimisticId ? { ...row, deliveryState: 'queued' } : row
          )
        );
        const queue = readOfflineQueue();
        const nextQueue = queue
          .filter((row) => row.id !== optimisticId)
          .concat({
            id: optimisticId,
            text: t,
            phase: stage,
            personaIndex: activePersona,
            emoji: emoji || null,
            queuedAt: Date.now(),
            triggerAsk,
            askText: t,
            triggerDraftGenerate,
            triggerIdeas: shouldTriggerIdeas,
          });
        persistOfflineQueue(nextQueue);
      } else {
        setOptimisticMessages((prev) => prev.filter((row) => row.id !== optimisticId));
        const message = String(e?.message || '');
        if (
          /content_blocked|cer_required/i.test(message) ||
          /organization safety policy|safety policy/i.test(message)
        ) {
          setRoomError((prev) =>
            prev ||
            message
              .replace(/^content_blocked_by_school_policy$/i, 'Blocked by organization safety policy.')
              .replace(/^content_blocked_by_policy$/i, 'Blocked by organization safety policy.')
          );
          keepInput = true;
        }
        console.error('[Room] send error', e);
      }
    }
    if (!keepInput) {
      setText('');
    }

    if (queuedOffline) return;

    if (triggerDraftGenerate) {
      generateRough('ask');
    } else if (triggerAsk) {
      try {
        const askRes = await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
          method: 'POST',
          ...(await authHeaders()),
          body: JSON.stringify({ text: t }),
        });
        if (!askRes.ok) {
          const payload = await askRes.json().catch(() => ({}));
          if (isPolicyBlockedError(payload.error)) {
            setRoomError(
              payload.reason ||
                'Ask blocked by organization safety policy. Rephrase with policy-safe language.'
            );
          }
        }
      } catch (e) {
        console.error('[Room] ask error', e);
      }
    }

    if (shouldTriggerIdeas) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          ...(await authHeaders()),
        });
      } catch (e) {
        console.warn('[Room] ideas/trigger error', e);
      }
    }

    if (offlineQueueDepth > 0) {
      void flushOfflineQueue();
    }

    // NOTE: FINAL “done/submit” is now handled server-side in /messages, so no extra call needed.
  }

  const applyPromptFromReceipt = useCallback((promptText) => {
    const next = String(promptText || '').trim();
    if (!next) return;
    setText(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // --- Derived UI state ---
  const total = Number(roomMeta.stageDurationSec || 0) || TOTAL_BY_STAGE[stage] || 1;
  const secsLeft =
    stage === 'CLOSED'
      ? 0
      : stageEndsAt
      ? Math.max(0, Math.floor((stageEndsAt.getTime() - nowTick) / 1000))
      : 0;

  const roundIndex = Math.max(1, ORDER.indexOf(stage) + 1 || 1);
  const roundTotal = ORDER.length;
  const statusTopic = roomMeta.topic || voteTopic || 'No topic selected yet';

  const draftingHold = stage === 'ROUGH_DRAFT' && draftBusy;

  const canType =
    stage !== 'CLOSED' &&
    (!roomMeta.inputLocked || stage === 'FINAL' || stage === 'ROUGH_DRAFT') &&
    !draftingHold;

  let inputPlaceholder = 'Type your message… (say "Asema, ..." to ask her)';
  if (draftingHold) inputPlaceholder = 'Asema is generating your rough draft…';
  else if (!canType) {
    inputPlaceholder =
      stage === 'CLOSED'
        ? 'Session is closed — scroll up and copy your abstract.'
        : 'Input locked in this phase';
  }

  const effectivePhase = stage === 'CLOSED' ? 'FINAL' : stage;
  const phaseMessages = useMemo(
    () =>
      messages
        .filter((m) => (m.phase || 'LOBBY') === effectivePhase)
        .concat(optimisticMessages.filter((m) => (m.phase || 'LOBBY') === effectivePhase)),
    [messages, optimisticMessages, effectivePhase]
  );

  // FINAL stage ready meter
  const readyCount = roomMeta.finalReadyCount || 0;
  const totalSeats = roomMeta.seats || 0;
  const readyPct = totalSeats ? Math.round((readyCount / totalSeats) * 100) : 0;

  const displayVoteSeats = voteSeats || roomMeta.seats || 0;
  const liveQualityScorecard = useMemo(() => {
    const participation = Number.isFinite(Number(presenceEquity?.balanceScore))
      ? Math.max(0, Math.min(100, Number(presenceEquity.balanceScore)))
      : Number(qualityScorecard.participationBalance || 0);
    const completion = Number(qualityScorecard.completion || 0);
    const evidenceQuality = Number(qualityScorecard.evidenceQuality || 0);
    const policyAdherence = Number(qualityScorecard.policyAdherence || 0);
    const total = Math.round(
      completion * 0.3 + evidenceQuality * 0.3 + participation * 0.2 + policyAdherence * 0.2
    );
    return {
      ...qualityScorecard,
      total,
      participationBalance: participation,
    };
  }, [qualityScorecard, presenceEquity]);

  const phaseGateChecklist = Array.isArray(phaseExitGate.requirements)
    ? phaseExitGate.requirements
    : [];
  const draftApprovalComplete =
    Number(draftApproval.approvedVersion || 0) === Number(roomMeta.draftVersion || 0) &&
    Number(draftApproval.approvedCount || 0) >= Number(draftApproval.requiredApprovals || 1);

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="room-wrap">
        <TopBanner siteId={roomMeta.siteId} roomIndex={roomMeta.index} stage={stage} />

        {/* Status strip */}
        <div className="status-strip">
          <span className="status-chip">
            {stage === 'CLOSED' ? (
              <>
                Session <b>Complete</b>
              </>
            ) : (
              <>
                Round <b>{roundIndex}</b> of <b>{roundTotal}</b>
              </>
            )}
          </span>
          <span className="status-dot">•</span>
          <span className="status-chip">
            {stage === 'CLOSED' ? (
              <>
                Time left: <b>0:00</b>
              </>
            ) : (
              <>
                Time left: <b>{formatTime(secsLeft)}</b>
              </>
            )}
          </span>
          <span className="status-dot">•</span>
          <span className="status-topic" title={statusTopic}>
            Topic: <b>{statusTopic}</b>
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            <button
              type="button"
              className={`btn ${viewMode === 'simple' ? 'primary' : 'ghost'}`}
              onClick={() => setViewMode('simple')}
            >
              Simple
            </button>
            <button
              type="button"
              className={`btn ${viewMode === 'expanded' ? 'primary' : 'ghost'}`}
              onClick={() => setViewMode('expanded')}
            >
              Full
            </button>
            <button type="button" className="btn" onClick={() => setReplayOpen(true)}>
              Replay
            </button>
            {offlineQueueDepth > 0 ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => void flushOfflineQueue()}
                disabled={offlineFlushBusy}
                title="Retry queued messages now"
              >
                {offlineFlushBusy ? 'Retrying…' : `Queued ${offlineQueueDepth}`}
              </button>
            ) : null}
          </span>
        </div>

        {roomError ? (
          <div className="hud-pill hud-pill-alert mt6">
            {roomError}
          </div>
        ) : null}

        {phaseExitGate.ok === false && stage !== 'CLOSED' ? (
          <div className="hud-pill hud-pill-alert mt6">
            Phase exit is blocked until required outputs are complete for this stage.
          </div>
        ) : null}

        {prefs.captionedPrompts ? (
          <div className="prompt-caption" role="status" aria-live="polite">
            <span><b>Phase goal:</b> {STAGE_GOALS[stage] || 'Keep momentum with your group.'}</span>
            <span><b>Next action:</b> {NEXT_ACTION_HINTS[stage] || 'Share one concrete line and build together.'}</span>
          </div>
        ) : null}

        {/* Optional pinned final abstract (when CLOSED and server saved it) */}
        {stage === 'CLOSED' && (roomMeta.finalAbstract || '').trim() && (
          <div className="hud-pill final-abstract-card mt12">
            <div className="final-abstract-title">Final Abstract</div>
            {roomMeta.finalAbstract}
            <PremiumExportActions
              className="mt12"
              title={`Room ${roomMeta.index || 1} Story`}
              topic={statusTopic}
              content={roomMeta.finalAbstract}
              orgLabel={roomMeta.siteId || 'StoryBloom'}
            />
          </div>
        )}

        <div className="room-main-grid">
          {/* Chat card */}
          <div className="chat stagger-item">
            {/* Header */}
            <div className="chat-head">
              <span className="stage-badge">{stage === 'CLOSED' ? 'SESSION COMPLETE' : stage}</span>
              <div className="ribbon" style={{ marginLeft: 10 }}>
                {ORDER.map((s) => (
                  <span key={s} className={s === stage ? 'on' : ''}>
                    {s}
                  </span>
                ))}
              </div>

              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <CountdownRing secondsLeft={secsLeft} secondsTotal={total || 1} />
                <div className="persona-choices" title="Choose persona">
                  {personas.map((p, i) => (
                    <button
                      key={i}
                      className={i === activePersona ? 'active' : ''}
                      onClick={() => setActivePersona(i)}
                      disabled={draftingHold || stage === 'CLOSED'}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="chat-body">
              {phaseMessages.map((m) => (
                <ChatMessage
                  key={m.id}
                  kind={m.authorType === 'asema' ? 'asema' : 'user'}
                  who={
                    m.authorType === 'asema'
                      ? '🤖'
                      : m.emoji || personas[m.personaIndex] || personas[0] || '🙂'
                  }
                  text={m.text}
                  aiReceipt={m.aiReceipt}
                  deliveryState={m.deliveryState || ''}
                  enableReadAloud={!!prefs.readAloud}
                  onUsePromptLineage={applyPromptFromReceipt}
                />
              ))}
              {!phaseMessages.length ? (
                <div className="empty-state mini">
                  No messages in this phase yet. Start with one line from your table.
                </div>
              ) : null}
            </div>

            {/* Tiny "Asema is drafting…" chip above input */}
            {draftingHold && (
              <div
                style={{
                  margin: '0 12px 6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  background: 'rgba(240,200,107,0.12)',
                  border: '1px solid rgba(240,200,107,0.45)',
                  color: '#f9fafb',
                }}
                aria-live="polite"
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 30% 30%, #fffbeb, #facc15)',
                    boxShadow: '0 0 8px rgba(250,204,21,0.9)',
                  }}
                />
                Asema is generating your rough draft…
              </div>
            )}

            {/* Input dock */}
            <div className="chat-input">
              <div className="persona-pill">
                {stage === 'CLOSED' ? (
                  <b style={{ fontSize: 16 }}>Session closed — copy your abstract above.</b>
                ) : (
                  <>
                    Speaking as{' '}
                    <b style={{ fontSize: 16 }}>{personas[activePersona] || personas[0]}</b>
                  </>
                )}
              </div>

              <div className="input-pill" style={{ opacity: canType ? 1 : 0.5 }}>
                <input
                  ref={inputRef}
                  placeholder={inputPlaceholder}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (e.target.value.trim()) {
                      void pingTyping();
                    }
                  }}
                  onKeyDown={(e) => (e.key === 'Enter' && canType ? send() : null)}
                  disabled={!canType}
                />
              </div>
              <button className="btn primary" onClick={send} disabled={!canType || !text.trim()}>
                Send
              </button>
            </div>
          </div>

          <div className="room-sidebar-stack stagger-item">
            {viewMode !== 'simple' && (
              <StageTimelineRail
                stage={stage}
                order={ORDER}
                goals={STAGE_GOALS}
                hints={NEXT_ACTION_HINTS}
                secsLeft={secsLeft}
                totalSec={total || 1}
              />
            )}

            {(stage === 'DISCOVERY' || stage === 'IDEA_DUMP') && viewMode !== 'simple' ? (
              <IdeaSidebar summary={ideaSummary} />
            ) : null}

            {viewMode !== 'simple' && phaseGateChecklist.length ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">Phase Exit Criteria</div>
                    <div className="canvas-subtitle">
                      {phaseExitGate.ok
                        ? 'All required outputs are complete.'
                        : 'Complete all required outputs before this phase can advance.'}
                    </div>
                  </div>
                  <span className={`status-chip ${phaseExitGate.ok ? '' : 'status-chip-alert'}`}>
                    {phaseExitGate.ok ? 'Ready' : 'Blocked'}
                  </span>
                </div>
                <div className="canvas-guidance">
                  {phaseGateChecklist.map((item, idx) => (
                    <div key={`${item.id || idx}`}>
                      {item.met ? '✅' : '⬜'} <b>{item.label || item.id || `Requirement ${idx + 1}`}</b>
                      {item.detail ? ` — ${item.detail}` : ''}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {viewMode !== 'simple' && roleRotation.enabled && roleRotation.assignments.length ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">Role Rotation</div>
                    <div className="canvas-subtitle">
                      Roles auto-rotate each phase to balance participation.
                    </div>
                  </div>
                  {roleRotation.myRole ? (
                    <span className="status-chip">You: {roleLabel(roleRotation.myRole)}</span>
                  ) : null}
                </div>
                <div className="canvas-guidance">
                  {roleRotation.assignments.map((assignment) => (
                    <div key={`${assignment.uid}-${assignment.role}`}>
                      Seat {assignment.seat}: <b>{roleLabel(assignment.role)}</b>
                      {assignment.role === roleRotation.myRole ? ' (You)' : ''}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {viewMode !== 'simple' ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">In-Room Quality Scorecard</div>
                    <div className="canvas-subtitle">
                      Live quality checks before final submission.
                    </div>
                  </div>
                  <span className="status-chip">{liveQualityScorecard.total}/100</span>
                </div>
                <div className="canvas-guidance">
                  <div>Completion: <b>{Math.round(liveQualityScorecard.completion || 0)}%</b></div>
                  <div>Evidence quality: <b>{Math.round(liveQualityScorecard.evidenceQuality || 0)}%</b></div>
                  <div>
                    Participation balance: <b>{Math.round(liveQualityScorecard.participationBalance || 0)}%</b>
                  </div>
                  <div>Policy adherence: <b>{Math.round(liveQualityScorecard.policyAdherence || 0)}%</b></div>
                </div>
              </section>
            ) : null}

            {(stage === 'ROUGH_DRAFT' || stage === 'EDITING' || stage === 'FINAL') &&
            viewMode !== 'simple' ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">Private to Shared Draft Merge</div>
                    <div className="canvas-subtitle">
                      Draft privately, submit to merge panel, then merge into room output.
                    </div>
                  </div>
                  {privateDraft.submitted ? (
                    <span className="status-chip">Submitted {formatTimestamp(privateDraft.submittedAt)}</span>
                  ) : null}
                </div>
                <label className="canvas-field">
                  <span className="canvas-label">Your private draft</span>
                  <textarea
                    value={privateDraft.text}
                    rows={4}
                    onChange={(e) => {
                      privateDraftDirtyRef.current = true;
                      setPrivateDraft((prev) => ({
                        ...prev,
                        text: e.target.value,
                        submitted: false,
                        submittedAt: 0,
                      }));
                    }}
                    placeholder="Capture your own version before sharing with the room."
                    disabled={privateDraftBusy || stage === 'CLOSED'}
                  />
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={savePrivateDraft}
                    disabled={privateDraftBusy || !String(privateDraft.text || '').trim()}
                  >
                    {privateDraftBusy ? 'Saving…' : 'Save Private'}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={submitPrivateDraft}
                    disabled={privateDraftBusy || !String(privateDraft.text || '').trim()}
                  >
                    {privateDraftBusy ? 'Submitting…' : 'Submit to Merge Panel'}
                  </button>
                </div>
                {(stage === 'EDITING' || stage === 'FINAL') ? (
                  <div className="canvas-guidance">
                    <div>
                      Draft approvals: <b>{draftApproval.approvedCount || 0}</b> /{' '}
                      <b>{draftApproval.requiredApprovals || 1}</b>
                      {draftApprovalComplete ? ' ✅' : ''}
                    </div>
                    <div>
                      Approved version: <b>{draftApproval.approvedVersion || 0}</b> (current{' '}
                      <b>{roomMeta.draftVersion || 0}</b>)
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => approveRoomDraft(true)}
                        disabled={draftApprovalBusy || stage === 'CLOSED'}
                      >
                        {draftApprovalBusy ? 'Saving…' : 'Approve Current Draft'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => approveRoomDraft(false)}
                        disabled={draftApprovalBusy || stage === 'CLOSED'}
                      >
                        Remove Approval
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="canvas-guidance">
                  <b>Merge panel</b>
                  {!sharedDraftSubmissions.length ? (
                    <div>No submitted private drafts yet.</div>
                  ) : (
                    sharedDraftSubmissions.slice(0, 6).map((submission) => (
                      <div key={`${submission.uid}-${submission.submittedAt}`}>
                        <div>
                          <b>{submission.mine ? 'You' : submission.uid}</b> submitted{' '}
                          {formatTimestamp(submission.submittedAt)}
                          {submission.mergedAt ? ` · merged ${formatTimestamp(submission.mergedAt)}` : ''}
                        </div>
                        <div style={{ opacity: 0.84 }}>{submission.preview || submission.text}</div>
                        <div className="row" style={{ gap: 8, marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => mergeSharedDraft(submission.uid, 'append')}
                            disabled={privateDraftBusy || stage === 'CLOSED'}
                          >
                            Merge Into Draft
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => mergeSharedDraft(submission.uid, 'replace')}
                            disabled={privateDraftBusy || stage === 'CLOSED'}
                          >
                            Replace Draft
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            ) : null}

            {viewMode !== 'simple' ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">Decision Log</div>
                    <div className="canvas-subtitle">
                      Pinned timeline of votes, draft milestones, and facilitator actions.
                    </div>
                  </div>
                </div>
                <div className="canvas-guidance">
                  {!decisionLog.length ? (
                    <div>No decision events captured yet.</div>
                  ) : (
                    decisionLog.slice(0, 10).map((entry) => (
                      <div key={entry.id || `${entry.type}-${entry.at}`}>
                        <b>{formatTimestamp(entry.at)}</b> · {entry.label || roleLabel(entry.type || 'Event')}
                      </div>
                    ))
                  )}
                </div>
              </section>
            ) : null}

            {viewMode !== 'simple' && (aiFallback.active || stage !== 'CLOSED') ? (
              <section className="canvas-panel">
                <div className="canvas-head">
                  <div>
                    <div className="canvas-title">AI Fallback Panel</div>
                    <div className="canvas-subtitle">
                      Deterministic prompts keep teams moving if AI generation is unstable.
                    </div>
                  </div>
                  <span className={`status-chip ${aiFallback.active ? 'status-chip-alert' : ''}`}>
                    {aiFallback.active ? 'Fallback Active' : 'Ready'}
                  </span>
                </div>
                <div className="canvas-guidance">
                  {aiFallback.active && aiFallback.lastFallbackAt ? (
                    <div>
                      Last fallback: <b>{formatTimestamp(aiFallback.lastFallbackAt)}</b>
                      {aiFallback.lastFallbackReason ? ` · ${aiFallback.lastFallbackReason}` : ''}
                    </div>
                  ) : null}
                  {(Array.isArray(aiFallback.templates) ? aiFallback.templates : []).map((template) => (
                    <div key={template.id || template.label}>
                      <div><b>{template.label || 'Template'}</b></div>
                      <div style={{ opacity: 0.84 }}>{template.prompt}</div>
                      <button
                        type="button"
                        className="btn ghost mt6"
                        onClick={() => applyFallbackTemplate(template.prompt)}
                        disabled={stage === 'CLOSED'}
                      >
                        Use Prompt
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {CANVAS_PHASES.includes(stage) && (
              <CollaborativeCanvas
                phase={canvasPhase}
                phases={CANVAS_PHASES}
                canvas={canvas}
                dirty={canvasDirty}
                saving={canvasSaving}
                disabled={stage === 'CLOSED'}
                phaseGoal={STAGE_GOALS[canvasPhase] || ''}
                nextHint={NEXT_ACTION_HINTS[canvasPhase] || ''}
                onPhaseChange={(next) => {
                  setCanvasPhase(next);
                  fetchCanvas(next);
                }}
                onChange={(field, value) => {
                  const alias = {
                    stickyNotes: 'ideas',
                    outlineMap: 'structure',
                    narrativeMap: 'map',
                  };
                  setCanvas((prev) => ({
                    ...prev,
                    [field]: value,
                    ...(alias[field] ? { [alias[field]]: value } : {}),
                  }));
                  setCanvasDirty(true);
                }}
                onSave={saveCanvas}
              />
            )}

            {stage === 'PLANNING' && viewMode !== 'simple' && (
              <div
                className="planning-panel"
                style={{
                  borderRadius: 16,
                  padding: 12,
                  background: 'rgba(15,23,42,0.9)',
                  border: '1px solid rgba(148,163,184,0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>🧩 Planning Board</div>
                <div style={{ opacity: 0.8, fontSize: 12, marginBottom: 6 }}>
                  Use this like a mini outline. When it feels good, click <b>“Share plan with
                  room”</b> so everyone sees the shape before Asema drafts.
                </div>

                {ideaSummary && (
                  <div
                    style={{
                      padding: 8,
                      borderRadius: 10,
                      background: 'rgba(30,64,175,0.25)',
                      border: '1px solid rgba(129,140,248,0.6)',
                      maxHeight: 120,
                      overflowY: 'auto',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Idea Highlights</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{ideaSummary}</div>
                  </div>
                )}

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>1️⃣ Focus / angle</span>
                  <input
                    type="text"
                    value={planningFocus}
                    onChange={(e) => setPlanningFocus(e.target.value)}
                    placeholder="ex: A teen stopped and profiled on his way to practice…"
                    style={{
                      borderRadius: 8,
                      border: '1px solid rgba(148,163,184,0.6)',
                      padding: '6px 8px',
                      background: 'rgba(15,23,42,0.9)',
                      color: 'white',
                      fontSize: 12,
                    }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>2️⃣ Structure</span>
                  <input
                    type="text"
                    value={planningStructure}
                    onChange={(e) => setPlanningStructure(e.target.value)}
                    placeholder="ex: 3-part story (setup → turning point → what changes)"
                    style={{
                      borderRadius: 8,
                      border: '1px solid rgba(148,163,184,0.6)',
                      padding: '6px 8px',
                      background: 'rgba(15,23,42,0.9)',
                      color: 'white',
                      fontSize: 12,
                    }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>3️⃣ Key beats (one per line)</span>
                  <textarea
                    value={planningKeyPoints}
                    onChange={(e) => setPlanningKeyPoints(e.target.value)}
                    placeholder={`ex:\nHe gets stopped and searched in front of neighbors\nCoach shows up and confronts officers\nHe decides how to respond and what community action to take`}
                    rows={4}
                    style={{
                      borderRadius: 8,
                      border: '1px solid rgba(148,163,184,0.6)',
                      padding: '6px 8px',
                      background: 'rgba(15,23,42,0.9)',
                      color: 'white',
                      fontSize: 12,
                      resize: 'vertical',
                    }}
                  />
                </label>

                <button
                  className="btn primary"
                  style={{ marginTop: 4, width: '100%' }}
                  onClick={sharePlanningOutline}
                  disabled={
                    planningBusy ||
                    (!planningFocus.trim() && !planningStructure.trim() && !planningKeyPoints.trim())
                  }
                >
                  {planningBusy ? 'Sharing plan…' : 'Share plan with room'}
                </button>

                <div style={{ opacity: 0.7, fontSize: 11, marginTop: 4 }}>
                  Tip: After sharing, ask Asema in chat, “Use our Planning Outline for the rough
                  draft” when you move to the next stage.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Stage-specific quick actions */}
        <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          {stage === 'DISCOVERY' && (
            <>
              <button className="btn" onClick={markReadyToVote} disabled={hasMarkedReady}>
                {hasMarkedReady ? 'Waiting for room…' : "I'm ready to vote"}
              </button>

              {voteOpen && (
                <button className="btn" onClick={() => setVoteModalOpen(true)} disabled={hasVoted}>
                  {hasVoted ? 'You voted' : 'Vote Now'}
                </button>
              )}

              {isPresenter && (
                <>
                  <button className="btn" onClick={startVote}>
                    Force Start
                  </button>
                  <button className="btn" onClick={closeVote} disabled={!voteOpen}>
                    Force Close
                  </button>
                </>
              )}

              <div className="hud-pill" style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                <span>
                  Ready: <b>{voteReadyCount}</b> / <b>{displayVoteSeats || '—'}</b>
                </span>
                <span>•</span>
                <span>
                  Voted: <b>{voteSubmittedCount}</b> / <b>{displayVoteSeats || '—'}</b>
                </span>
              </div>
            </>
          )}

          {stage === 'PLANNING' && (
            <div className="hud-pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              🧩 Use the Planning Board on the right to lock a focus, structure, and 3 key beats.
              Once you share the plan, use it as the blueprint for the rough draft.
            </div>
          )}

          {stage === 'ROUGH_DRAFT' && (
            <button className="btn" onClick={() => generateRough()} disabled={draftBusy}>
              {draftBusy
                ? 'Generating Rough Draft…'
                : hasDraft
                ? 'Regenerate Rough Draft'
                : 'Generate Rough Draft'}
            </button>
          )}

          {stage === 'FINAL' && (
            <>
              <div className="hud-pill" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  ✅ Ready: <b>{readyCount}</b> / <b>{totalSeats || '—'}</b>
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 999,
                    background: 'rgba(51,65,85,0.9)',
                    overflow: 'hidden',
                    minWidth: 80,
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, readyPct)}%`,
                      height: '100%',
                      background: 'linear-gradient(to right, #22c55e, #a3e635)',
                      transition: 'width 0.25s ease-out',
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, opacity: 0.8 }}>
                  Type “done” or “submit” to bump the meter — session closes when everyone is
                  ready.
                </span>
              </div>
              {cerGate && cerGate.ok === false ? (
                <div
                  className="hud-pill"
                  style={{
                    borderColor: 'rgba(244,200,76,.5)',
                    background: 'rgba(244,200,76,.14)',
                    color: '#5b3a11',
                  }}
                >
                  Final output gate is active. Complete {describeCerMissing(cerGate.missing)} in the
                  Evidence Board first. Citations found: <b>{Number(cerGate.citations || 0)}</b>.
                </div>
              ) : null}
            </>
          )}

          {isPresenter && stage !== 'CLOSED' ? (
            <div className="hud-pill" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><b>Facilitator interventions:</b></span>
              <button
                type="button"
                className="btn ghost"
                onClick={() => runRoomIntervention('extend_time')}
                disabled={interventionBusy === 'extend_time'}
              >
                {interventionBusy === 'extend_time' ? 'Extending…' : '+2 min'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => runRoomIntervention('unlock_input')}
                disabled={interventionBusy === 'unlock_input'}
              >
                {interventionBusy === 'unlock_input' ? 'Unlocking…' : 'Unlock Input'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => runRoomIntervention('nudge_quiet')}
                disabled={interventionBusy === 'nudge_quiet'}
              >
                {interventionBusy === 'nudge_quiet' ? 'Sending…' : 'Nudge Quiet Voices'}
              </button>
              {stage === 'DISCOVERY' ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => runRoomIntervention('reopen_voting')}
                  disabled={interventionBusy === 'reopen_voting'}
                >
                  {interventionBusy === 'reopen_voting' ? 'Reopening…' : 'Reopen Voting'}
                </button>
              ) : null}
            </div>
          ) : null}

          {stage === 'CLOSED' && (
            <div className="hud-pill" style={{ marginLeft: 'auto' }}>
              Session complete — scroll to review and copy your abstract.
            </div>
          )}

          {roomMeta.inputLocked && stage !== 'CLOSED' && (
            <div className="hud-pill" style={{ marginLeft: 'auto' }}>
              Input Locked
            </div>
          )}
        </div>
      </div>

      <div className="mobile-action-bar">
        <button type="button" onClick={() => inputRef.current?.focus()}>
          Message
        </button>
        {stage === 'DISCOVERY' ? (
          <button type="button" onClick={markReadyToVote} disabled={hasMarkedReady}>
            {hasMarkedReady ? 'Waiting' : 'Ready'}
          </button>
        ) : null}
        {stage === 'DISCOVERY' && voteOpen ? (
          <button type="button" onClick={() => setVoteModalOpen(true)} disabled={hasVoted}>
            {hasVoted ? 'Voted' : 'Vote'}
          </button>
        ) : null}
        {stage === 'PLANNING' ? (
          <button
            type="button"
            onClick={sharePlanningOutline}
            disabled={
              planningBusy ||
              (!planningFocus.trim() && !planningStructure.trim() && !planningKeyPoints.trim())
            }
          >
            {planningBusy ? 'Sharing…' : 'Share Plan'}
          </button>
        ) : null}
        {stage === 'ROUGH_DRAFT' ? (
          <button type="button" onClick={() => generateRough()} disabled={draftBusy}>
            {draftBusy ? 'Drafting…' : 'Draft'}
          </button>
        ) : null}
        <button type="button" onClick={() => setReplayOpen(true)}>
          Replay
        </button>
        <button
          type="button"
          onClick={() => setViewMode((prev) => (prev === 'simple' ? 'expanded' : 'simple'))}
        >
          {viewMode === 'simple' ? 'Full' : 'Focus'}
        </button>
        {offlineQueueDepth > 0 ? (
          <button type="button" onClick={() => void flushOfflineQueue()} disabled={offlineFlushBusy}>
            {offlineFlushBusy ? 'Retrying' : `Queue ${offlineQueueDepth}`}
          </button>
        ) : null}
      </div>

      {/* Voting Modal (Discovery) */}
      {stage === 'DISCOVERY' && voteOpen && voteModalOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            className="rounded-2xl"
            style={{
              width: 520,
              maxWidth: '92vw',
              background: 'rgba(20,20,24,0.6)',
              border: '1px solid rgba(255,255,255,0.12)',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
              color: 'white',
              padding: 18,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div className="gold-dot" />
              <div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>Vote for today’s topic</div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>
                  Pick one number. Your vote is counted once. Voting will close automatically when
                  everyone in your room has voted.
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginTop: 8 }}>
              {(voteOptions.length
                ? voteOptions
                : [
                    { num: 1, label: 'Law Enforcement Profiling' },
                    { num: 2, label: 'Food Deserts' },
                    { num: 3, label: 'Red Lining' },
                    { num: 4, label: 'Homelessness' },
                    { num: 5, label: 'Wealth Gap' },
                  ]
              ).map((opt) => (
                <button
                  key={opt.num}
                  className="btn"
                  disabled={hasVoted}
                  onClick={() => submitVote(opt.num)}
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <span>
                    <b>{opt.num}.</b> {opt.label}
                  </span>
                  {hasVoted &&
                    voteCounts &&
                    typeof voteCounts[opt.num] === 'number' && (
                      <span className="hud-pill">{voteCounts[opt.num]} votes</span>
                    )}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {hasVoted ? 'You have voted.' : 'You have not voted yet.'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setVoteModalOpen(false)}>
                  Close
                </button>
                {isPresenter && (
                  <button className="btn primary" onClick={closeVote}>
                    Force Close & Lock Topic
                  </button>
                )}
              </div>
            </div>

            {(voteTopic || roomMeta.topic) && (
              <div className="hud-pill" style={{ marginTop: 10 }}>
                Selected Topic: <b>{roomMeta.topic || voteTopic}</b>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Stage Legend pill (bottom-left) */}
      {viewMode !== 'simple' && (
        <StageLegendPill stage={stage} open={legendOpen} onToggle={() => setLegendOpen((o) => !o)} />
      )}

      <ReplayModal
        open={replayOpen}
        loading={replayLoading}
        entries={replayEntries}
        cursor={replayCursor}
        onCursorChange={setReplayCursor}
        onClose={() => setReplayOpen(false)}
      />
    </>
  );
}
