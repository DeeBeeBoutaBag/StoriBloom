import React, { useMemo } from 'react';

function formatStage(stage) {
  return String(stage || '').replace(/_/g, ' ');
}

export default function StageTimelineRail({
  stage,
  order = [],
  goals = {},
  hints = {},
  secsLeft = 0,
  totalSec = 1,
}) {
  const currentIndex = Math.max(0, order.indexOf(stage));
  const pct = useMemo(() => {
    const total = Math.max(1, Number(totalSec || 1));
    const left = Math.max(0, Number(secsLeft || 0));
    return Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
  }, [secsLeft, totalSec]);

  const nextStage = order[currentIndex + 1] || 'CLOSED';

  return (
    <aside className="timeline-rail">
      <div className="timeline-head">
        <div className="timeline-title">Stage Timeline</div>
        <div className="timeline-pct">{pct}%</div>
      </div>

      <div className="timeline-progress-track" aria-hidden>
        <div className="timeline-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <ol className="timeline-list">
        {order.map((item, idx) => {
          const done = idx < currentIndex;
          const active = item === stage;
          return (
            <li key={item} className={`timeline-item ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
              <span className="timeline-dot" />
              <span>{formatStage(item)}</span>
            </li>
          );
        })}
      </ol>

      <div className="timeline-card">
        <div className="timeline-card-kicker">Current Goal</div>
        <div className="timeline-card-body">{goals[stage] || 'Guide participants through this stage.'}</div>
      </div>

      <div className="timeline-card">
        <div className="timeline-card-kicker">Next Action</div>
        <div className="timeline-card-body">{hints[stage] || `Prepare for ${formatStage(nextStage)}.`}</div>
      </div>
    </aside>
  );
}
