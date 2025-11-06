// web/src/pages/Room.jsx (Firestore-free)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE } from '../api';

import TopBanner from '../components/TopBanner.jsx';
import CountdownRing from '../components/CountdownRing.jsx';
import ChatMessage from '../components/ChatMessage.jsx';
import IdeaSidebar from '../components/IdeaSidebar.jsx';

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

  const role = useMemo(() => sessionStorage.getItem('role') || 'PARTICIPANT', []);
  const isPresenter = role === 'PRESENTER';

  const [stage, setStage] = useState('LOBBY');
  const [stageEndsAt, setStageEndsAt] = useState(null);
  const [roomMeta, setRoomMeta] = useState({ siteId: '', index: 1, inputLocked: false, topic: '' });

  const [messages, setMessages] = useState([]);
  const [ideaSummary, setIdeaSummary] = useState('');

  const [text, setText] = useState('');
  const [activePersona, setActivePersona] = useState(0);

  const personas = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('personas') || '["🙂"]'); }
    catch { return ['🙂']; }
  }, []);
  const mode = sessionStorage.getItem('mode') || 'individual';

  const scrollRef = useRef(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sentWelcome, setSentWelcome] = useState(false);

  // Voting state (talks to API voting routes)
  const [voteOpen, setVoteOpen] = useState(false);
  const [voteOptions, setVoteOptions] = useState([]);
  const [hasVoted, setHasVoted] = useState(false);   // client-local only
  const [voteClosesAt, setVoteClosesAt] = useState(null);
  const [voteCounts, setVoteCounts] = useState(null);
  const [voteTopic, setVoteTopic] = useState('');
  const votePollRef = useRef(null);

  // Auth bootstrap
  useEffect(() => { ensureGuest(); }, []);

  // Live countdown tick
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Poll room state + messages
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
      } catch {}
    }
    async function loadMessages() {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, await authHeaders());
        if (!res.ok) return;
        const j = await res.json();
        if (!mounted) return;
        const arr = (j.messages || []).map((m, idx) => ({
          id: String(m.createdAt || idx),
          whoEmoji: personas[m.personaIndex] || personas[0],
          ...m,
        }));
        setMessages(arr);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch {}
    }

    loadState();
    loadMessages();
    const id = setInterval(() => { loadState(); loadMessages(); }, 1500);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId, personas]);

  // Auto-greet when DISCOVERY begins (once)
  useEffect(() => {
    (async () => {
      if (stage === 'DISCOVERY' && !sentWelcome) {
        setSentWelcome(true);
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/welcome`, {
            method: 'POST',
            ...(await authHeaders()),
          });
        } catch {}
      }
    })();
  }, [stage, sentWelcome, roomId]);

  // --- Voting helpers ---
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
      // Demo-only tracking
      if (!j.votingOpen) setHasVoted(false);
      setVoteClosesAt(null);
    } catch {}
  }
  async function startVote() {
    await fetch(`${API_BASE}/rooms/${roomId}/vote/start`, { method: 'POST', ...(await authHeaders()) });
    await fetchVoteStatus();
  }
  async function submitVote(choiceNum) {
    await fetch(`${API_BASE}/rooms/${roomId}/vote/submit`, {
      method: 'POST',
      ...(await authHeaders()),
      body: JSON.stringify({ choice: Number(choiceNum) }),
    });
    setHasVoted(true);
    await fetchVoteStatus();
  }
  async function closeVote() {
    await fetch(`${API_BASE}/rooms/${roomId}/vote/close`, { method: 'POST', ...(await authHeaders()) });
    await fetchVoteStatus();
  }
  useEffect(() => {
    if (stage !== 'DISCOVERY') {
      if (votePollRef.current) { clearInterval(votePollRef.current); votePollRef.current = null; }
      setVoteOpen(false);
      return;
    }
    fetchVoteStatus();
    votePollRef.current = setInterval(fetchVoteStatus, 2000);
    return () => { if (votePollRef.current) { clearInterval(votePollRef.current); votePollRef.current = null; } };
  }, [stage, roomId]);

  // Send message -> POST to API (no Firestore)
  async function send() {
    const t = text.trim();
    if (!t) return;
    if (roomMeta.inputLocked && stage !== 'FINAL') return;

    await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
      method: 'POST',
      ...(await authHeaders()),
      body: JSON.stringify({
        text: t,
        phase: stage,
        personaIndex: activePersona,
      }),
    });
    setText('');

    // Call Asema when addressed
    if (/(^|\s)asema[\s,!?]/i.test(t) || /^asema$/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
          method: 'POST',
          ...(await authHeaders()),
          body: JSON.stringify({ text: t }),
        });
      } catch {}
    }

    if (stage === 'DISCOVERY' || stage === 'IDEA_DUMP') {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          ...(await authHeaders()),
        });
      } catch {}
    }

    if (stage === 'FINAL' && /^(done|submit)\b/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/final/ready`, {
          method: 'POST',
          ...(await authHeaders()),
        });
      } catch {}
    }
  }

  async function generateRough() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ mode: 'draft' }),
      });
      await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({ mode: 'ask' }),
      });
    } catch {}
  }

  async function finalize() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/final/complete`, {
        method: 'POST',
        ...(await authHeaders()),
      });
    } catch {}
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
        <TopBanner siteId={roomMeta.siteId} roomIndex={roomMeta.index} stage={stage} />

        <div style={{ display:'grid', gridTemplateColumns: (stage==='DISCOVERY'||stage==='IDEA_DUMP'||stage==='PLANNING') ? '1fr 320px' : '1fr', gap: 14 }}>
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
                    <button key={i} className={i === activePersona ? 'active' : ''} onClick={() => setActivePersona(i)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="chat-body">
              {messages
                .filter((m) => (m.phase || 'LOBBY') === stage)
                .map((m) => (
                  <ChatMessage
                    key={m.id}
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
          </div>

          {/* Idea Sidebar */}
          {(stage === 'DISCOVERY' || stage === 'IDEA_DUMP' || stage === 'PLANNING') && (
            <IdeaSidebar summary={ideaSummary} />
          )}
        </div>

        {/* Stage-specific quick actions */}
        <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          {stage === 'DISCOVERY' && (
            <>
              {isPresenter ? (
                <>
                  <button className="btn" onClick={startVote}>Start Vote</button>
                  <button className="btn" onClick={closeVote} disabled={!voteOpen}>Close Vote</button>
                </>
              ) : (
                <button className="btn" onClick={() => setVoteOpen(true)} disabled={!voteOpen}>
                  {voteOpen ? 'Vote Now' : 'Waiting for Vote'}
                </button>
              )}
              <div className="hud-pill" style={{ marginLeft: 'auto' }}>
                {roomMeta.topic ? `Topic: ${roomMeta.topic}` : (voteTopic ? `Topic: ${voteTopic}` : 'No topic selected')}
              </div>
            </>
          )}

          {stage === 'ROUGH_DRAFT' && (
            <button className="btn" onClick={generateRough}>Generate Rough</button>
          )}
          {stage === 'FINAL' && (
            <button className="btn primary" onClick={finalize}>Finalize</button>
          )}
          {roomMeta.inputLocked && <div className="hud-pill" style={{ marginLeft: 'auto' }}>Input Locked</div>}
        </div>
      </div>

      {/* Voting modal (simple inline version using buttons on the ribbon) */}
      {stage === 'DISCOVERY' && voteOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{ background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => {}}
        >
          <div
            className="rounded-2xl"
            style={{ width: 520, maxWidth:'92vw', background:'rgba(20,20,24,0.6)', border:'1px solid rgba(255,255,255,0.12)', backdropFilter:'blur(10px)', boxShadow:'0 16px 48px rgba(0,0,0,0.45)', color:'white', padding: 18 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <div className="gold-dot" />
              <div>
                <div style={{ fontWeight:700, fontSize:18 }}>Vote for today’s topic</div>
                <div style={{ opacity:.75, fontSize:12 }}>
                  Pick one number. Your vote is counted once.
                </div>
              </div>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:8, marginTop:8 }}>
              {(voteOptions.length ? voteOptions : [
                { num: 1, label: 'Law Enforcement Profiling' },
                { num: 2, label: 'Food Deserts' },
                { num: 3, label: 'Red Lining' },
                { num: 4, label: 'Homelessness' },
                { num: 5, label: 'Wealth Gap' },
              ]).map(opt => (
                <button
                  key={opt.num}
                  className="btn"
                  disabled={hasVoted}
                  onClick={() => submitVote(opt.num)}
                  style={{ display:'flex', justifyContent:'space-between' }}
                >
                  <span><b>{opt.num}.</b> {opt.label}</span>
                  {hasVoted && voteCounts && typeof voteCounts[opt.num] === 'number' && (
                    <span className="hud-pill">{voteCounts[opt.num]} votes</span>
                  )}
                </button>
              ))}
            </div>

            <div style={{ display:'flex', justifyContent:'space-between', marginTop:12 }}>
              <div style={{ fontSize:12, opacity:.75 }}>
                {hasVoted ? 'You have voted.' : 'You have not voted yet.'}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                {!isPresenter && (
                  <button className="btn" onClick={() => setVoteOpen(false)}>Close</button>
                )}
                {isPresenter && (
                  <button className="btn primary" onClick={closeVote}>Close & Lock Topic</button>
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
    </>
  );
}
