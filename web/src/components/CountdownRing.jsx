import React, { useMemo } from 'react';

export default function CountdownRing({ secondsLeft = 0, secondsTotal = 1 }) {
  const radius = 18, stroke = 4;
  const C = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, secondsLeft / Math.max(1, secondsTotal)));
  const dash = useMemo(() => `${C * pct} ${C * (1 - pct)}`, [C, pct]);
  const secs = Math.max(0, Math.floor(secondsLeft));

  return (
    <div className="ring" title={`${secs}s remaining`}>
      <svg width="42" height="42">
        <circle cx="21" cy="21" r={radius} stroke="rgba(255,255,255,.14)" strokeWidth={stroke} fill="none"/>
        <circle cx="21" cy="21" r={radius} stroke="url(#gold)" strokeWidth={stroke} fill="none"
                strokeLinecap="round" strokeDasharray={dash}/>
        <defs>
          <linearGradient id="gold" x1="0" x2="1">
            <stop offset="0%" stopColor="#f0c86b"/>
            <stop offset="100%" stopColor="#ffefb6"/>
          </linearGradient>
        </defs>
      </svg>
      <div className="label">{secs}s</div>
    </div>
  );
}
