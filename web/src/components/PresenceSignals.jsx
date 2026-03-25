import React, { useMemo } from 'react';

export default function PresenceSignals({
  typing = [],
  contributionHeat = [],
  equity = {},
  seats = 0,
}) {
  const stats = useMemo(() => {
    const heat = Array.isArray(contributionHeat) ? contributionHeat : [];
    const total = heat.reduce((sum, row) => sum + Math.max(0, Number(row.value || 0)), 0);
    const top = heat.reduce((max, row) => Math.max(max, Math.max(0, Number(row.value || 0))), 0);
    const topShare = total > 0 ? top / total : 0;
    const silentCount = Math.max(0, Number(seats || 0) - heat.length);
    return { total, topShare, silentCount };
  }, [contributionHeat, seats]);
  const equityRows = useMemo(
    () => (Array.isArray(equity?.rows) ? equity.rows : []),
    [equity]
  );
  const balanceScore = Number.isFinite(Number(equity?.balanceScore))
    ? Number(equity.balanceScore)
    : 100;
  const quietCount = Number(equity?.quietCount || stats.silentCount || 0);
  const dominantSharePct = Number(equity?.dominantSharePct || 0);

  return (
    <section className="presence-panel">
      <div className="presence-head">
        <div className="presence-title">Live Presence</div>
        <div className="presence-subtitle">Typing + contribution equity tracker with participation nudges.</div>
      </div>

      <div className="presence-equity">
        <div className="presence-equity-head">
          <span>Equity score</span>
          <b>{Math.max(0, Math.min(100, Math.round(balanceScore)))}%</b>
        </div>
        <div className="presence-track">
          <div
            className="presence-fill"
            style={{ width: `${Math.max(4, Math.min(100, Math.round(balanceScore)))}%` }}
          />
        </div>
        <div className="presence-equity-meta">
          <span>Quiet seats: <b>{quietCount}</b></span>
          <span>Top voice share: <b>{Math.max(0, Math.min(100, dominantSharePct))}%</b></span>
        </div>
      </div>

      <div className="presence-row">
        <span className="presence-kicker">Typing now</span>
        {typing.length ? (
          <span className="presence-typing">
            {typing.slice(0, 8).map((t) => t.emoji || '🙂').join(' ')}
          </span>
        ) : (
          <span className="presence-muted">No one typing right now</span>
        )}
      </div>

      <div className="presence-heat">
        {equityRows.length ? (
          equityRows.slice(0, 10).map((row) => (
            <div key={row.uid || row.label} className="presence-heat-row">
              <div className="presence-heat-head">
                <span>{row.label}</span>
                <span>{Number(row.messages || 0)} msg • {Math.max(0, Number(row.words || 0))} words</span>
              </div>
              <div className="presence-track">
                <div
                  className="presence-fill"
                  style={{ width: `${Math.max(2, Math.min(100, Number(row.sharePct || 0)))}%` }}
                />
              </div>
            </div>
          ))
        ) : null}
        {!contributionHeat.length ? (
          <div className="presence-muted">No contributions yet.</div>
        ) : (
          contributionHeat.slice(0, 8).map((row) => {
            const value = Math.max(0, Number(row.value || 0));
            const pct = stats.total > 0 ? Math.round((value / stats.total) * 100) : 0;
            return (
              <div key={row.label} className="presence-heat-row">
                <div className="presence-heat-head">
                  <span>{row.label}</span>
                  <span>{value}</span>
                </div>
                <div className="presence-track">
                  <div className="presence-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="presence-nudges">
        {quietCount > 0 ? (
          <div className="presence-nudge">
            Quiet participants: <b>{quietCount}</b>. Invite one line from each quieter voice.
          </div>
        ) : null}
        {(dominantSharePct >= 65 || stats.topShare >= 0.65) && stats.total >= 6 ? (
          <div className="presence-nudge">
            Turn balance prompt: one person is carrying most of the discussion. Rotate turns.
          </div>
        ) : null}
        {String(equity?.nudge || '').trim() ? (
          <div className="presence-nudge">{String(equity.nudge || '').trim()}</div>
        ) : null}
      </div>
    </section>
  );
}
