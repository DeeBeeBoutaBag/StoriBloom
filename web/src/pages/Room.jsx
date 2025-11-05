import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ensureGuest,
  bearer as bearerHeaders,
  getRoomState,
  getMessages,
  API_BASE,
} from '../api';

import TopBanner from '../components/TopBanner.jsx';
import CountdownRing from '../components/CountdownRing.jsx';
import ChatMessage from '../components/ChatMessage.jsx';
import IdeaSidebar from '../components/IdeaSidebar.jsx';

const ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL'];
const TOTAL_BY_STAGE = {
  LOBBY: 60, DISCOVERY: 600, IDEA_DUMP: 180, PLANNING: 600,
  ROUGH_DRAFT: 240, EDITING: 600, FINAL: 360,
};

const ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Redlining',
  'Homelessness',
  'Wealth Gap',
];

export default function Room() {
  const { roomId } = useParams();

  // Personas from login (device may be individual or pair)
  const personas = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('personas') || '["🙂"]'); }
    catch { return ['🙂']; }
  }, []);
  const mode = sessionStorage.getItem('mode') || 'individual';

  // Room state
  const [stage, setStage] = useState('LOBBY');
  const [stageEndsAt, setStageEndsAt] = useState(null);
  const [roomMeta, setRoomMeta] = useState({
    siteId: '', index: 1, inputLocked: false, topic: null,
  });

  // Messages + polling
  const [messages, setMessages] = useState([]);
  const [lastTs, setLastTs] = useState(0);

  // Idea sidebar
  const [ideaSummary, setIdeaSummary] = useState('');

  // Compose
  const [text, setText] = useState('');
  const [activePersona, setActivePersona] = useState(0);

  // Voting (DISCOVERY)
  const [voteStatus, setVoteStatus] = useState({
    open: false,
    options: ISSUES,
    total: 0,
    submitted: false,
    myChoice: null,
    tallies: null,
  });

  // UX timers, scroll
  const [nowTick, setNowTick] = useState(Date.now());
  const [sentWelcome, setSentWelcome] = useState(false);
  const [askedRoughQs, setAskedRoughQs] = useState(false);
  const scrollRef = useRef(null);

  // keep time moving
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // initial guest token + persona registration (optional)
  useEffect(() => {
    (async () => {
      await ensureGuest();
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/personas`, {
          method: 'POST',
          ...(await bearerHeaders()),
          body: JSON.stringify({ mode, personas }),
        });
      } catch { /* noop */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // poll room state every 2s
  useEffect(() => {
    let mounted = true;
    async function tickState() {
      try {
        const st = await getRoomState(roomId);
        if (!mounted) return;
        setStage(st.stage || 'LOBBY');
        setStageEndsAt(st.stageEndsAt ? new Date(st.stageEndsAt) : null);
        setRoomMeta({
          siteId: st.siteId || roomId.split('-')[0],
          index: st.index || 1,
          inputLocked: !!st.inputLocked,
          topic: st.topic || null,
        });
        setIdeaSummary(st.ideaSummary || '');

        // update voting HUD if present in state
        if (st.vote) {
          setVoteStatus(v => ({
            ...v,
            open: !!st.vote.open,
            options: st.vote.options || ISSUES,
            total: st.vote.total || 0,
            submitted: !!st.vote.submitted, // server can flag if this uid voted
            myChoice: st.vote.myChoice ?? v.myChoice,
            tallies: st.vote.tallies || null,
          }));
        }
      } catch { /* noop */ }
    }
    tickState();
    const id = setInterval(tickState, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId]);

  // poll messages every 2s (only new since lastTs)
  useEffect(() => {
    let mounted = true;
    async function tickMsgs() {
      try {
        const data = await getMessages(roomId, lastTs || 0, null);
        if (!mounted) return;
        if (Array.isArray(data.items) && data.items.length) {
          setMessages(prev => [...prev, ...data.items]);
          setLastTs(data.lastTs || Date.now());
          // autoscroll
          requestAnimationFrame(() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      } catch { /* noop */ }
    }
    tickMsgs();
    const id = setInterval(tickMsgs, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId, lastTs]);

  // greet when DISCOVERY begins (once)
  useEffect(() => {
    (async () => {
      if (stage === 'DISCOVERY' && !sentWelcome) {
        setSentWelcome(true);
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/welcome`, {
            method: 'POST',
            ...(await bearerHeaders()),
          });
        } catch { /* noop */ }
      }
    })();
  }, [stage, sentWelcome, roomId]);

  // ask guiding qs once in rough draft (server will *first* generate the draft)
  useEffect(() => {
    (async () => {
      if (stage === 'ROUGH_DRAFT' && !askedRoughQs) {
        setAskedRoughQs(true);
        try {
          // We call draft/generate with mode='draft' first so Asema posts the draft,
          // then prompt questions (mode='ask').
          await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
            method: 'POST',
            ...(await bearerHeaders()),
            body: JSON.stringify({ mode: 'draft' }),
          });
          await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
            method: 'POST',
            ...(await bearerHeaders()),
            body: JSON.stringify({ mode: 'ask' }),
          });
        } catch { /* noop */ }
      }
    })();
  }, [stage, askedRoughQs, roomId]);

  // voting HUD polling (only while in DISCOVERY)
  useEffect(() => {
    if (stage !== 'DISCOVERY') return;
    let mounted = true;

    const tickVote = async () => {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/vote`, await bearerHeaders());
        if (!res.ok) return;
        const j = await res.json();
        if (!mounted) return;
        setVoteStatus(v => ({
          ...v,
          open: !!j.open,
          options: j.options || v.options,
          total: j.total ?? v.total,
          submitted: !!j.submitted,
          myChoice: j.myChoice ?? v.myChoice,
          tallies: j.tallies || v.tallies,
        }));
      } catch { /* noop */ }
    };

    tickVote();
    const id = setInterval(tickVote, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId, stage]);

  async function send() {
    const t = text.trim();
    if (!t) return;
    const canType = !roomMeta.inputLocked && ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','EDITING','FINAL'].includes(stage);
    if (!canType) return;

    try {
      await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        ...(await bearerHeaders()),
        body: JSON.stringify({
          personaIndex: activePersona,
          phase: stage,
          text: t,
        }),
      });
    } catch { /* noop */ }
    setText('');

    // If user calls Asema by name, ask
    if (/(^|\s)asema[\s,!?]/i.test(t) || /^asema$/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
          method: 'POST',
          ...(await bearerHeaders()),
          body: JSON.stringify({ text: t }),
        });
      } catch { /* noop */ }
    }

    // Debounced idea summary trigger
    if (stage === 'DISCOVERY' || stage === 'IDEA_DUMP') {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          ...(await bearerHeaders()),
        });
      } catch { /* noop */ }
    }

    // “done/submit” in FINAL
    if (stage === 'FINAL' && /^(done|submit)\b/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/final/ready`, {
          method: 'POST',
          ...(await bearerHeaders()),
        });
      } catch { /* noop */ }
    }
  }

  async function finalize() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/final/complete`, {
        method: 'POST',
        ...(await bearerHeaders()),
      });
    } catch { /* noop */ }
  }

  // Voting actions (client)
  async function castVote(idx) {
    if (!voteStatus.open || voteStatus.submitted) return;
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/submit`, {
        method: 'POST',
        ...(await bearerHeaders()),
        body: JSON.stringify({ choice: idx + 1 }),
      });
      setVoteStatus(s => ({ ...s, submitted: true, myChoice: idx + 1 }));
    } catch { /* noop */ }
  }

  const total = TOTAL_BY_STAGE[stage] || 1;
  const secsLeft = stageEndsAt ? Math.max(0, Math.floor((stageEndsAt.getTime() - nowTick) / 1000)) : 0;
  const canType = !roomMeta.inputLocked && ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','EDITING','FINAL'].includes(stage);

  return (
    <>
      <div className="heatmap-bg" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="room-wrap">
        <TopBanner siteId={roomMeta.siteId} roomIndex={roomMeta.index} stage={stage} topic={roomMeta.topic} />

        <div style={{ display: 'grid', gridTemplateColumns: (stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') ? '1fr 320px' : '1fr', gap: 14 }}>
          {/* Chat card */}
          <div className="chat">
            <div className="chat-head">
              <span className="stage-badge">{stage}</span>
              {roomMeta.topic && <span className="topic-tag">Topic: {roomMeta.topic}</span>}
              <div className="ribbon" style={{ marginLeft: 10 }}>
                {ORDER.map((s) => (<span key={s} className={s===stage?'on':''}>{s}</span>))}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                <CountdownRing secondsLeft={secsLeft} secondsTotal={total} />
                <div className="persona-choices" title="Choose persona">
                  {personas.map((p, i) => (
                    <button key={i} className={i===activePersona?'active':''} onClick={() => setActivePersona(i)}>{p}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Messages filtered to current stage */}
            <div ref={scrollRef} className="chat-body">
              {messages
                .filter((m) => (m.phase || 'LOBBY') === stage)
                .map((m) => (
                  <ChatMessage
                    key={m.id || `${m.ts}-${m.personaIndex||0}`}
                    kind={m.authorType === 'asema' ? 'asema' : 'user'}
                    who={m.authorType === 'asema' ? '🤖' : (personas[m.personaIndex] || personas[0])}
                    text={m.text}
                  />
                ))}
            </div>

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

            {/* Discovery: voting block */}
            {stage === 'DISCOVERY' && (
              <div className="vote-panel">
                <div className="vote-head">
                  <div className="label">Voting</div>
                  <div className={`badge ${voteStatus.open ? 'on' : ''}`}>{voteStatus.open ? 'Open' : 'Closed'}</div>
                </div>

                {!voteStatus.open && !roomMeta.topic && (
                  <div className="muted">Waiting for presenter/Asema to open voting…</div>
                )}

                {voteStatus.open && (
                  <div className="vote-options">
                    {voteStatus.options.map((opt, i) => (
                      <button
                        key={i}
                        className={`vote-btn ${voteStatus.myChoice === (i+1) ? 'chosen' : ''}`}
                        disabled={voteStatus.submitted}
                        onClick={() => castVote(i)}
                        title={`Vote #${i+1}`}
                      >
                        <span className="num">{i + 1}</span>
                        <span className="txt">{opt}</span>
                      </button>
                    ))}
                  </div>
                )}

                {voteStatus.submitted && voteStatus.open && (
                  <div className="muted small">
                    Your vote was recorded. Awaiting others…
                  </div>
                )}

                {!voteStatus.open && roomMeta.topic && (
                  <div className="muted">
                    Topic locked: <b>{roomMeta.topic}</b>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Idea Sidebar */}
          {(stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') && (
            <IdeaSidebar summary={ideaSummary} />
          )}
        </div>

        {/* Stage quick actions */}
        <div className="row mt12">
          {stage === 'FINAL' && (
            <button className="btn primary" onClick={finalize}>Finalize</button>
          )}
          {roomMeta.inputLocked && <div className="hud-pill" style={{ marginLeft: 'auto' }}>Input Locked</div>}
        </div>
      </div>
    </>
  );
}
