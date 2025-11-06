// web/src/pages/Room.jsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureGuest, authHeaders, API_BASE } from '../api.js';

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

  // Role (read from login flow; default participant)
  const role = useMemo(() => sessionStorage.getItem('role') || 'PARTICIPANT', []);
  const isPresenter = role === 'PRESENTER';

  // Room meta + stage state
  const [stage, setStage] = useState('LOBBY');
  const [stageEndsAt, setStageEndsAt] = useState(null); // Date|null
  const [roomMeta, setRoomMeta] = useState({ siteId: '', index: 1, inputLocked: false, topic: '' });

  // Messages + sidebar
  const [messages, setMessages] = useState([]);
  const [ideaSummary, setIdeaSummary] = useState('');

  // Compose state
  const [text, setText] = useState('');
  const [activePersona, setActivePersona] = useState(0);

  // Personas from login
  const personas = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('personas') || '["🙂"]'); }
    catch { return ['🙂']; }
  }, []);
  const mode = sessionStorage.getItem('mode') || 'individual';

  // Utilities
  const scrollRef = useRef(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sentWelcome, setSentWelcome] = useState(false);
  const [askedRoughQs, setAskedRoughQs] = useState(false);

  // --- Voting state (Discovery) ---
  const [voteOpen, setVoteOpen] = useState(false);
  const [voteOptions, setVoteOptions] = useState([]);      // [{num: 1, label: '…'}]
  const [hasVoted, setHasVoted] = useState(false);
  const [voteClosesAt, setVoteClosesAt] = useState(null);  // Date | null
  const [voteCounts, setVoteCounts] = useState(null);      // optional aggregate
  const [voteTopic, setVoteTopic] = useState('');          // selected topic (after close)

  // Live countdown tick
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Bootstrap auth once
  useEffect(() => { ensureGuest().catch(() => {}); }, []);

  // Poll room state
  useEffect(() => {
    let mounted = true;
    async function loadState() {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/state`, { headers: await authHeaders() });
        if (!res.ok) throw new Error('state fetch failed');
        const j = await res.json();

        if (!mounted) return;

        // Expect shape: { stage, stageEndsAt, siteId, index, inputLocked, topic, ideaSummary }
        const s = (j.stage || 'LOBBY').toUpperCase();
        setStage(s);
        const ends = typeof j.stageEndsAt === 'number' ? new Date(j.stageEndsAt) :
                     (j.stageEndsAt ? new Date(j.stageEndsAt) : null);
        setStageEndsAt(ends);
        setRoomMeta({
          siteId: j.siteId || roomId.split('-')[0],
          index: j.index || 1,
          inputLocked: !!j.inputLocked,
          topic: j.topic || '',
        });
        setIdeaSummary(j.ideaSummary || '');
      } catch (e) {
        // on failure, keep last known state
      }
    }

    loadState();
    const id = setInterval(loadState, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId]);

  // Poll messages (partition by room)
  useEffect(() => {
    let mounted = true;

    async function loadMsgs() {
      try {
        const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, { headers: await authHeaders() });
        if (!res.ok) throw new Error('messages fetch failed');
        const j = await res.json();
        if (!mounted) return;

        // Expect shape: { messages: [{ createdAt, uid, personaIndex, authorType, phase, text, id? }] }
        const arr = Array.isArray(j.messages) ? j.messages : [];
        arr.sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
        setMessages(arr);

        // scroll to bottom
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch (e) {
        // ignore transient errors
      }
    }

    loadMsgs();
    const id = setInterval(loadMsgs, 1500);
    return () => { mounted = false; clearInterval(id); };
  }, [roomId]);

  // Auto-greet when DISCOVERY begins (once)
  useEffect(() => {
    (async () => {
      if (stage === 'DISCOVERY' && !sentWelcome) {
        setSentWelcome(true);
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/welcome`, {
            method: 'POST',
            headers: await authHeaders(),
          });
        } catch { /* noop */ }
      }
    })();
  }, [stage, sentWelcome, roomId]);

  // ROUGH_DRAFT: have Asema ask 2–3 guiding questions once (after rough is generated)
  useEffect(() => {
    (async () => {
      if (stage === 'ROUGH_DRAFT' && !askedRoughQs) {
        setAskedRoughQs(true);
        // Intentionally no call here—server should trigger ask after draft generate.
      }
    })();
  }, [stage, askedRoughQs]);

  // --- Voting: helpers ---
  async function fetchVoteStatus() {
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}/vote`, {
        method: 'GET',
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const j = await res.json();
      // shape: { votingOpen, options:[{num,label}], closesAt, hasVoted, counts?, topic? }
      setVoteOpen(!!j.votingOpen && stage === 'DISCOVERY');
      setVoteOptions(Array.isArray(j.options) ? j.options : []);
      setHasVoted(!!j.hasVoted);
      setVoteCounts(j.counts || null);
      setVoteTopic(j.topic || '');
      setVoteClosesAt(j.closesAt ? new Date(j.closesAt) : null);
    } catch {
      // ignore transient errors
    }
  }

  async function startVote() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/start`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      await fetchVoteStatus();
    } catch {
      alert('Could not start voting');
    }
  }

  async function submitVote(choiceNum) {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/submit`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ choice: Number(choiceNum) }),
      });
      await fetchVoteStatus();
    } catch {
      alert('Could not submit vote');
    }
  }

  async function closeVote() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/vote/close`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      await fetchVoteStatus();
    } catch {
      alert('Could not close voting');
    }
  }

  // Start/stop polling vote status while in DISCOVERY
  const votePollRef = useRef(null);
  useEffect(() => {
    if (stage !== 'DISCOVERY') {
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
      setVoteOpen(false);
      return;
    }
    // initial fetch
    fetchVoteStatus();
    votePollRef.current = setInterval(fetchVoteStatus, 2000);
    return () => {
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
    };
  }, [stage, roomId]);

  // Send message handler
  async function send() {
    const t = text.trim();
    if (!t) return;

    // respect input lock (e.g., after rough draft)
    if (roomMeta.inputLocked && stage !== 'FINAL') return;

    try {
      await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          personaIndex: activePersona,
          authorType: 'user',
          phase: stage,
          text: t,
        }),
      });
      setText('');
    } catch {
      // swallow; polling will refresh messages anyway
    }

    // If the user calls Asema by name → ask route (on-topic-only)
    if (/(^|\s)asema[\s,!?]/i.test(t) || /^asema$/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ask`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ text: t }),
        });
      } catch { /* noop */ }
    }

    // During idea phases → trigger debounced summarizer (saves tokens)
    if (stage === 'DISCOVERY' || stage === 'IDEA_DUMP') {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/ideas/trigger`, {
          method: 'POST',
          headers: await authHeaders(),
        });
      } catch { /* noop */ }
    }

    // In FINAL: if someone types "done" or "submit", mark ready
    if (stage === 'FINAL' && /^(done|submit)\b/i.test(t)) {
      try {
        await fetch(`${API_BASE}/rooms/${roomId}/final/ready`, {
          method: 'POST',
          headers: await authHeaders(),
        });
      } catch { /* noop */ }
    }
  }

  // Generate rough on click (visible during ROUGH_DRAFT)
  async function generateRough() {
    try {
      // First request the draft (server ensures exactly 250 words)
      await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ mode: 'draft' }),
      });
      // Then ask guiding questions (server should avoid duplicates)
      await fetch(`${API_BASE}/rooms/${roomId}/draft/generate`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ mode: 'ask' }),
      });
    } catch { /* noop */ }
  }

  // Start Final flow (Asema posts rough + instructions)
  useEffect(() => {
    (async () => {
      if (stage === 'FINAL') {
        try {
          await fetch(`${API_BASE}/rooms/${roomId}/final/start`, {
            method: 'POST',
            headers: await authHeaders(),
          });
        } catch { /* noop */ }
      }
    })();
  }, [stage, roomId]);

  // Presenter/manual finalize button
  async function finalize() {
    try {
      await fetch(`${API_BASE}/rooms/${roomId}/final/complete`, {
        method: 'POST',
        headers: await authHeaders(),
      });
    } catch { /* noop */ }
  }

  // Stage/time UI helpers
  const total = TOTAL_BY_STAGE[stage] || 1;
  const secsLeft = stageEndsAt ? Math.max(0, Math.floor((stageEndsAt.getTime() - nowTick) / 1000)) : 0;

  // Input lock: allow typing in certain stages unless locked by API
  const canType = !roomMeta.inputLocked && ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','EDITING','FINAL'].includes(stage);

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
              {messages
                .filter((m) => (m.phase || 'LOBBY') === stage)
                .map((m, idx) => (
                  <ChatMessage
                    key={m.id || `${m.createdAt || 0}-${idx}`}
                    kind={String(m.authorType).toLowerCase() === 'asema' ? 'asema' : 'user'}
                    who={String(m.authorType).toLowerCase() === 'asema' ? '🤖' : (personas[m.personaIndex] || personas[0])}
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

          {/* Idea Sidebar (visible in DISCOVERY / IDEA_DUMP / PLANNING) */}
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
          {/* Input lock indicator */}
          {roomMeta.inputLocked && <div className="hud-pill" style={{ marginLeft: 'auto' }}>Input Locked</div>}
        </div>
      </div>

      {/* --- Voting Modal (Discovery) --- */}
      {stage === 'DISCOVERY' && voteOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => {}}
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
              padding: 18
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div className="gold-dot" />
              <div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>Vote for today’s topic</div>
                <div style={{ opacity: .75, fontSize: 12 }}>
                  Pick one number. Your vote is counted once. {voteClosesAt ? `Closes in ~${Math.max(0, Math.floor((voteClosesAt.getTime() - Date.now())/1000))}s` : ''}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginTop: 8 }}>
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
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <span><b>{opt.num}.</b> {opt.label}</span>
                  {hasVoted && voteCounts && typeof voteCounts[opt.num] === 'number' && (
                    <span className="hud-pill">{voteCounts[opt.num]} votes</span>
                  )}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <div style={{ fontSize: 12, opacity: .75 }}>
                {hasVoted ? 'You have voted.' : 'You have not voted yet.'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isPresenter && (
                  <button className="btn" onClick={() => setVoteOpen(false)}>Close</button>
                )}
                {isPresenter && (
                  <button className="btn primary" onClick={closeVote}>Close &amp; Lock Topic</button>
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
