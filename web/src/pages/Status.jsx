import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, buildSseUrl } from '../api.js';

function formatPercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function formatDate(ts) {
  const n = Number(ts || 0);
  if (!n) return '—';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '—';
  }
}

function severityTone(severityRaw) {
  const severity = String(severityRaw || '').trim().toUpperCase();
  if (severity === 'SEV1' || severity === 'CRITICAL' || severity === 'HIGH') return '#8a2e18';
  if (severity === 'SEV2' || severity === 'MEDIUM') return '#705112';
  return '#355120';
}

function availabilityTone(statusRaw) {
  const status = String(statusRaw || '').trim().toUpperCase();
  if (status === 'OPERATIONAL') {
    return {
      text: '#355120',
      fill: 'rgba(95, 127, 55, 0.72)',
    };
  }
  if (status === 'DEGRADED') {
    return {
      text: '#7f311c',
      fill: 'rgba(219, 90, 50, 0.68)',
    };
  }
  return {
    text: '#6f4f14',
    fill: 'rgba(244, 200, 76, 0.76)',
  };
}

export default function Status() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const requestSeqRef = useRef(0);

  const loadStatus = useCallback(async () => {
    const seq = Number(requestSeqRef.current || 0) + 1;
    requestSeqRef.current = seq;
    try {
      const trustRes = await fetch(`${API_BASE}/trust-center`);
      if (trustRes.ok) {
        const trustJson = await trustRes.json().catch(() => ({}));
        if (requestSeqRef.current !== seq) return;
        setSnapshot(trustJson);
        setError('');
        return;
      }

      const fallbackRes = await fetch(`${API_BASE}/status`);
      const fallbackJson = await fallbackRes.json().catch(() => ({}));
      if (!fallbackRes.ok) {
        throw new Error(fallbackJson.error || 'status_fetch_failed');
      }
      if (requestSeqRef.current !== seq) return;
      setSnapshot({
        brand: 'StoriBloom Trust Center',
        securityDocuments: [],
        subprocessors: [],
        uptime30d: { availabilityPercent: fallbackJson.availability30dPercent || 0, daily: [] },
        incidentPostmortems: [],
        ...fallbackJson,
      });
      setError('');
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      setError(err.message || 'Could not load trust center.');
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadStatus();

    const es = new EventSource(buildSseUrl('/status/events/stream'));
    const onUpdate = () => {
      if (!active) return;
      void loadStatus();
    };
    es.addEventListener('status_update', onUpdate);

    return () => {
      active = false;
      es.removeEventListener('status_update', onUpdate);
      es.close();
    };
  }, [loadStatus]);

  const statusLabel = snapshot?.status || 'UNKNOWN';
  const statusColor = availabilityTone(statusLabel).text;

  const events = Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [];
  const incidents = Array.isArray(snapshot?.incidents) ? snapshot.incidents : [];
  const docs = Array.isArray(snapshot?.securityDocuments) ? snapshot.securityDocuments : [];
  const subprocessors = Array.isArray(snapshot?.subprocessors) ? snapshot.subprocessors : [];
  const uptimeDaily = Array.isArray(snapshot?.uptime30d?.daily) ? snapshot.uptime30d.daily : [];
  const postmortems = Array.isArray(snapshot?.incidentPostmortems)
    ? snapshot.incidentPostmortems
    : [];

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />
      <div className="room-wrap page-max-1100">
        <div className="glass glass-full">
          <div className="brand brand-between">
            <div>
              <div className="brand-badge">TRUST CENTER</div>
              <div className="brand-title">{snapshot?.brand || 'StoriBloom Trust Center'}</div>
            </div>
            <a href="/" className="btn ghost link-plain">
              Back to app
            </a>
          </div>

          {loading ? <div className="mt12">Loading trust center…</div> : null}
          {error ? <div className="mt12 text-danger">{error}</div> : null}

          {!loading && !error ? (
            <>
              <div className="mt16 status-chip-grid status-chip-grid-4">
                <div className="status-chip">
                  System Status: <b style={{ color: statusColor }}>{statusLabel}</b>
                </div>
                <div className="status-chip">
                  Open Incidents: <b>{snapshot?.unresolvedIncidents || 0}</b>
                </div>
                <div className="status-chip">
                  Availability (30d): <b>{formatPercent(snapshot?.uptime30d?.availabilityPercent)}%</b>
                </div>
                <div className="status-chip">
                  Escalation: <b>{snapshot?.supportEscalationEmail || 'support@storibloom.app'}</b>
                </div>
              </div>

              <div className="mt16 section-divider">
                <div className="section-title">Security + Compliance Documents</div>
                <div className="row wrap">
                  {docs.map((doc) => (
                    <a
                      key={doc.id}
                      href={doc.url}
                      target={String(doc.url || '').startsWith('http') ? '_blank' : undefined}
                      rel={String(doc.url || '').startsWith('http') ? 'noreferrer' : undefined}
                      className="btn link-plain"
                    >
                      {doc.label}
                    </a>
                  ))}
                  {!docs.length ? (
                    <div className="text-muted-12">
                      Security docs links are not configured yet.
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt16 section-divider">
                <div className="section-title">Subprocessors</div>
                <div className="table-wrap table-wrap-sm">
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Vendor</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Purpose</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Region</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subprocessors.map((row) => (
                        <tr key={`${row.name}-${row.purpose}`}>
                          <td style={{ padding: 8 }}>{row.name}</td>
                          <td style={{ padding: 8 }}>{row.purpose || '—'}</td>
                          <td style={{ padding: 8 }}>{row.region || '—'}</td>
                        </tr>
                      ))}
                      {!subprocessors.length ? (
                        <tr><td style={{ padding: 8 }} colSpan={3}>No subprocessors listed.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt16 section-divider">
                <div className="section-title">Uptime (Last 30 Days)</div>
                <div className="uptime-grid">
                  {uptimeDaily.map((day) => {
                    const tone = availabilityTone(day.status);
                    return (
                      <div
                        key={day.date}
                        title={`${day.date} - ${day.status} (${day.incidents || 0} incidents)`}
                        style={{
                          height: 28,
                          borderRadius: 7,
                          background: `linear-gradient(145deg, ${tone.fill}, rgba(255, 249, 234, 0.78))`,
                          border: '1px solid rgba(106, 84, 53, 0.24)',
                        }}
                      />
                    );
                  })}
                  {!uptimeDaily.length ? (
                    <div className="text-muted-12">No uptime history yet.</div>
                  ) : null}
                </div>
              </div>

              <div className="mt16 section-divider">
                <div className="section-title">Open Incidents</div>
                <div className="table-wrap table-wrap-md">
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Severity</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>State</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {incidents.map((incident) => (
                        <tr key={`${incident.scopeId}:${incident.statusKey}`}>
                          <td style={{ padding: 8, color: severityTone(incident.payload?.severity) }}>
                            {incident.payload?.severity || 'INFO'}
                          </td>
                          <td style={{ padding: 8 }}>{incident.payload?.incidentState || incident.payload?.state || 'OPEN'}</td>
                          <td style={{ padding: 8 }}>{incident.payload?.message || incident.statusKey}</td>
                        </tr>
                      ))}
                      {!incidents.length ? (
                        <tr><td style={{ padding: 8 }} colSpan={3}>No open incidents.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt16 section-divider">
                <div className="section-title">Incident Postmortems</div>
                <div className="table-wrap table-wrap-sm">
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Time</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Severity</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Incident</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Report</th>
                      </tr>
                    </thead>
                    <tbody>
                      {postmortems.map((event) => (
                        <tr key={`${event.scopeId}:${event.statusKey}:${event.resolvedAt || 0}`}>
                          <td style={{ padding: 8 }}>{formatDate(event.resolvedAt)}</td>
                          <td style={{ padding: 8, color: severityTone(event.severity) }}>{event.severity || 'INFO'}</td>
                          <td style={{ padding: 8 }}>{event.message}</td>
                          <td style={{ padding: 8 }}>
                            {event.postmortemUrl ? (
                              <a href={event.postmortemUrl} target="_blank" rel="noreferrer">
                                Postmortem
                              </a>
                            ) : (
                              'Pending'
                            )}
                          </td>
                        </tr>
                      ))}
                      {!postmortems.length ? (
                        <tr><td style={{ padding: 8 }} colSpan={4}>No postmortems published yet.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt16">
                <div className="section-title">Recent Events</div>
                <div className="table-wrap table-wrap-lg">
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Time</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Severity</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>State</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event) => (
                        <tr key={`${event.scopeId}:${event.statusKey}`}>
                          <td style={{ padding: 8 }}>
                            {event.updatedAt ? new Date(event.updatedAt).toLocaleString() : '—'}
                          </td>
                          <td style={{ padding: 8, color: severityTone(event.payload?.severity) }}>
                            {event.payload?.severity || 'INFO'}
                          </td>
                          <td style={{ padding: 8 }}>{event.payload?.incidentState || event.payload?.state || 'OPEN'}</td>
                          <td style={{ padding: 8 }}>{event.payload?.message || event.statusKey}</td>
                        </tr>
                      ))}
                      {!events.length ? (
                        <tr><td style={{ padding: 8 }} colSpan={4}>No events available.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
