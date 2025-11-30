// web/src/components/CountdownRing.jsx
import React, { useMemo } from 'react';

export default function CountdownRing({ secondsLeft = 0, secondsTotal = 1 }) {
  const radius = 18;
  const stroke = 4;
  const C = 2 * Math.PI * radius;

  const safeTotal = Math.max(1, secondsTotal);
  const clampedLeft = Math.max(0, Math.floor(secondsLeft));
  const pct = Math.max(0, Math.min(1, clampedLeft / safeTotal));

  // Stroke dash
  const dash = useMemo(
    () => `${C * pct} ${C * (1 - pct)}`,
    [C, pct]
  );

  // Format as mm:ss
  const label = useMemo(() => {
    const mins = Math.floor(clampedLeft / 60);
    const secs = clampedLeft % 60;
    if (safeTotal <= 60) {
      // Short phases: just show seconds
      return `${clampedLeft}s`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }, [clampedLeft, safeTotal]);

  // Urgency coloring
  const urgency = clampedLeft / safeTotal;
  let ringColor = '#5BE49B'; // green-ish
  if (urgency <= 0.4 && urgency > 0.15) {
    ringColor = '#F5C673'; // amber
  } else if (urgency <= 0.15) {
    ringColor = '#F97373'; // red-ish
  }

  return (
    <div
      className="ring"
      title={`${clampedLeft}s remaining`}
      aria-label={`Time remaining: ${clampedLeft} seconds`}
      style={{
        position: 'relative',
        width: 42,
        height: 42,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg
        width="42"
        height="42"
        style={{ transform: 'rotate(-90deg)' }}
      >
        {/* Background track */}
        <circle
          cx="21"
          cy="21"
          r={radius}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={stroke}
          fill="none"
        />
        {/* Active arc */}
        <circle
          cx="21"
          cy="21"
          r={radius}
          stroke={ringColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={dash}
          style={{
            transition: 'stroke-dasharray 0.3s linear, stroke 0.25s ease-out',
          }}
        />
      </svg>

      <div
        className="label"
        style={{
          position: 'absolute',
          fontSize: 11,
          fontWeight: 600,
          color: '#fff',
          userSelect: 'none',
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
    </div>
  );
}
