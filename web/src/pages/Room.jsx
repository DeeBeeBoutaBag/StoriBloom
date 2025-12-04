// web/src/pages/Room.jsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE } from '../api';

import TopBanner from '../components/TopBanner.jsx';
import CountdownRing from '../components/CountdownRing.jsx';
import ChatMessage from '../components/ChatMessage.jsx';
import IdeaSidebar from '../components/IdeaSidebar.jsx';

const ORDER = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED', // NEW: closed stage
];

const TOTAL_BY_STAGE = {
  LOBBY: 60,
  DISCOVERY: 600,
  IDEA_DUMP: 180,
  PLANNING: 600,
  ROUGH_DRAFT: 240,
  EDITING: 600,
  FINAL: 360,
  CLOSED: 0,
};

// Small helper for mm:ss display in status strip
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// Quick legend text for each stage
const STAGE_DESCRIPTIONS = {
  LOBBY: 'Everyone lands, tests chat, and gets oriented.',
  DISCOVERY: 'Share first thoughts and stories about the topic.',
  IDEA_DUMP: 'Rapid-fire ideas; volume over perfection.',
  PLANNING: 'Group chooses a focus and rough structure.',
  ROUGH_DRAFT: 'Asema drafts a first version from your ideas.',
  EDITING: 'Team revises, sharpens, and corrects the draft.',
  FINAL: 'Final touches and “we’re done” check-in.',
  CLOSED: 'Session is complete, scroll and copy your abstract.',
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
        <span className="stage-legend-label">
          {niceStage}
        </span>
        <span className="stage-legend-help">?</span>
      </button>

      {open && (
        <div className="stage-legend-panel" role="dialog" aria-label="Stage legend">
          <div className="stage-legend-header">
            <span className="stage-legend-title">Stage Legend</span>
            <button
              type="button"
              className="stage-legend-close"
              onClick={onToggle}
            >
              ✕
            </button>
          </div>
          <ul className="stage-legend-list">
            {ORDER.map((s) => (
              <li key={s}>
                <span className="stage-legend-stage">
                  {s.replace('_', ' ')}
                </span>
                <span className="stage-legend-desc">
                  {STAGE_DESCRIPTIONS[s] || ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="stage-legend-footer">
            Tip: this panel is for facilitators if anyone asks,
            “What are we supposed to be doing right now?”
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
  const [nowTick, setNowTick] = useState(Date.now());
  const [sentWelcome, setSentWelcome] = useState(false);

  // Voting (frontend glue; backend handles real logic)
  const [voteOpen, setVoteOpen] = useState(false);
  const [voteOptions, setVoteOptions] = useState([]);
  const [hasVoted, setHasVoted] = useState(false);
  const [voteClosesAt, setVoteClosesAt] = useState(null);
  const [voteCounts, setVoteCounts] = useState(null);
  const [voteTopic, setVoteTopic] = useState('');
  const votePollRef = useRef(null);

  // Rough draft local flags
  const [hasDraft, setHasDraft] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false); // lock while generating

  // Final stage: show button busy while finalizing
  const [finalBusy, setFinalBusy] = useState(false);

  // Legend toggle
  const [legendOpen, setLegendOpen] = useState(false);

  // --- Auth bootstrap ---
  useEffect(() => {
    ensureGuest().catch((e) => {
      console.error('[Room] ensureGuest failed', e);
    });
  }, []);

  // --- Live countdown tick ---
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // --- Poll room state + messages ---
  useEffect(() => {
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
        });
        setIdeaSummary(j.ideaSummary || '');
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
    const id = setInterval(() => {
      loadState();
      loadMessages();
    }, 1500);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [roomId]);

  // --- Auto-greet when DISCOVERY begins (once per mount) ---
  useEffect(() => {
    (async () => {
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
  }, [stage, sentWelcome, roomId]);

  // --- Voting helpers (simple glue to backend) ---
  async function fetchVoteStatus() {
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote`, {
        method: 'GET',
        ...(await authHeaders()),
      });
      if (!res.ok) return;
      const j = await res.json();
      setVoteOpen(!!j.votingOpen && stage === 'DISCOVERY');
      setVoteOptions(Array.isArray(j.options) ? j.options : []);
      setVoteCounts(j.counts || null);
      setVoteTopic(j.topic || '');
      if (!j.votingOpen) {
        setHasVoted(false);
        setVoteClosesAt(null);
      } else if (j.voteClosesAt) {
        setVoteClosesAt(new Date(j.voteClosesAt));
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

  useEffect(() => {
    if (stage !== 'DISCOVERY') {
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
      setVoteOpen(false);
      return;
    }
    fetchVoteStatus();
    votePollRef.current = setInterval(fetchVoteStatus, 2000);
    return () => {
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, roomId]);

  // --- Rough Draft: Generate / Regenerate via backend ---
  async function generateRough(requestMode) {
    if (draftBusy) return;
    setDraftBusy(true);
    try {
      const mode = requestMode || (hasDraft ? 'regen' : undefined);

      const opts = {
        method: 'POST',
        ...(await authHeaders()),
      };
      if (mode) {
        opts.body = JSON.stringify({ mode });
      }

      const res = await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, opts);
      if (!res.ok) {
        console.error(
          '[Room] draft/generate failed',
          await res.text().catch(() => '')
        );
        return;
      }
      setHasDraft(true);
      // Messages poll loop will pick up Asema's draft message automatically
    } catch (e) {
      console.error('[Room] generateRough error', e);
    } finally {
      setDraftBusy(false);
    }
  }

  // --- Finalize button (presenter/manual complete) ---
  async function finalize() {
    if (finalBusy) return;
    setFinalBusy(true);
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/final/complete`, {
        method: 'POST',
        ...(await authHeaders()),
      });
      // Poll loop will pick up stage change to CLOSED + closing messages
    } catch (e) {
      console.error('[Room] finalize error', e);
    } finally {
      setFinalBusy(false);
    }
  }

  // --- Send message (user) ---
  async function send() {
    const t = text.trim();
    if (!t) return;

    // If draft is generating in ROUGH_DRAFT, block sends to avoid chaos
    if (stage === 'ROUGH_DRAFT' && draftBusy) return;

    // No chat once session is closed
    if (stage === 'CLOSED') return;

    // Respect input lock except FINAL and ROUGH_DRAFT (kept open for collab)
    if (roomMeta.inputLocked && stage !== 'FINAL' && stage !== 'ROUGH_DRAFT') return;

    const emoji = personas[activePersona] || personas[0];

    // Detect "Asema, generate rough draft" style commands
    const lower = t.toLowerCase();
    const addressedAsema =
      /(^|\s)asema[\s,!?]/i.test(t) || /^asema\b/i.test(t);
    const wantsRoughDraft =
      /rough\s+draft/i.test(lower) ||
      /(generate|write|make|create|spin up).*(draft|abstract)/i.test(lower);

    try {
      // 1) Save the user's message
      await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({
          text: t,
          phase: stage,
          personaIndex: activePersona,
          emoji, // include chosen emoji so others see correct identity
        }),
      });
    } catch (e) {
      console.error('[Room] send error', e);
    }
    setText('');

    // 2) If they addressed Asema…
    if (addressedAsema) {
      // In ROUGH_DRAFT: "Asema, generate rough draft" → trigger same as button
      if (stage === 'ROUGH_DRAFT' && wantsRoughDraft) {
        // Fire and forget; UI shows busy state
        generateRough('ask');
      } else {
        // Normal /ask flow
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
            method: 'POST',
            ...(await authHeaders()),
            body: JSON.stringify({ text: t }),
          });
        } catch (e) {
          console.error('[Room] ask error', e);
        }
      }
    }

    // 3) Idea summary trigger (server throttles)
    if (stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          ...(await authHeaders()),
        });
      } catch (e) {
        console.warn('[Room] ideas/trigger error', e);
      }
    }

    // 4) In FINAL: "done" / "submit" marks ready (backend should implement /final/ready)
    if (stage === 'FINAL' && /^(done|submit)\b/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/final/ready`, {
          method: 'POST',
          ...(await authHeaders()),
        });
      } catch (e) {
        console.warn('[Room] final/ready error', e);
      }
    }
  }

  // --- Derived UI state ---
  const total = TOTAL_BY_STAGE[stage] || 1;
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

  // Input allowed:
  const canType =
    stage !== 'CLOSED' &&
    (!roomMeta.inputLocked ||
      stage === 'FINAL' ||
      stage === 'ROUGH_DRAFT') &&
    !draftingHold;

  let inputPlaceholder = 'Type your message… (say "Asema, ..." to ask her)';
  if (draftingHold) {
    inputPlaceholder = 'Asema is generating your rough draft…';
  } else if (!canType && !draftingHold) {
    inputPlaceholder =
      stage === 'CLOSED'
        ? 'Session is closed — scroll up and copy your abstract.'
        : 'Input locked in this phase';
  }

  // When CLOSED, show FINAL-phase transcript (closing message + abstract)
  const effectivePhase = stage === 'CLOSED' ? 'FINAL' : stage;

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="room-wrap">
        <TopBanner
          siteId={roomMeta.siteId}
          roomIndex={roomMeta.index}
          stage={stage}
        />

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
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              stage === 'DISCOVERY' ||
              stage === 'IDEA_DUMP' ||
              stage === 'PLANNING'
                ? '1fr 320px'
                : '1fr',
            gap: 14,
          }}
        >
          {/* Chat card */}
          <div className="chat">
            {/* Header */}
            <div className="chat-head">
              <span className="stage-badge">
                {stage === 'CLOSED' ? 'SESSION COMPLETE' : stage}
              </span>
              <div className="ribbon" style={{ marginLeft: 10 }}>
                {ORDER.map((s) => (
                  <span
                    key={s}
                    className={s === stage ? 'on' : ''}
                  >
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
                <CountdownRing
                  secondsLeft={secsLeft}
                  secondsTotal={total || 1}
                />
                <div
                  className="persona-choices"
                  title="Choose persona"
                >
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
              {messages
                .filter(
                  (m) => (m.phase || 'LOBBY') === effectivePhase
                )
                .map((m) => (
                  <ChatMessage
                    key={m.id}
                    kind={
                      m.authorType === 'asema'
                        ? 'asema'
                        : 'user'
                    }
                    who={
                      m.authorType === 'asema'
                        ? '🤖'
                        : (m.emoji ||
                           personas[m.personaIndex] ||
                           personas[0] ||
                           '🙂')
                    }
                    text={m.text}
                  />
                ))}
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
                    background:
                      'radial-gradient(circle at 30% 30%, #fffbeb, #facc15)',
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
                  <b style={{ fontSize: 16 }}>
                    Session closed — copy your abstract above.
                  </b>
                ) : (
                  <>
                    Speaking as{' '}
                    <b style={{ fontSize: 16 }}>
                      {personas[activePersona] || personas[0]}
                    </b>
                  </>
                )}
              </div>

              <div
                className="input-pill"
                style={{ opacity: canType ? 1 : 0.5 }}
              >
                <input
                  placeholder={inputPlaceholder}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && canType
                      ? send()
                      : null
                  }
                  disabled={!canType}
                />
              </div>
              <button
                className="btn primary"
                onClick={send}
                disabled={!canType || !text.trim()}
              >
                Send
              </button>
            </div>
          </div>

          {/* Idea Sidebar (Discovery / Idea Dump / Planning) */}
          {(stage === 'DISCOVERY' ||
            stage === 'IDEA_DUMP' ||
            stage === 'PLANNING') && (
            <IdeaSidebar summary={ideaSummary} />
          )}
        </div>

        {/* Stage-specific quick actions */}
        <div
          className="row mt12"
          style={{ gap: 8, alignItems: 'center' }}
        >
          {stage === 'DISCOVERY' && (
            <>
              {isPresenter ? (
                <>
                  <button
                    className="btn"
                    onClick={startVote}
                  >
                    Start Vote
                  </button>
                  <button
                    className="btn"
                    onClick={closeVote}
                    disabled={!voteOpen}
                  >
                    Close Vote
                  </button>
                </>
              ) : (
                <button
                  className="btn"
                  onClick={() => setVoteOpen(true)}
                  disabled={!voteOpen}
                >
                  {voteOpen
                    ? 'Vote Now'
                    : 'Waiting for Vote'}
                </button>
              )}
              <div
                className="hud-pill"
                style={{ marginLeft: 'auto' }}
              >
                {roomMeta.topic
                  ? `Topic: ${roomMeta.topic}`
                  : voteTopic
                  ? `Topic: ${voteTopic}`
                  : 'No topic selected'}
              </div>
            </>
          )}

          {stage === 'ROUGH_DRAFT' && (
            <button
              className="btn"
              onClick={() => generateRough()}
              disabled={draftBusy}
            >
              {draftBusy
                ? 'Generating Rough Draft…'
                : hasDraft
                ? 'Regenerate Rough Draft'
                : 'Generate Rough Draft'}
            </button>
          )}

          {stage === 'FINAL' && (
            <button
              className="btn primary"
              onClick={finalize}
              disabled={finalBusy}
            >
              {finalBusy
                ? 'Finalizing Session…'
                : 'Finalize Session'}
            </button>
          )}

          {stage === 'CLOSED' && (
            <div
              className="hud-pill"
              style={{ marginLeft: 'auto' }}
            >
              Session complete — scroll to review and copy your abstract.
            </div>
          )}

          {roomMeta.inputLocked && stage !== 'CLOSED' && (
            <div
              className="hud-pill"
              style={{ marginLeft: 'auto' }}
            >
              Input Locked
            </div>
          )}
        </div>
      </div>

      {/* Voting Modal (Discovery) */}
      {stage === 'DISCOVERY' && voteOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => {}}
        >
          <div
            className="rounded-2xl"
            style={{
              width: 520,
              maxWidth: '92vw',
              background: 'rgba(20,20,24,0.6)',
              border:
                '1px solid rgba(255,255,255,0.12)',
              backdropFilter: 'blur(10px)',
              boxShadow:
                '0 16px 48px rgba(0,0,0,0.45)',
              color: 'white',
              padding: 18,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div className="gold-dot" />
              <div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 18,
                  }}
                >
                  Vote for today’s topic
                </div>
                <div
                  style={{
                    opacity: 0.75,
                    fontSize: 12,
                  }}
                >
                  Pick one number. Your vote is
                  counted once.
                  {voteClosesAt
                    ? ` Closes in ~${Math.max(
                        0,
                        Math.floor(
                          (voteClosesAt.getTime() -
                            Date.now()) /
                            1000
                        )
                      )}s`
                    : ''}
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: 8,
                marginTop: 8,
              }}
            >
              {(voteOptions.length
                ? voteOptions
                : [
                    {
                      num: 1,
                      label:
                        'Law Enforcement Profiling',
                    },
                    {
                      num: 2,
                      label: 'Food Deserts',
                    },
                    {
                      num: 3,
                      label: 'Red Lining',
                    },
                    {
                      num: 4,
                      label: 'Homelessness',
                    },
                    {
                      num: 5,
                      label: 'Wealth Gap',
                    },
                  ]
              ).map((opt) => (
                <button
                  key={opt.num}
                  className="btn"
                  disabled={hasVoted}
                  onClick={() =>
                    submitVote(opt.num)
                  }
                  style={{
                    display: 'flex',
                    justifyContent:
                      'space-between',
                  }}
                >
                  <span>
                    <b>{opt.num}.</b> {opt.label}
                  </span>
                  {hasVoted &&
                    voteCounts &&
                    typeof voteCounts[
                      opt.num
                    ] === 'number' && (
                      <span className="hud-pill">
                        {
                          voteCounts[
                            opt.num
                          ]
                        }{' '}
                        votes
                      </span>
                    )}
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent:
                  'space-between',
                marginTop: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.75,
                }}
              >
                {hasVoted
                  ? 'You have voted.'
                  : 'You have not voted yet.'}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                }}
              >
                {!isPresenter && (
                  <button
                    className="btn"
                    onClick={() =>
                      setVoteOpen(false)
                    }
                  >
                    Close
                  </button>
                )}
                {isPresenter && (
                  <button
                    className="btn primary"
                    onClick={closeVote}
                  >
                    Close & Lock Topic
                  </button>
                )}
              </div>
            </div>

            {(voteTopic || roomMeta.topic) && (
              <div
                className="hud-pill"
                style={{ marginTop: 10 }}
              >
                Selected Topic:{' '}
                <b>
                  {roomMeta.topic ||
                    voteTopic}
                </b>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Stage Legend pill (bottom-left) */}
      <StageLegendPill
        stage={stage}
        open={legendOpen}
        onToggle={() => setLegendOpen((o) => !o)}
      />
    </>
  );
}
