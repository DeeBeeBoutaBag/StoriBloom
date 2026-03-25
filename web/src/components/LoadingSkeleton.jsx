import React from 'react';

export function SkeletonLine({ width = '100%', height = 12 }) {
  return <div className="skeleton-line" style={{ width, height }} aria-hidden />;
}

export function SkeletonCard({ rows = 3 }) {
  return (
    <div className="skeleton-card" aria-hidden>
      <SkeletonLine width="42%" height={14} />
      {Array.from({ length: rows }).map((_, idx) => (
        <SkeletonLine key={idx} width={`${100 - idx * 12}%`} />
      ))}
    </div>
  );
}

export function EmptyState({ title, subtitle, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-subtitle">{subtitle}</div>
      {action || null}
    </div>
  );
}
