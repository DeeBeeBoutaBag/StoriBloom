import React, { useEffect, useMemo, useState } from 'react';

function phaseName(phase) {
  return String(phase || '').replace(/_/g, ' ');
}

function when(ms) {
  const n = Number(ms || 0);
  if (!n) return '';
  try {
    return new Date(n).toLocaleTimeString();
  } catch {
    return '';
  }
}

export default function ReplayModal({
  open = false,
  loading = false,
  entries = [],
  cursor = 0,
  onCursorChange,
  onClose,
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      return;
    }
    if (!playing || loading || entries.length <= 1) return undefined;
    const stepMs = Math.max(280, Math.floor(1200 / Math.max(0.5, Number(speed || 1))));
    const id = setInterval(() => {
      const safe = Math.max(0, Math.min(entries.length - 1, Number(cursor || 0)));
      if (safe >= entries.length - 1) {
        setPlaying(false);
        return;
      }
      onCursorChange?.(safe + 1);
    }, stepMs);
    return () => clearInterval(id);
  }, [open, playing, loading, entries.length, speed, cursor, onCursorChange]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e) {
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((prev) => !prev);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onCursorChange?.(Math.min(entries.length - 1, Number(cursor || 0) + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onCursorChange?.(Math.max(0, Number(cursor || 0) - 1));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, cursor, entries.length, onCursorChange]);

  const phaseFilmstrip = useMemo(() => {
    const firstByPhase = new Map();
    const counts = new Map();
    (entries || []).forEach((entry, index) => {
      const phase = String(entry.phase || '').toUpperCase();
      if (!phase) return;
      if (!firstByPhase.has(phase)) firstByPhase.set(phase, index);
      counts.set(phase, Number(counts.get(phase) || 0) + 1);
    });
    return Array.from(firstByPhase.entries()).map(([phase, firstIndex]) => ({
      phase,
      firstIndex,
      count: Number(counts.get(phase) || 0),
    }));
  }, [entries]);

  const reflection = useMemo(() => {
    const rows = Array.isArray(entries) ? entries : [];
    let decisions = 0;
    let votes = 0;
    let edits = 0;
    let interventions = 0;
    for (const entry of rows) {
      if (entry?.type === 'stage') decisions += 1;
      if (entry?.type === 'action') {
        const action = String(entry.action || '').toUpperCase();
        if (
          action.includes('VOTE') ||
          action.includes('TOPIC_LOCKED') ||
          action.includes('FINAL_CLOSE')
        ) {
          decisions += 1;
        }
        if (action.includes('VOTE')) votes += 1;
        if (action.includes('DRAFT_EDIT')) edits += 1;
        if (action.includes('AUTOPILOT') || action.includes('INTERVENTION')) interventions += 1;
      }
      if (
        entry?.type === 'message' &&
        String(entry.authorType || '').toLowerCase() === 'asema' &&
        /updated draft|rough draft/i.test(String(entry.text || ''))
      ) {
        edits += 1;
      }
    }
    return { decisions, votes, edits, interventions };
  }, [entries]);

  if (!open) return null;

  const safeCursor = Math.max(0, Math.min(entries.length - 1, Number(cursor || 0)));
  const active = entries[safeCursor] || null;

  return (
    <div
      className="fixed inset-0 z-50 replay-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Session replay"
    >
      <div className="replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="replay-head">
          <div>
            <div className="replay-title">Session Replay</div>
            <div className="replay-subtitle">
              Timeline playback of phase shifts, votes, edits, and facilitator actions.
            </div>
          </div>
          <div className="replay-head-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {loading ? (
          <div className="empty-state mini">Loading replay…</div>
        ) : !entries.length ? (
          <div className="empty-state mini">No replay entries yet.</div>
        ) : (
          <>
            {!!phaseFilmstrip.length && (
              <div className="replay-filmstrip">
                {phaseFilmstrip.map((item) => (
                  <button
                    key={item.phase}
                    type="button"
                    className={`replay-film-item ${active?.phase === item.phase ? 'active' : ''}`}
                    onClick={() => onCursorChange?.(item.firstIndex)}
                  >
                    <span>{phaseName(item.phase)}</span>
                    <b>{item.count}</b>
                  </button>
                ))}
              </div>
            )}

            <div className="replay-reflection">
              <span className="pill">Decisions: <b>{reflection.decisions}</b></span>
              <span className="pill">Votes: <b>{reflection.votes}</b></span>
              <span className="pill">Edits: <b>{reflection.edits}</b></span>
              <span className="pill">Interventions: <b>{reflection.interventions}</b></span>
            </div>

            <div className="replay-controls">
              <button
                type="button"
                className="btn"
                onClick={() => onCursorChange?.(Math.max(0, safeCursor - 1))}
                disabled={safeCursor <= 0}
              >
                Prev
              </button>
              <button
                type="button"
                className={`btn ${playing ? 'primary' : ''}`}
                onClick={() => setPlaying((prev) => !prev)}
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onCursorChange?.(Math.min(entries.length - 1, safeCursor + 1))}
                disabled={safeCursor >= entries.length - 1}
              >
                Next
              </button>
              <label className="replay-speed">
                Speed
                <select
                  className="select"
                  value={String(speed)}
                  onChange={(e) => setSpeed(Number(e.target.value || 1))}
                >
                  <option value="0.75">0.75x</option>
                  <option value="1">1x</option>
                  <option value="1.5">1.5x</option>
                  <option value="2">2x</option>
                </select>
              </label>
            </div>

            <div className="replay-slider-wrap">
              <input
                type="range"
                min={0}
                max={Math.max(0, entries.length - 1)}
                value={safeCursor}
                onChange={(e) => onCursorChange?.(Number(e.target.value || 0))}
                className="replay-slider"
              />
              <div className="replay-slider-meta">
                <span>{safeCursor + 1} / {entries.length}</span>
                <span>{active?.at ? when(active.at) : ''}</span>
              </div>
            </div>

            {active && (
              <div className="replay-active">
                {active.type === 'stage' ? (
                  <>
                    <div className="replay-active-kicker">Stage Change</div>
                    <div className="replay-active-body">
                      Entered <b>{phaseName(active.phase)}</b>
                    </div>
                  </>
                ) : active.type === 'action' ? (
                  <>
                    <div className="replay-active-kicker">Facilitator Action</div>
                    <div className="replay-active-body">{active.text || active.action || '—'}</div>
                    <div className="replay-receipt">
                      <span>Actor: {active.actorRole || 'SYSTEM'}</span>
                      <span>Action: {active.action || '—'}</span>
                      <span>Phase: {phaseName(active.phase || '') || '—'}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="replay-active-kicker">
                      {active.authorType === 'asema' ? 'AI Suggestion' : 'Participant Message'}
                    </div>
                    <div className="replay-active-body">{active.text || '—'}</div>
                    {active.aiReceipt ? (
                      <div className="replay-receipt">
                        <span>Confidence: {Math.round(Number(active.aiReceipt.confidence || 0) * 100)}%</span>
                        <span>Policy: {active.aiReceipt.policyChecks?.strictness || '—'}</span>
                        <span>Source: {active.aiReceipt.source || '—'}</span>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}

            <div className="replay-list">
              {entries.slice(-18).map((entry, idx) => {
                const index = entries.length - Math.min(entries.length, 18) + idx;
                return (
                  <button
                    key={`${entry.type}-${entry.at}-${idx}`}
                    type="button"
                    className={`replay-item ${index === safeCursor ? 'active' : ''}`}
                    onClick={() => onCursorChange?.(index)}
                  >
                    <span>
                      {entry.type === 'stage'
                        ? `Stage: ${phaseName(entry.phase)}`
                        : entry.type === 'action'
                        ? `Action: ${entry.text?.slice(0, 80) || entry.action || ''}`
                        : `${entry.authorType === 'asema' ? 'AI' : entry.emoji || '🙂'} ${entry.text?.slice(0, 64) || ''}`}
                    </span>
                    <span>{when(entry.at)}</span>
                  </button>
                );
              })}
            </div>

            <div className="replay-debrief">
              <div className="replay-active-kicker">Reflection prompts</div>
              <div>1. Which decision changed direction most?</div>
              <div>2. Where did participation become more balanced or less balanced?</div>
              <div>3. What facilitator move should repeat next session?</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
