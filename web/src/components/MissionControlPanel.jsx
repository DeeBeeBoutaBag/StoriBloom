import React, { useMemo } from 'react';

const ACTIVE_STAGES = new Set([
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
]);

const SEVERITY_WEIGHT = {
  high: 3,
  medium: 2,
  low: 1,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function secsLeft(stageEndsAt) {
  const end = Number(stageEndsAt || 0);
  if (!end) return null;
  return Math.max(0, Math.floor((end - Date.now()) / 1000));
}

function buildRoomAlerts(room, signal = {}) {
  const stage = String(room.stage || 'LOBBY').toUpperCase();
  if (stage === 'CLOSED') return [];

  const alerts = [];
  const timeLeft = secsLeft(room.stageEndsAt);
  const seats = Math.max(0, Number(room.seats || 0));
  const heat = Array.isArray(signal.contributionHeat) ? signal.contributionHeat : [];
  const typing = Array.isArray(signal.typing) ? signal.typing : [];
  const contributed = heat.length;
  const totalContrib = heat.reduce((sum, row) => sum + Math.max(0, Number(row.value || 0)), 0);
  const topContrib = heat.reduce(
    (max, row) => Math.max(max, Math.max(0, Number(row.value || 0))),
    0
  );
  const topShare = totalContrib > 0 ? topContrib / totalContrib : 0;
  const silentCount = seats > 0 ? Math.max(0, seats - contributed) : 0;

  if (typeof timeLeft === 'number' && timeLeft <= 90 && ACTIVE_STAGES.has(stage)) {
    alerts.push({
      type: 'timer',
      severity: 'high',
      label: `Only ${timeLeft}s left in ${stage.replace('_', ' ')}`,
      hint: 'Extend time or move to the next action now.',
    });
  }

  if (ACTIVE_STAGES.has(stage) && typing.length === 0 && totalContrib <= 2) {
    alerts.push({
      type: 'stuck',
      severity: 'high',
      label: 'Likely stuck group',
      hint: 'Send a facilitator nudge or restart with a concrete prompt.',
    });
  }

  if (silentCount >= 2) {
    alerts.push({
      type: 'silent',
      severity: 'medium',
      label: `${silentCount} participants silent`,
      hint: 'Prompt quieter participants to contribute one line.',
    });
  }

  if (totalContrib >= 6 && topShare >= 0.65) {
    alerts.push({
      type: 'balance',
      severity: 'low',
      label: 'Conversation is unbalanced',
      hint: 'Invite one response from each remaining persona.',
    });
  }

  if (room.inputLocked && stage !== 'FINAL' && stage !== 'ROUGH_DRAFT') {
    alerts.push({
      type: 'locked',
      severity: 'medium',
      label: 'Input is locked',
      hint: 'Unlock if this room still needs to contribute.',
    });
  }

  return alerts;
}

function recommendIntervention(alerts = []) {
  const ordered = Array.isArray(alerts) ? alerts : [];
  if (ordered.some((a) => a.type === 'stuck')) return 'nudge_extend';
  if (ordered.some((a) => a.type === 'timer')) return 'extend_next';
  if (ordered.some((a) => a.type === 'locked')) return 'unlock_nudge';
  if (ordered.some((a) => a.type === 'silent')) return 'nudge';
  if (ordered.some((a) => a.type === 'balance')) return 'nudge';
  return 'monitor';
}

function interventionLabel(kind = '') {
  if (kind === 'nudge_extend') return 'Nudge + Extend';
  if (kind === 'extend_next') return 'Extend / Advance';
  if (kind === 'unlock_nudge') return 'Unlock + Nudge';
  if (kind === 'nudge') return 'Send Nudge';
  return 'Monitor';
}

function calculateRiskScore({ room = {}, alerts = [], signal = {} }) {
  const seats = Math.max(0, Number(room.seats || 0));
  const heat = Array.isArray(signal.contributionHeat) ? signal.contributionHeat : [];
  const typing = Array.isArray(signal.typing) ? signal.typing : [];
  const contributed = heat.length;
  const totalContrib = heat.reduce((sum, row) => sum + Math.max(0, Number(row.value || 0)), 0);
  const topContrib = heat.reduce(
    (max, row) => Math.max(max, Math.max(0, Number(row.value || 0))),
    0
  );
  const topShare = totalContrib > 0 ? topContrib / totalContrib : 0;
  const silentRatio = seats > 0 ? clamp((seats - contributed) / seats, 0, 1) : 0;

  let score = alerts.reduce((sum, item) => sum + (SEVERITY_WEIGHT[item.severity] || 1) * 16, 0);
  if (typing.length === 0) score += 10;
  if (topShare > 0.7) score += 10;
  score += Math.round(silentRatio * 24);
  if (String(room.stage || '').toUpperCase() === 'CLOSED') score = 0;
  return clamp(score, 0, 100);
}

function fmtStage(stage) {
  return String(stage || 'LOBBY').replace(/_/g, ' ');
}

export default function MissionControlPanel({
  rooms = [],
  roomSignals = {},
  onExtend,
  onUnlock,
  onNudge,
  onNext,
  onStartVote,
  onIntervene,
}) {
  const roomWithAlerts = useMemo(() => {
    return rooms
      .map((room) => {
        const signal = roomSignals[room.id] || {};
        const alerts = buildRoomAlerts(room, signal);
        const score = calculateRiskScore({ room, alerts, signal });
        const intervention = recommendIntervention(alerts);
        return { room, alerts, score, intervention };
      })
      .filter((row) => row.alerts.length > 0)
      .sort((a, b) => b.score - a.score || (a.room.index || 0) - (b.room.index || 0));
  }, [rooms, roomSignals]);

  const totals = useMemo(() => {
    const total = roomWithAlerts.length;
    const high = roomWithAlerts.filter((row) => row.score >= 70).length;
    const stuck = roomWithAlerts.filter((row) => row.alerts.some((a) => a.type === 'stuck')).length;
    const avgRisk = total
      ? Math.round(roomWithAlerts.reduce((sum, row) => sum + Number(row.score || 0), 0) / total)
      : 0;
    return { total, high, stuck, avgRisk };
  }, [roomWithAlerts]);

  return (
    <section className="mission-control glass stagger-item">
      <header className="mission-control-head">
        <div>
          <div className="mission-control-title">Mission Control</div>
          <div className="mission-control-subtitle">
            Live risk alerts, stuck-group detection, and one-click interventions.
          </div>
        </div>
        <div className="mission-control-metrics">
          <span className="pill">Alerts: <b>{totals.total}</b></span>
          <span className="pill">High risk: <b>{totals.high}</b></span>
          <span className="pill">Stuck groups: <b>{totals.stuck}</b></span>
          <span className="pill">Avg risk: <b>{totals.avgRisk}%</b></span>
        </div>
      </header>

      {!roomWithAlerts.length ? (
        <div className="empty-state mini">No active risks detected across rooms.</div>
      ) : (
        <div className="mission-alert-grid">
          {roomWithAlerts.map(({ room, alerts, score, intervention }) => (
            <article key={room.id} className="mission-alert-card">
              <div className="mission-alert-head">
                <div>
                  <div className="mission-alert-room">Room {room.index} {room.id?.split('-')?.[0] || ''}</div>
                  <div className="mission-alert-stage">{fmtStage(room.stage)}</div>
                </div>
                <span className={`pill mission-severity-${alerts[0].severity}`}>
                  {alerts[0].severity.toUpperCase()}
                </span>
              </div>

              <div className="mission-risk-meter">
                <div className="mission-risk-head">
                  <span>Risk score</span>
                  <b>{score}%</b>
                </div>
                <div className="mission-risk-track">
                  <div className="mission-risk-fill" style={{ width: `${Math.max(4, score)}%` }} />
                </div>
                <div className="mission-risk-tip">
                  Suggested intervention: <b>{interventionLabel(intervention)}</b>
                </div>
              </div>

              <ul className="mission-alert-list">
                {alerts.map((alert) => (
                  <li key={`${room.id}-${alert.type}`} className={`mission-alert-item mission-alert-${alert.severity}`}>
                    <div className="mission-alert-label">{alert.label}</div>
                    <div className="mission-alert-hint">{alert.hint}</div>
                  </li>
                ))}
              </ul>

              <div className="mission-alert-actions">
                <button type="button" className="btn primary" onClick={() => onIntervene?.(room.id, intervention)}>
                  Auto Intervene
                </button>
                <button type="button" className="btn" onClick={() => onNudge?.(room.id)}>
                  Send Nudge
                </button>
                <button type="button" className="btn" onClick={() => onExtend?.(room.id, 120)}>
                  +2m
                </button>
                <button type="button" className="btn" onClick={() => onUnlock?.(room.id)}>
                  Unlock
                </button>
                <button type="button" className="btn" onClick={() => onStartVote?.(room.id)}>
                  Start Vote
                </button>
                <button type="button" className="btn primary" onClick={() => onNext?.(room.id)}>
                  Next Stage
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
