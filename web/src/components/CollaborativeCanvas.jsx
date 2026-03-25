import React from 'react';

function formatPhase(phase) {
  return String(phase || '').replace(/_/g, ' ');
}

function formatSaved(ms) {
  const n = Number(ms || 0);
  if (!n) return '';
  try {
    return new Date(n).toLocaleTimeString();
  } catch {
    return '';
  }
}

export default function CollaborativeCanvas({
  phase = 'DISCOVERY',
  phases = [],
  canvas = {},
  disabled = false,
  dirty = false,
  saving = false,
  phaseGoal = '',
  nextHint = '',
  onPhaseChange,
  onChange,
  onSave,
}) {
  function seedBoard() {
    if (disabled) return;
    if (!String(canvas.stickyNotes || '').trim()) {
      onChange?.(
        'stickyNotes',
        '- Story spark\n- Tension line\n- Community truth\n- Character voice'
      );
    }
    if (!String(canvas.outlineMap || '').trim()) {
      onChange?.(
        'outlineMap',
        'Opening:\nConflict:\nTurning point:\nResolution:\nCall to action:'
      );
    }
    if (!String(canvas.evidenceBoard || '').trim()) {
      onChange?.(
        'evidenceBoard',
        'Claim:\n- \nEvidence:\n- \nReasoning:\n- \nCitations:\n- https://example.org/source'
      );
    }
    if (!String(canvas.narrativeMap || '').trim()) {
      onChange?.(
        'narrativeMap',
        'Voice:\nArc:\nKey scene:\nEnding impact:'
      );
    }
  }

  return (
    <section className="canvas-panel">
      <div className="canvas-head">
        <div>
          <div className="canvas-title">Collaborative Canvas</div>
          <div className="canvas-subtitle">
            Sticky notes, outline map, evidence board, and final narrative map.
          </div>
        </div>
        <div className="canvas-controls">
          <select
            className="select"
            value={phase}
            onChange={(e) => onPhaseChange?.(e.target.value)}
            disabled={disabled}
            aria-label="Canvas phase"
          >
            {phases.map((p) => (
              <option key={p} value={p}>
                {formatPhase(p)}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost" onClick={seedBoard} disabled={disabled}>
            Seed Prompts
          </button>
        </div>
      </div>

      {(phaseGoal || nextHint) ? (
        <div className="canvas-guidance">
          {phaseGoal ? (
            <div>
              <b>Phase goal:</b> {phaseGoal}
            </div>
          ) : null}
          {nextHint ? (
            <div>
              <b>Next action:</b> {nextHint}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="canvas-grid">
        <label className="canvas-field">
          <span className="canvas-label">Sticky Notes</span>
          <textarea
            value={canvas.stickyNotes || canvas.ideas || ''}
            onChange={(e) => onChange?.('stickyNotes', e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder="Rapid ideas: one thought per line, no over-editing."
          />
        </label>

        <label className="canvas-field">
          <span className="canvas-label">Outline Map</span>
          <textarea
            value={canvas.outlineMap || canvas.structure || ''}
            onChange={(e) => onChange?.('outlineMap', e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder="Outline flow: opening, tension, turn, ending, call to action."
          />
        </label>

        <label className="canvas-field">
          <span className="canvas-label">Evidence Board (CER + citation)</span>
          <textarea
            value={canvas.evidenceBoard || ''}
            onChange={(e) => onChange?.('evidenceBoard', e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder="Use Claim, Evidence, Reasoning, and at least one citation/source URL."
          />
        </label>

        <label className="canvas-field">
          <span className="canvas-label">Narrative Map</span>
          <textarea
            value={canvas.narrativeMap || canvas.map || ''}
            onChange={(e) => onChange?.('narrativeMap', e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder="Map voices, facts, key moments, and final story arc."
          />
        </label>
      </div>

      <div className="canvas-foot">
        <button type="button" className="btn primary" onClick={onSave} disabled={disabled || !dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save Canvas' : 'Saved'}
        </button>
        <span className="canvas-meta">
          {canvas.updatedAt ? `Last saved ${formatSaved(canvas.updatedAt)}` : 'Not saved yet'}
          {canvas.updatedBy ? ` by ${canvas.updatedBy}` : ''}
        </span>
      </div>
    </section>
  );
}
