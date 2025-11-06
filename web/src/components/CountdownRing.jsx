// web/src/components/CountdownRing.jsx
import React, { useMemo } from 'react';

export default function CountdownRing({ secondsLeft = 0, secondsTotal = 1 }) {
  const radius = 18;
  const stroke = 4;
  const C = 2 * Math.PI * radius;

  // Clamp 0–1
  const pct = Math.max(0, Math.min(1, secondsLeft / Math.max(1, secondsTotal)));

  // Compute stroke dash array
  const dash = useMemo(() => `${C * pct} ${C * (1 - pct)}`, [C, pct]);
  const secs = Math.max(0, Math.floor(secondsLeft));

  return (
    <div
      className="ring"
      title={`${secs}s remaining`}
      aria-label={`Time remaining: ${secs} seconds`}
      style={{
        position: 'relative',
        width: 42,
        height: 42,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="42" height="42" style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx="21"
          cy="21"
          r={radius}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx="21"
          cy="21"
          r={radius}
          stroke="url(#gold-gradient)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={dash}
          style={{
            transition: 'stroke-dasharray 0.3s linear',
          }}
        />
        <defs>
          <linearGradient id="gold-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f0c86b" />
            <stop offset="100%" stopColor="#ffefb6" />
          </linearGradient>
        </defs>
      </svg>

      <div
        className="label"
        style={{
          position: 'absolute',
          fontSize: 11,
          fontWeight: 600,
          color: '#fff',
          userSelect: 'none',
        }}
      >
        {secs}s
      </div>
    </div>
  );
}
