import React, { useMemo } from 'react';

function numberFmt(value, digits = 0) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function GaugeCard({ title, value, max, subtitle, tone = 'leaf' }) {
  const safeMax = Math.max(1, Number(max || 0));
  const safeValue = Math.max(0, Number(value || 0));
  const pct = Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100)));

  return (
    <article className="analytics-card">
      <div className="analytics-title">{title}</div>
      <div className="analytics-gauge-wrap">
        <div className={`analytics-gauge analytics-gauge-${tone}`} style={{ '--gauge-pct': `${pct}%` }}>
          <div className="analytics-gauge-inner">{pct}%</div>
        </div>
        <div className="analytics-gauge-meta">
          <div className="analytics-metric-main">
            {numberFmt(safeValue)} / {numberFmt(safeMax)}
          </div>
          <div className="analytics-metric-sub">{subtitle || 'Live utilization'}</div>
        </div>
      </div>
    </article>
  );
}

export function MiniBarChart({ title, items = [], emptyLabel = 'No data yet', tone = 'sunflower' }) {
  const cleaned = useMemo(
    () =>
      (Array.isArray(items) ? items : [])
        .map((item) => ({
          label: String(item?.label || ''),
          value: Number(item?.value || 0),
        }))
        .filter((item) => item.label),
    [items]
  );

  const max = Math.max(1, ...cleaned.map((item) => item.value));

  return (
    <article className="analytics-card">
      <div className="analytics-title">{title}</div>
      {cleaned.length ? (
        <div className="analytics-bars">
          {cleaned.map((item) => {
            const width = Math.max(4, Math.round((item.value / max) * 100));
            return (
              <div key={item.label} className="analytics-row">
                <div className="analytics-row-head">
                  <span>{item.label}</span>
                  <span>{numberFmt(item.value)}</span>
                </div>
                <div className="analytics-track">
                  <div
                    className={`analytics-fill analytics-fill-${tone}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state mini">{emptyLabel}</div>
      )}
    </article>
  );
}

export function SparklineCard({ title, values = [], subtitle = '' }) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((v) => Number(v || 0))
    .filter((v) => Number.isFinite(v));

  const points = useMemo(() => {
    if (!normalized.length) return '';
    const w = 200;
    const h = 56;
    const min = Math.min(...normalized);
    const max = Math.max(...normalized);
    const span = Math.max(1, max - min);

    return normalized
      .map((value, idx) => {
        const x = (idx / Math.max(normalized.length - 1, 1)) * w;
        const y = h - ((value - min) / span) * h;
        return `${x},${y}`;
      })
      .join(' ');
  }, [normalized]);

  const total = normalized.reduce((sum, value) => sum + value, 0);

  return (
    <article className="analytics-card">
      <div className="analytics-title">{title}</div>
      {points ? (
        <div className="sparkline-wrap">
          <svg viewBox="0 0 200 56" role="img" aria-label={title}>
            <polyline points={points} className="sparkline-line" />
          </svg>
          <div className="analytics-metric-main">{numberFmt(total)}</div>
          <div className="analytics-metric-sub">{subtitle || 'Recent activity'}</div>
        </div>
      ) : (
        <div className="empty-state mini">No trend data yet</div>
      )}
    </article>
  );
}
