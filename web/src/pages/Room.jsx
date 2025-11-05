import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { awsHeaders } from '../lib/awsAuth';
import TopBanner from '../components/TopBanner.jsx';
import CountdownRing from '../components/CountdownRing.jsx';
import ChatMessage from '../components/ChatMessage.jsx';
import IdeaSidebar from '../components/IdeaSidebar.jsx';
import { useRoomVoting } from '../hooks/useRoomVoting';

// Stages/order + default durations (seconds)
const ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL'];
const TOTAL_BY_STAGE = {
  LOBBY: 60,
  DISCOVERY: 600,
  IDEA_DUMP: 180,
  PLANNING: 600,
  ROUGH_DRAFT: 240,
  EDITING: 600,
  FINAL: 360,
};

export default function Room() {
  const { roomId } = useParams();

  // Room meta + stage state
  const [stage, setStage] = useState('LOBBY');
  const [stageEndsAt, setStageEndsAt] = useState(null);
  const [roomMeta, setRoomMeta] = useState({ siteId: '', index: 1, inputLocked: false, ideaSummary: '' });

  // Messages scoped by current stage
  const [messages, setMessages] = useState([]);

  // Compose state
  const [text, setText] = useState('');
  const [activePersona, setActivePersona] = useState(0);

  // Personas from login
  const personas = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('personas') || '["🙂"]'); }
    catch { return ['🙂']; }
  }, []);
  const mode = sessionStorage.getItem('mode') || 'individual';

  // Voting (during DISCOVERY)
  const { status: voteStatus, loading: voteLoading, startVoting, submitVote, closeVoting, refresh: refreshVote } =
    useRoomVoting(roomId);

  // Live countdown tick + autoscroll refs
  const scrollRef = useRef(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // One-time flags to prevent duplicate calls
  const [welcomeSent, setWelcomeSent] = useState(false);
  const [roughGenerated, setRoughGenerated] = useState(false);
  const [roughQsAsked, setRoughQsAsked] = useState(false);

  // -------- Poll helpers (no websockets) --------
  const fetchRoom = useCallback(async () => {
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}`, { ...(await awsHeaders()) });
      if (!res.ok) return;
      const j = await res.json();
      setStage(j.stage || 'LOBBY');
      setStageEndsAt(j.stageEndsAt ? new Date(j.stageEndsAt) : null);
      setRoomMeta(m => ({
        ...m,
        siteId: j.siteId || roomId.split('-')[0],
        index: j.index || 1,
        inputLocked: !!j.inputLocked,
        ideaSummary: j.ideaSummary || m.ideaSummary || ''
      }));
    } catch {}
  }, [roomId]);

  const fetchMessages = useCallback(async (phase) => {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/rooms/${roomId}/messages?phase=${encodeURIComponent(phase)}`,
        { ...(await awsHeaders()) }
      );
      if (!res.ok) return;
      const j = await res.json();
      setMessages(j.messages || []);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch {}
  }, [roomId]);

  // Poll room + messages every 2s
  useEffect(() => {
    fetchRoom();
    fetchMessages(stage);
    const t1 = setInterval(fetchRoom, 2000);
    const t2 = setInterval(() => fetchMessages(stage), 2000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchRoom, fetchMessages, stage]);

  // Tick for timer ring
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Auto-greet when DISCOVERY begins (once)
  useEffect(() => {
    (async () => {
      if (stage === 'DISCOVERY' && !welcomeSent) {
        setWelcomeSent(true);
        try {
          await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/welcome`, {
            method: 'POST',
            ...(await awsHeaders()),
          });
        } catch {}
      }
    })();
  }, [stage, welcomeSent, roomId]);

  // ROUGH_DRAFT sequence:
  // 1) Generate rough (exactly 250 words) and show it first.
  // 2) Then ask 2–3 guiding questions and UNLOCK input.
  useEffect(() => {
    (async () => {
      if (stage === 'ROUGH_DRAFT') {
        if (!roughGenerated) {
          setRoughGenerated(true);
          try {
            await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/draft/generate`, {
              method: 'POST',
              ...(await awsHeaders()),
              body: JSON.stringify({ mode: 'draft' }) // server enforces 250 words
            });
            // refresh messages so rough appears
            await fetchMessages('ROUGH_DRAFT');
          } catch {}
        } else if (!roughQsAsked) {
          setRoughQsAsked(true);
          try {
            await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/draft/generate`, {
              method: 'POST',
              ...(await awsHeaders()),
              body: JSON.stringify({ mode: 'ask' })
            });
          } catch {}
        }
      } else {
        // reset flags when leaving stage
        setRoughGenerated(false);
        setRoughQsAsked(false);
      }
    })();
  }, [stage, roomId, roughGenerated, roughQsAsked, fetchMessages]);

  // Start Final: Asema posts rough + instructions (server toggles locks appropriately)
  useEffect(() => {
    (async () => {
      if (stage === 'FINAL') {
        try {
          await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/final/start`, {
            method: 'POST',
            ...(await awsHeaders()),
          });
          await fetchMessages('FINAL');
        } catch {}
      }
    })();
  }, [stage, roomId, fetchMessages]);

  // -------- Actions --------
  async function send() {
    const t = text.trim();
    if (!t) return;

    // respect input lock (e.g., during server-locks, except FINAL where edits are allowed)
    const allowedStages = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','EDITING','FINAL'];
    const canType = (!roomMeta.inputLocked || stage === 'FINAL') && allowedStages.includes(stage);
    if (!canType) return;

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...(await awsHeaders()),
        body: JSON.stringify({
          text: t,
          phase: stage,
          personaIndex: activePersona
        })
      });
      if (!res.ok) {
        const j = await res.json().catch(()=>({}));
        alert(j.error || 'Failed to send');
        return;
      }
      setText('');
    } catch {}
    await fetchMessages(stage);

    // If the user calls Asema by name → ask route (on-topic-only)
    if (/(^|\s)asema[\s,!?]/i.test(t) || /^asema$/i.test(t)) {
      try {
        await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/ask`, {
          method: 'POST',
          ...(await awsHeaders()),
          body: JSON.stringify({ text: t }),
        });
      } catch {}
    }

    // During idea phases → trigger debounced summarizer (saves tokens)
    if (stage === 'DISCOVERY' || stage === 'IDEA_DUMP') {
      try {
        await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          ...(await awsHeaders()),
        });
      } catch {}
    }

    // In FINAL: if someone types "done" or "submit", mark ready
    if (stage === 'FINAL' && /^(done|submit)\b/i.test(t)) {
      try {
        await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/final/ready`, {
          method: 'POST',
          ...(await awsHeaders()),
        });
      } catch {}
    }
  }

  // Presenter/manual finalize button (for safety)
  async function finalize() {
    try {
      await fetch(`${import.meta.env.VITE_API_URL}/rooms/${roomId}/final/complete`, {
        method: 'POST',
        ...(await awsHeaders()),
      });
    } catch {}
  }

  // Stage/time UI helpers
  const total = TOTAL_BY_STAGE[stage] || 1;
  const secsLeft = stageEndsAt ? Math.max(0, Math.floor((stageEndsAt.getTime() - nowTick) / 1000)) : 0;

  // Input lock: allow typing unless server locked (FINAL always allowed for edits)
  const canType = (!roomMeta.inputLocked || stage === 'FINAL')
    && ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','EDITING','FINAL'].includes(stage);

  // Voting UI (only in DISCOVERY)
  const showVoting = stage === 'DISCOVERY' && (voteStatus.votingOpen || (voteStatus.options?.length || 0) > 0);
  const canStartVoting = stage === 'DISCOVERY' && !voteStatus.votingOpen && (voteStatus.options?.length || 0) === 0; // presenter usually triggers

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="room-wrap">
        <TopBanner siteId={roomMeta.siteId} roomIndex={roomMeta.index} stage={stage} />

        <div style={{ display: 'grid', gridTemplateColumns: (stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') ? '1fr 320px' : '1fr', gap: 14 }}>
          {/* Chat card */}
          <div className="chat">
            {/* Header */}
            <div className="chat-head">
              <span className="stage-badge">{stage}</span>
              <div className="ribbon" style={{ marginLeft: 10 }}>
                {ORDER.map((s) => (
                  <span key={s} className={s === stage ? 'on' : ''}>{s}</span>
                ))}
              </div>

              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                <CountdownRing secondsLeft={secsLeft} secondsTotal={total} />
                <div className="persona-choices" title="Choose persona">
                  {personas.map((p, i) => (
                    <button
                      key={i}
                      className={i === activePersona ? 'active' : ''}
                      onClick={() => setActivePersona(i)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Messages (filtered to current stage = "clear chat" per phase) */}
            <div ref={scrollRef} className="chat-body">
              {messages.map((m) => (
                <ChatMessage
                  key={m.id || `${m.createdAt}-${m.text.substring(0,10)}`}
                  kind={m.authorType === 'asema' ? 'asema' : 'user'}
                  who={m.authorType === 'asema' ? '🤖' : (personas[m.personaIndex] || personas[0])}
                  text={m.text}
                />
              ))}
            </div>

            {/* Voting UI (Discovery) */}
            {showVoting && (
              <div className="voting-panel">
                <div className="voting-title">Topic Voting</div>
                <div className="voting-sub">
                  Choose the number for your preferred topic. One vote per participant.
                </div>
                <div className="voting-options">
                  {(voteStatus.options || []).map((opt, idx) => (
                    <button
                      key={idx}
                      className="vote-btn"
                      disabled={voteLoading || !voteStatus.votingOpen}
                      onClick={() => submitVote(idx + 1)}
                    >
                      <span className="vote-num">{idx + 1}</span>
                      <span className="vote-text">{opt}</span>
                    </button>
                  ))}
                </div>

                <div className="voting-stats">
                  <div>Votes received: <b>{voteStatus.votesReceived}</b></div>
                  {!!(voteStatus.counts || []).length && (
                    <div className="vote-counts">
                      {(voteStatus.counts || []).map((c, i) => (
                        <span key={i} className="count-pill">{i + 1}: {c}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Close voting appears if server marks "votingOpen" and you're a presenter in practice;
                    we don't check role client-side—leave it available for testing. */}
                {voteStatus.votingOpen && (
                  <div className="row mt8">
                    <button className="btn" onClick={closeVoting} disabled={voteLoading}>
                      Close & Lock Topic
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Input dock */}
            <div className="chat-input">
              <div className="persona-pill">
                Speaking as <b style={{ fontSize: 16 }}>{personas[activePersona] || personas[0]}</b>
              </div>

              <div className="input-pill" style={{ opacity: canType ? 1 : .5 }}>
                <input
                  placeholder={canType ? 'Type your message… (say "Asema, ..." to ask her)' : 'Input locked in this phase'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => (e.key === 'Enter' && canType ? send() : null)}
                  disabled={!canType}
                />
              </div>
              <button className="btn primary" onClick={send} disabled={!canType}>Send</button>
            </div>
          </div>

          {/* Idea Sidebar (visible in DISCOVERY / IDEA_DUMP / PLANNING) */}
          {(stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') && (
            <IdeaSidebar summary={roomMeta.ideaSummary || ''} />
          )}
        </div>

        {/* Stage-specific quick actions */}
        <div className="row mt12">
          {stage === 'FINAL' && (
            <button className="btn primary" onClick={finalize}>Finalize</button>
          )}
          {/* Input lock indicator */}
          {roomMeta.inputLocked && stage !== 'FINAL' && <div className="hud-pill" style={{ marginLeft: 'auto' }}>Input Locked</div>}
        </div>
      </div>
    </>
  );
}
