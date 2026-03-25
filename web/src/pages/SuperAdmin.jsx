import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, authHeaders, buildSseUrl, ensureGuest, setAuthSession } from '../api.js';
import { GaugeCard, MiniBarChart, SparklineCard } from '../components/AnalyticsCharts.jsx';
import { EmptyState, SkeletonCard } from '../components/LoadingSkeleton.jsx';

const SUPER_ADMIN_EMAIL = 'demetrious@hiddengeniusproject.org';

function toCsvList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatDateTime(value) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '-';
  }
}

async function apiRequest(path, options = {}) {
  const { method = 'GET', body } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    ...(await authHeaders()),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || json.message || `Request failed: ${res.status}`);
  }
  return { status: res.status, data: json };
}

async function safeGet(path, fallback) {
  try {
    const { data } = await apiRequest(path);
    return data;
  } catch {
    return fallback;
  }
}

export default function SuperAdmin() {
  const [authReady, setAuthReady] = useState(false);
  const [role, setRole] = useState(() => sessionStorage.getItem('role') || '');
  const [email, setEmail] = useState(
    () => sessionStorage.getItem('superAdminEmail') || SUPER_ADMIN_EMAIL
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [loading, setLoading] = useState(false);
  const [opsBusy, setOpsBusy] = useState(false);
  const [overview, setOverview] = useState(null);
  const [ops, setOps] = useState(null);
  const [codes, setCodes] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [licenses, setLicenses] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [statusEvents, setStatusEvents] = useState([]);
  const [healthAlerts, setHealthAlerts] = useState([]);
  const [reliability, setReliability] = useState(null);
  const [reliabilityAutomation, setReliabilityAutomation] = useState(null);

  const [genRole, setGenRole] = useState('PARTICIPANT');
  const [genSiteId, setGenSiteId] = useState('E1');
  const [genSiteIds, setGenSiteIds] = useState('');
  const [genLicenseId, setGenLicenseId] = useState('');
  const [genOrgId, setGenOrgId] = useState('');
  const [genMode, setGenMode] = useState('HIDDEN_GENIUS');
  const [genCount, setGenCount] = useState(20);
  const [genBusy, setGenBusy] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState([]);

  const [orgForm, setOrgForm] = useState({
    orgId: '',
    name: '',
    status: 'ACTIVE',
    tier: 'STARTER',
    supportPlan: 'STANDARD',
    siteIdsText: '',
  });
  const [licenseProvisionForm, setLicenseProvisionForm] = useState({
    orgId: '',
    licenseId: '',
    siteIdsText: '',
    status: 'ACTIVE',
    tier: 'STARTER',
    seatCap: 30,
    activeUserCap: 30,
    mode: 'HIDDEN_GENIUS',
    adminCodeCount: 5,
  });
  const [statusForm, setStatusForm] = useState({
    scopeId: 'GLOBAL',
    component: 'platform',
    severity: 'INFO',
    state: 'OPEN',
    incidentState: 'OPEN',
    message: '',
    link: '',
  });
  const [restoreDrillForm, setRestoreDrillForm] = useState({
    observedRtoMinutes: '',
    observedRpoMinutes: '',
    status: 'SUCCESS',
    notes: '',
  });
  const [approvalNotes, setApprovalNotes] = useState({});
  const [activeView, setActiveView] = useState('overview');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(0);
  const [codeSearch, setCodeSearch] = useState('');
  const [codeStatusFilter, setCodeStatusFilter] = useState('ALL');
  const [licenseSearch, setLicenseSearch] = useState('');
  const [orgSearch, setOrgSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const sseRefreshTimerRef = useRef(null);

  const isSuperAdmin = role === 'SUPER_ADMIN';

  const health = overview?.health || {};
  const stats = overview?.stats || {};
  const usersBySite = Array.isArray(overview?.usersBySite) ? overview.usersBySite : [];
  const currentUsers = Array.isArray(overview?.currentUsers) ? overview.currentUsers : [];
  const activeRooms = Array.isArray(overview?.activeRooms) ? overview.activeRooms : [];
  const opsCounts = ops?.counts || {};
  const reliabilitySnapshot = reliability || ops?.reliability || null;
  const displayedHealthAlerts = Array.isArray(healthAlerts) && healthAlerts.length
    ? healthAlerts
    : Array.isArray(ops?.healthAlerts)
    ? ops.healthAlerts
    : [];
  const seatCapTotal = licenses.reduce((sum, item) => sum + Number(item.seatCap || 0), 0);
  const activeUsers = Number(stats.usersActive ?? opsCounts.usersActive ?? currentUsers.length ?? 0);
  const consumedCodes = codes.filter((row) => row.consumed).length;
  const incidentBySeverity = useMemo(() => {
    const counts = statusEvents.reduce((acc, event) => {
      const key = event?.payload?.severity || 'INFO';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    return ['CRITICAL', 'HIGH', 'WARN', 'INFO'].map((label) => ({
      label,
      value: Number(counts[label] || 0),
    }));
  }, [statusEvents]);
  const codeRoleMix = useMemo(() => {
    const counts = codes.reduce((acc, code) => {
      const key = code.role || 'PARTICIPANT';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    return Object.keys(counts)
      .sort()
      .map((key) => ({ label: key, value: counts[key] }));
  }, [codes]);
  const activeRoomsBySite = useMemo(() => {
    const counts = activeRooms.reduce((acc, room) => {
      const site = (room.siteId || String(room.roomId || '').split('-')[0] || 'UNK').toUpperCase();
      acc[site] = Number(acc[site] || 0) + 1;
      return acc;
    }, {});
    return Object.keys(counts)
      .sort()
      .map((key) => ({ label: key, value: counts[key] }));
  }, [activeRooms]);

  useEffect(() => {
    let active = true;
    ensureGuest()
      .then(() => {
        if (!active) return;
        setRole(sessionStorage.getItem('role') || '');
        setAuthReady(true);
      })
      .catch((err) => {
        console.error('[SuperAdmin] ensureGuest failed', err);
        if (!active) return;
        setAuthReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      setLoading(true);
      const [
        overviewData,
        codesData,
        opsData,
        orgData,
        licenseData,
        approvalData,
        ticketData,
        statusData,
        healthAlertData,
        reliabilityData,
      ] = await Promise.all([
        safeGet('/super-admin/overview', {}),
        safeGet('/super-admin/codes?limit=250', { codes: [] }),
        safeGet('/super-admin/ops', {}),
        safeGet('/super-admin/orgs?status=ACTIVE&limit=200', { orgs: [] }),
        safeGet('/super-admin/licenses?status=ACTIVE&limit=250', { licenses: [] }),
        safeGet('/super-admin/approvals?status=PENDING&limit=250', { approvals: [] }),
        safeGet('/super-admin/support?status=OPEN&limit=250', { tickets: [] }),
        safeGet('/super-admin/status/events?scopeId=GLOBAL&limit=200', { events: [] }),
        safeGet('/super-admin/health/alerts?limit=60', { alerts: [] }),
        safeGet('/super-admin/reliability?limit=160', { reliability: null, alerts: [] }),
      ]);

      const openTickets = Array.isArray(ticketData.tickets) ? ticketData.tickets : [];
      const inProgressTickets = Array.isArray(opsData?.inProgressTickets)
        ? opsData.inProgressTickets
        : [];
      const allTickets = Array.from(
        [...openTickets, ...inProgressTickets]
          .reduce((acc, row) => {
            const key = `${row.orgId || ''}:${row.ticketId || ''}`;
            if (!acc.has(key)) acc.set(key, row);
            return acc;
          }, new Map())
          .values()
      );

      setOverview(overviewData);
      setCodes(Array.isArray(codesData.codes) ? codesData.codes : []);
      setOps(opsData);
      setOrgs(Array.isArray(orgData.orgs) ? orgData.orgs : []);
      setLicenses(Array.isArray(licenseData.licenses) ? licenseData.licenses : []);
      setApprovals(Array.isArray(approvalData.approvals) ? approvalData.approvals : []);
      setTickets(allTickets);
      setStatusEvents(Array.isArray(statusData.events) ? statusData.events : []);
      setHealthAlerts(Array.isArray(healthAlertData.alerts) ? healthAlertData.alerts : []);
      setReliability(reliabilityData.reliability || null);
      setReliabilityAutomation(reliabilityData.automation || null);
      setLastRefreshedAt(Date.now());
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load super admin dashboard.');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  const queueDashboardRefresh = useCallback(() => {
    if (sseRefreshTimerRef.current) return;
    sseRefreshTimerRef.current = setTimeout(() => {
      sseRefreshTimerRef.current = null;
      void loadDashboard();
    }, 450);
  }, [loadDashboard]);

  useEffect(() => {
    if (!authReady || !isSuperAdmin) return;
    void loadDashboard();
  }, [authReady, isSuperAdmin, loadDashboard]);

  useEffect(() => {
    if (!authReady || !isSuperAdmin || !autoRefresh) return;
    const es = new EventSource(buildSseUrl('/super-admin/events'));
    const onOpsUpdate = () => {
      queueDashboardRefresh();
    };
    es.addEventListener('ops_update', onOpsUpdate);
    es.onerror = () => {
      // Browser EventSource auto-reconnects.
    };
    return () => {
      es.removeEventListener('ops_update', onOpsUpdate);
      es.close();
      if (sseRefreshTimerRef.current) {
        clearTimeout(sseRefreshTimerRef.current);
        sseRefreshTimerRef.current = null;
      }
    };
  }, [authReady, isSuperAdmin, autoRefresh, queueDashboardRefresh]);

  async function login() {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) {
      setError('Email is required.');
      return;
    }
    if (normalized !== SUPER_ADMIN_EMAIL) {
      setError(`Only ${SUPER_ADMIN_EMAIL} is allowed.`);
      return;
    }

    try {
      setAuthBusy(true);
      setError('');
      setNotice('');
      const { data } = await apiRequest('/super-admin/auth/email', {
        method: 'POST',
        body: { email: normalized },
      });
      setAuthSession({
        token: data.token,
        userId: data.userId || sessionStorage.getItem('userId'),
        role: data.role || 'SUPER_ADMIN',
        email: normalized,
      });
      sessionStorage.setItem('superAdminEmail', normalized);
      setRole('SUPER_ADMIN');
      setNotice('Super admin authenticated.');
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Super admin login failed.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function generateCodes() {
    try {
      setGenBusy(true);
      setError('');
      const { data } = await apiRequest('/super-admin/codes/generate', {
        method: 'POST',
        body: {
          role: genRole,
          count: Number(genCount || 1),
          siteId: String(genSiteId || '').trim().toUpperCase(),
          siteIds: toCsvList(genSiteIds),
          licenseId: String(genLicenseId || '').trim().toUpperCase(),
          orgId: String(genOrgId || '').trim().toUpperCase(),
          defaultMode: String(genMode || '').trim().toUpperCase(),
        },
      });
      const next = Array.isArray(data.codes) ? data.codes : [];
      setGeneratedCodes(next);
      setNotice(`Generated ${next.length} code(s).`);
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Code generation failed.');
    } finally {
      setGenBusy(false);
    }
  }

  async function saveOrg() {
    if (!orgForm.orgId.trim()) {
      setError('orgId is required.');
      return;
    }
    try {
      setLoading(true);
      setError('');
      await apiRequest(`/super-admin/orgs/${encodeURIComponent(orgForm.orgId.trim().toUpperCase())}`, {
        method: 'PUT',
        body: {
          name: orgForm.name,
          status: orgForm.status,
          tier: orgForm.tier,
          supportPlan: orgForm.supportPlan,
          siteIds: toCsvList(orgForm.siteIdsText),
        },
      });
      setNotice(`Org ${orgForm.orgId.toUpperCase()} updated.`);
      setOrgForm({
        orgId: '',
        name: '',
        status: 'ACTIVE',
        tier: 'STARTER',
        supportPlan: 'STANDARD',
        siteIdsText: '',
      });
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to save org.');
    } finally {
      setLoading(false);
    }
  }

  async function provisionLicense() {
    if (!licenseProvisionForm.orgId.trim() || !licenseProvisionForm.licenseId.trim()) {
      setError('orgId and licenseId are required.');
      return;
    }
    try {
      setLoading(true);
      setError('');
      await apiRequest('/super-admin/licenses/provision', {
        method: 'POST',
        body: {
          orgId: licenseProvisionForm.orgId.trim().toUpperCase(),
          licenseId: licenseProvisionForm.licenseId.trim().toUpperCase(),
          siteIds: toCsvList(licenseProvisionForm.siteIdsText),
          status: licenseProvisionForm.status,
          tier: licenseProvisionForm.tier,
          seatCap: Number(licenseProvisionForm.seatCap || 1),
          activeUserCap: Number(licenseProvisionForm.activeUserCap || 1),
          mode: licenseProvisionForm.mode,
          adminCodeCount: Number(licenseProvisionForm.adminCodeCount || 0),
        },
      });
      setNotice(`Provisioned license ${licenseProvisionForm.licenseId.toUpperCase()}.`);
      setLicenseProvisionForm({
        orgId: '',
        licenseId: '',
        siteIdsText: '',
        status: 'ACTIVE',
        tier: 'STARTER',
        seatCap: 30,
        activeUserCap: 30,
        mode: 'HIDDEN_GENIUS',
        adminCodeCount: 5,
      });
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'License provision failed.');
    } finally {
      setLoading(false);
    }
  }

  async function updateLicenseStatus(licenseId, status) {
    try {
      setLoading(true);
      setError('');
      await apiRequest(`/super-admin/licenses/${encodeURIComponent(licenseId)}`, {
        method: 'PUT',
        body: { status },
      });
      setNotice(`License ${licenseId} set to ${status}.`);
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to update license.');
    } finally {
      setLoading(false);
    }
  }

  async function decideApproval(approval, decision) {
    try {
      setLoading(true);
      setError('');
      const key = `${approval.orgId}:${approval.approvalId}`;
      await apiRequest(
        `/super-admin/approvals/${encodeURIComponent(approval.orgId)}/${encodeURIComponent(approval.approvalId)}/decide`,
        {
          method: 'POST',
          body: {
            decision,
            note: approvalNotes[key] || '',
          },
        }
      );
      setNotice(`Approval ${approval.approvalId} marked ${decision}.`);
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to decide approval.');
    } finally {
      setLoading(false);
    }
  }

  async function updateTicketStatus(ticket, ticketStatus) {
    try {
      setLoading(true);
      setError('');
      const key = `${ticket.orgId}:${ticket.ticketId}`;
      await apiRequest(
        `/super-admin/support/${encodeURIComponent(ticket.orgId)}/${encodeURIComponent(ticket.ticketId)}/update`,
        {
          method: 'POST',
          body: {
            ticketStatus,
            note: approvalNotes[key] || '',
          },
        }
      );
      setNotice(`Ticket ${ticket.ticketId} set to ${ticketStatus}.`);
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to update ticket.');
    } finally {
      setLoading(false);
    }
  }

  async function autoEscalateOverdueTickets() {
    try {
      setOpsBusy(true);
      setError('');
      const { data } = await apiRequest('/super-admin/support/escalate-overdue', {
        method: 'POST',
        body: { maxPerStatus: 250 },
      });
      const escalated = Number(data.escalatedCount || 0);
      setNotice(escalated > 0 ? `Auto-escalated ${escalated} overdue ticket(s).` : 'No overdue tickets required escalation.');
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to auto-escalate overdue tickets.');
    } finally {
      setOpsBusy(false);
    }
  }

  async function logBackupCheckpoint(force = false) {
    try {
      setOpsBusy(true);
      setError('');
      await apiRequest('/super-admin/reliability/backup', {
        method: 'POST',
        body: { force: !!force },
      });
      setNotice(force ? 'Manual backup checkpoint logged.' : 'Backup checkpoint sync complete.');
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to log backup checkpoint.');
    } finally {
      setOpsBusy(false);
    }
  }

  async function logRestoreDrill() {
    const observedRtoMinutes = Number(restoreDrillForm.observedRtoMinutes || 0);
    const observedRpoMinutes = Number(restoreDrillForm.observedRpoMinutes || 0);
    if (!Number.isFinite(observedRtoMinutes) || observedRtoMinutes <= 0) {
      setError('Observed RTO minutes must be greater than zero.');
      return;
    }
    if (!Number.isFinite(observedRpoMinutes) || observedRpoMinutes <= 0) {
      setError('Observed RPO minutes must be greater than zero.');
      return;
    }
    try {
      setOpsBusy(true);
      setError('');
      await apiRequest('/super-admin/reliability/restore-drill', {
        method: 'POST',
        body: {
          observedRtoMinutes,
          observedRpoMinutes,
          status: restoreDrillForm.status,
          notes: restoreDrillForm.notes,
        },
      });
      setNotice('Restore drill logged.');
      setRestoreDrillForm({
        observedRtoMinutes: '',
        observedRpoMinutes: '',
        status: 'SUCCESS',
        notes: '',
      });
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to log restore drill.');
    } finally {
      setOpsBusy(false);
    }
  }

  async function createStatusEvent() {
    if (!statusForm.message.trim()) {
      setError('Status message is required.');
      return;
    }
    try {
      setLoading(true);
      setError('');
      await apiRequest('/super-admin/status/events', {
        method: 'POST',
        body: {
          scopeId: statusForm.scopeId,
          component: statusForm.component,
          severity: statusForm.severity,
          state: statusForm.state,
          incidentState: statusForm.incidentState,
          message: statusForm.message,
          link: statusForm.link,
        },
      });
      setNotice('Status event published.');
      setStatusForm({
        scopeId: 'GLOBAL',
        component: 'platform',
        severity: 'INFO',
        state: 'OPEN',
        incidentState: 'OPEN',
        message: '',
        link: '',
      });
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Failed to publish status event.');
    } finally {
      setLoading(false);
    }
  }

  const generatedText = useMemo(
    () =>
      generatedCodes
        .map((item) => `${item.code}  ${item.role}  ${item.siteId || ''}  ${item.licenseId || ''}`)
        .join('\n'),
    [generatedCodes]
  );

  const filteredCodes = useMemo(() => {
    const query = String(codeSearch || '').trim().toUpperCase();
    return codes.filter((row) => {
      const status = row.revoked
        ? 'REVOKED'
        : row.consumed
        ? 'CONSUMED'
        : row.expired
        ? 'EXPIRED'
        : 'ACTIVE';
      if (codeStatusFilter !== 'ALL' && status !== codeStatusFilter) return false;
      if (!query) return true;
      return [
        row.code,
        row.role,
        row.siteId,
        row.licenseId,
        row.orgId,
        row.usedBy,
      ]
        .map((value) => String(value || '').toUpperCase())
        .some((value) => value.includes(query));
    });
  }, [codes, codeSearch, codeStatusFilter]);

  const filteredLicenses = useMemo(() => {
    const query = String(licenseSearch || '').trim().toUpperCase();
    if (!query) return licenses;
    return licenses.filter((row) =>
      [
        row.licenseId,
        row.orgId,
        row.status,
        row.tier,
      ]
        .map((value) => String(value || '').toUpperCase())
        .some((value) => value.includes(query))
    );
  }, [licenses, licenseSearch]);

  const filteredOrgs = useMemo(() => {
    const query = String(orgSearch || '').trim().toUpperCase();
    if (!query) return orgs;
    return orgs.filter((row) =>
      [
        row.orgId,
        row.name,
        row.status,
        row.tier,
        row.supportPlan,
      ]
        .map((value) => String(value || '').toUpperCase())
        .some((value) => value.includes(query))
    );
  }, [orgs, orgSearch]);

  const filteredCurrentUsers = useMemo(() => {
    const query = String(userSearch || '').trim().toUpperCase();
    if (!query) return currentUsers;
    return currentUsers.filter((row) =>
      [
        row.uid,
        row.role,
        row.siteId,
      ]
        .map((value) => String(value || '').toUpperCase())
        .some((value) => value.includes(query))
    );
  }, [currentUsers, userSearch]);

  const supportTicketRows = useMemo(
    () =>
      (Array.isArray(tickets) ? tickets : [])
        .slice()
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
    [tickets]
  );

  const platformWarnings = useMemo(() => {
    const out = [];
    const apiOk = health.apiOk || ops?.health?.apiOk;
    if (!apiOk) out.push('API health check is failing.');
    if (!(health.openaiEnabled || ops?.health?.openaiEnabled)) {
      out.push('OpenAI provider is disabled.');
    }
    if (Number(opsCounts.incidentsOpen || 0) > 0) {
      out.push(`${opsCounts.incidentsOpen} incident(s) currently open.`);
    }
    if (Number(opsCounts.approvalsPending || 0) > 0) {
      out.push(`${opsCounts.approvalsPending} approval request(s) pending.`);
    }
    if (displayedHealthAlerts.length > 0) {
      out.push(`${displayedHealthAlerts.length} health alert(s) require review.`);
    }
    return out;
  }, [health, ops, opsCounts, displayedHealthAlerts]);

  if (!authReady) {
    return (
      <div className="center-wrap">
        <div className="glass">Loading super admin console…</div>
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <>
        <div className="heatmap-bg" />
        <div className="grain" />
        <div className="center-wrap">
          <div className="glass superadmin-login-card">
            <div className="brand">
              <div className="brand-badge">SUPER ADMIN</div>
              <div className="brand-title">Platform Operations Console</div>
            </div>
            <div className="brand-sub mt12">
              Access is restricted to the approved super-admin email: <b>{SUPER_ADMIN_EMAIL}</b>.
            </div>

            <div className="mt16">
              <label className="form-label-muted">AUTHORIZED EMAIL</label>
              <input
                className="input mt6"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => (e.key === 'Enter' ? login() : null)}
                placeholder={SUPER_ADMIN_EMAIL}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                disabled={authBusy}
              />
            </div>

            {error && <div className="mt12 text-danger">{error}</div>}
            {notice && <div className="mt12 text-success">{notice}</div>}

            <div className="row mt16 wrap">
              <button className="btn primary" onClick={login} disabled={authBusy}>
                {authBusy ? 'Authenticating…' : 'Enter Operations Console'}
              </button>
              <a href="/" className="btn ghost link-plain">
                Back to app
              </a>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (loading && !overview) {
    return (
      <>
        <div className="heatmap-bg" />
        <div className="grain" />
        <div className="room-wrap page-max-1280">
          <div className="glass glass-full">
            <div className="brand">
              <div className="brand-badge">SUPER ADMIN</div>
              <div className="brand-title">Loading platform operations…</div>
            </div>
            <div className="analytics-grid mt16">
              <SkeletonCard rows={4} />
              <SkeletonCard rows={4} />
              <SkeletonCard rows={4} />
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="heatmap-bg" />
      <div className="grain" />
      <div className="room-wrap page-reveal page-max-1320">
        <div className="glass glass-full">
          <div className="brand brand-between">
            <div>
              <div className="brand-badge">SUPER ADMIN</div>
              <div className="brand-title">Platform Operations Console</div>
            </div>
            <div className="meta-muted-right">
              <div>Email: <b>{sessionStorage.getItem('superAdminEmail') || SUPER_ADMIN_EMAIL}</b></div>
              <div>Region: <b>{health.region || ops?.health?.region || '—'}</b></div>
            </div>
          </div>

          <div className="row mt12 wrap">
            <button className="btn" onClick={loadDashboard} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh Data'}
            </button>
            <label className="row text-muted-12">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
                Live updates (SSE)
              </label>
            <span className="text-muted-12">
              Last refresh:{' '}
              <b>{lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleTimeString() : '—'}</b>
            </span>
            <a href="/admin" className="btn ghost link-plain">
              Open Org Admin
            </a>
            <a href="/trust-center" className="btn ghost link-plain">
              Trust Center
            </a>
          </div>

          <div className="row mt12 wrap">
            <button
              className={`btn ${activeView === 'overview' ? 'primary' : 'ghost'}`}
              onClick={() => setActiveView('overview')}
            >
              Overview
            </button>
            <button
              className={`btn ${activeView === 'access' ? 'primary' : 'ghost'}`}
              onClick={() => setActiveView('access')}
            >
              Codes
            </button>
            <button
              className={`btn ${activeView === 'tenants' ? 'primary' : 'ghost'}`}
              onClick={() => setActiveView('tenants')}
            >
              Tenants
            </button>
            <button
              className={`btn ${activeView === 'ops' ? 'primary' : 'ghost'}`}
              onClick={() => setActiveView('ops')}
            >
              Incidents
            </button>
          </div>

          {error && <div className="mt12 text-danger">{error}</div>}
          {notice && <div className="mt12 text-success">{notice}</div>}
          {platformWarnings.length ? (
            <div className="mt12 panel-warning">
              <div className="panel-warning-title">Needs Attention</div>
              {platformWarnings.map((warning) => (
                <div key={warning} className="panel-warning-line">{warning}</div>
              ))}
            </div>
          ) : null}

          <div className="mt16 status-chip-grid">
            <div className="status-chip">API: <b>{health.apiOk || ops?.health?.apiOk ? 'OK' : '—'}</b></div>
            <div className="status-chip">OpenAI: <b>{health.openaiEnabled || ops?.health?.openaiEnabled ? 'Enabled' : 'Disabled'}</b></div>
            <div className="status-chip">Active Users: <b>{activeUsers}</b></div>
            <div className="status-chip">Open Rooms: <b>{stats.roomsActive ?? 0}</b></div>
            <div className="status-chip">Codes Used: <b>{consumedCodes}</b></div>
            <div className="status-chip">Orgs Active: <b>{opsCounts.orgsActive ?? 0}</b></div>
            <div className="status-chip">Licenses Active: <b>{opsCounts.licensesActive ?? 0}</b></div>
            <div className="status-chip">Approvals Pending: <b>{opsCounts.approvalsPending ?? 0}</b></div>
            <div className="status-chip">Tickets Open: <b>{opsCounts.ticketsOpen ?? 0}</b></div>
            <div className="status-chip">Tickets Overdue SLA: <b>{opsCounts.overdueSupport ?? 0}</b></div>
            <div className="status-chip">Incidents Open: <b>{opsCounts.incidentsOpen ?? 0}</b></div>
            <div className="status-chip">Health Alerts: <b>{displayedHealthAlerts.length}</b></div>
          </div>

          <div className="analytics-grid mt16">
            <GaugeCard
              title="Seat Utilization"
              value={activeUsers}
              max={seatCapTotal || 1}
              subtitle="Active users vs licensed seat cap"
              tone="leaf"
            />
            <GaugeCard
              title="Code Usage"
              value={consumedCodes}
              max={codes.length || 1}
              subtitle="Consumed vs issued access codes"
              tone="persimmon"
            />
            <MiniBarChart
              title="Active Rooms by Site"
              items={activeRoomsBySite}
              emptyLabel="No active rooms."
              tone="sunflower"
            />
            <MiniBarChart
              title="Incident Severity"
              items={incidentBySeverity}
              emptyLabel="No incident events yet."
              tone="persimmon"
            />
            <MiniBarChart
              title="Code Mix by Role"
              items={codeRoleMix}
              emptyLabel="No codes generated yet."
              tone="leaf"
            />
            <SparklineCard
              title="Room Load Trend"
              values={usersBySite.map((row) => Number(row.openRooms || 0))}
              subtitle="Open rooms sampled by site"
            />
          </div>

          {activeView === 'access' ? (
            <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Generate Access Codes</div>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                <select className="select" value={genRole} onChange={(e) => setGenRole(e.target.value)}>
                  <option value="PARTICIPANT">PARTICIPANT</option>
                  <option value="PRESENTER">PRESENTER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
                <input className="input" value={genSiteId} onChange={(e) => setGenSiteId(e.target.value.toUpperCase())} placeholder="Primary Site" />
                <input className="input" value={genSiteIds} onChange={(e) => setGenSiteIds(e.target.value)} placeholder="Sites E1,E2" />
                <input className="input" type="number" min="1" max="500" value={genCount} onChange={(e) => setGenCount(e.target.value)} placeholder="Count" />
                <input className="input" value={genLicenseId} onChange={(e) => setGenLicenseId(e.target.value.toUpperCase())} placeholder="License ID" />
                <input className="input" value={genOrgId} onChange={(e) => setGenOrgId(e.target.value.toUpperCase())} placeholder="Org ID" />
                <select className="select" value={genMode} onChange={(e) => setGenMode(e.target.value)}>
                  <option value="HIDDEN_GENIUS">HIDDEN_GENIUS</option>
                  <option value="CREATIVE_WRITING">CREATIVE_WRITING</option>
                  <option value="PROJECT_IDEATION">PROJECT_IDEATION</option>
                  <option value="RESTORATIVE_CIRCLE">RESTORATIVE_CIRCLE</option>
                </select>
                <button className="btn primary" onClick={generateCodes} disabled={genBusy}>{genBusy ? 'Generating…' : 'Generate'}</button>
              </div>
              {generatedText ? (
                <div className="row mt6">
                  <textarea className="input" rows={4} value={generatedText} readOnly />
                  <button className="btn" onClick={() => copyText(generatedText)}>Copy</button>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeView === 'tenants' ? (
            <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Organization and License Management</div>
              <div className="row mt6 wrap">
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  value={licenseSearch}
                  onChange={(e) => setLicenseSearch(e.target.value)}
                  placeholder="Filter licenses"
                />
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  value={orgSearch}
                  onChange={(e) => setOrgSearch(e.target.value)}
                  placeholder="Filter orgs"
                />
              </div>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Update Org</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <input className="input" value={orgForm.orgId} onChange={(e) => setOrgForm((p) => ({ ...p, orgId: e.target.value }))} placeholder="ORG-XXXX" />
                  <input className="input" value={orgForm.name} onChange={(e) => setOrgForm((p) => ({ ...p, name: e.target.value }))} placeholder="Org name" />
                  <input className="input" value={orgForm.siteIdsText} onChange={(e) => setOrgForm((p) => ({ ...p, siteIdsText: e.target.value }))} placeholder="Sites E1,E2" />
                  <select className="select" value={orgForm.status} onChange={(e) => setOrgForm((p) => ({ ...p, status: e.target.value }))}>
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                    <option value="INACTIVE">INACTIVE</option>
                  </select>
                  <select className="select" value={orgForm.tier} onChange={(e) => setOrgForm((p) => ({ ...p, tier: e.target.value }))}>
                    <option value="STARTER">STARTER</option>
                    <option value="PRO">PRO</option>
                    <option value="ENTERPRISE">ENTERPRISE</option>
                  </select>
                  <select className="select" value={orgForm.supportPlan} onChange={(e) => setOrgForm((p) => ({ ...p, supportPlan: e.target.value }))}>
                    <option value="STANDARD">STANDARD</option>
                    <option value="PREMIUM">PREMIUM</option>
                    <option value="ENTERPRISE">ENTERPRISE</option>
                  </select>
                  <button className="btn" onClick={saveOrg} disabled={loading}>Save Org</button>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Provision License</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <input className="input" value={licenseProvisionForm.orgId} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, orgId: e.target.value }))} placeholder="Org ID" />
                  <input className="input" value={licenseProvisionForm.licenseId} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, licenseId: e.target.value }))} placeholder="License ID" />
                  <input className="input" value={licenseProvisionForm.siteIdsText} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, siteIdsText: e.target.value }))} placeholder="Sites E1,E2" />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <select className="select" value={licenseProvisionForm.status} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, status: e.target.value }))}>
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="SUSPENDED">SUSPENDED</option>
                      <option value="EXPIRED">EXPIRED</option>
                      <option value="TRIAL">TRIAL</option>
                    </select>
                    <select className="select" value={licenseProvisionForm.tier} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, tier: e.target.value }))}>
                      <option value="STARTER">STARTER</option>
                      <option value="PRO">PRO</option>
                      <option value="ENTERPRISE">ENTERPRISE</option>
                    </select>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <input className="input" type="number" min="1" value={licenseProvisionForm.seatCap} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, seatCap: e.target.value }))} placeholder="Seat cap" />
                    <input className="input" type="number" min="1" value={licenseProvisionForm.activeUserCap} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, activeUserCap: e.target.value }))} placeholder="Active cap" />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <select className="select" value={licenseProvisionForm.mode} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, mode: e.target.value }))}>
                      <option value="HIDDEN_GENIUS">HIDDEN_GENIUS</option>
                      <option value="CREATIVE_WRITING">CREATIVE_WRITING</option>
                      <option value="PROJECT_IDEATION">PROJECT_IDEATION</option>
                      <option value="RESTORATIVE_CIRCLE">RESTORATIVE_CIRCLE</option>
                    </select>
                    <input className="input" type="number" min="0" value={licenseProvisionForm.adminCodeCount} onChange={(e) => setLicenseProvisionForm((p) => ({ ...p, adminCodeCount: e.target.value }))} placeholder="Admin codes" />
                  </div>
                  <button className="btn" onClick={provisionLicense} disabled={loading}>Provision License</button>
                </div>
              </div>
            </div>

            <div className="mt12" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>License</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Org</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Tier</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Seats</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLicenses.map((license) => (
                    <tr key={license.licenseId}>
                      <td style={{ padding: 8 }}>{license.licenseId}</td>
                      <td style={{ padding: 8 }}>{license.orgId || '—'}</td>
                      <td style={{ padding: 8 }}>{license.status}</td>
                      <td style={{ padding: 8 }}>{license.tier}</td>
                      <td style={{ padding: 8 }}>{license.seatCap || 0}</td>
                      <td style={{ padding: 8 }}>
                        <div className="row wrap">
                          <button className="btn" onClick={() => updateLicenseStatus(license.licenseId, 'ACTIVE')} disabled={loading}>Activate</button>
                          <button className="btn" onClick={() => updateLicenseStatus(license.licenseId, 'SUSPENDED')} disabled={loading}>Suspend</button>
                          <button className="btn" onClick={() => updateLicenseStatus(license.licenseId, 'EXPIRED')} disabled={loading}>Expire</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!filteredLicenses.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={6}>No licenses loaded.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            </div>
          ) : null}

          {activeView === 'ops' ? (
            <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Approvals, Support, Reliability, and Health Alerts</div>
              <div className="row mt6 wrap">
                <button className="btn" onClick={autoEscalateOverdueTickets} disabled={loading || opsBusy}>
                  {opsBusy ? 'Running…' : 'Auto-Escalate Overdue Tickets'}
                </button>
                <button className="btn" onClick={() => logBackupCheckpoint(false)} disabled={loading || opsBusy}>
                  Sync Backup Checkpoint
                </button>
                <button className="btn" onClick={() => logBackupCheckpoint(true)} disabled={loading || opsBusy}>
                  Log Manual Backup
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Pending Approvals</div>
                  <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: 8 }}>ID</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Org</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Type</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Decision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {approvals.map((approval) => {
                          const key = `${approval.orgId}:${approval.approvalId}`;
                          return (
                            <tr key={approval.approvalId}>
                              <td style={{ padding: 8 }}>{approval.approvalId}</td>
                              <td style={{ padding: 8 }}>{approval.orgId}</td>
                              <td style={{ padding: 8 }}>{approval.requestType || '—'}</td>
                              <td style={{ padding: 8 }}>
                                <textarea
                                  className="input"
                                  rows={2}
                                  value={approvalNotes[key] || ''}
                                  onChange={(e) =>
                                    setApprovalNotes((prev) => ({ ...prev, [key]: e.target.value }))
                                  }
                                  placeholder="Decision note"
                                />
                                <div className="row mt6">
                                  <button className="btn" onClick={() => decideApproval(approval, 'APPROVED')} disabled={loading || opsBusy}>Approve</button>
                                  <button className="btn" onClick={() => decideApproval(approval, 'REJECTED')} disabled={loading || opsBusy}>Reject</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {!approvals.length ? (
                          <tr><td style={{ padding: 8 }} colSpan={4}>No pending approvals.</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Support Tickets</div>
                  <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: 8 }}>Ticket</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Priority</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>SLA</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Esc.</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Response Due</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Resolution Due</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {supportTicketRows.map((ticket) => {
                          const key = `${ticket.orgId}:${ticket.ticketId}`;
                          return (
                            <tr key={`${ticket.orgId}:${ticket.ticketId}`}>
                              <td style={{ padding: 8 }}>{ticket.ticketId}</td>
                              <td style={{ padding: 8 }}>{ticket.ticketStatus}</td>
                              <td style={{ padding: 8 }}>{ticket.priority}</td>
                              <td style={{ padding: 8, color: ticket.slaBreached ? 'var(--tone-persimmon)' : 'inherit' }}>
                                {ticket.slaState || '-'}
                              </td>
                              <td style={{ padding: 8 }}>{ticket.escalationLevel || 0}</td>
                              <td style={{ padding: 8 }}>{formatDateTime(ticket.responseDueAt)}</td>
                              <td style={{ padding: 8 }}>{formatDateTime(ticket.resolutionDueAt)}</td>
                              <td style={{ padding: 8 }}>
                                <textarea
                                  className="input"
                                  rows={2}
                                  value={approvalNotes[key] || ''}
                                  onChange={(e) =>
                                    setApprovalNotes((prev) => ({ ...prev, [key]: e.target.value }))
                                  }
                                  placeholder="Support note"
                                />
                                <div className="row mt6">
                                  <button className="btn" onClick={() => updateTicketStatus(ticket, 'IN_PROGRESS')} disabled={loading || opsBusy}>In Progress</button>
                                  <button className="btn" onClick={() => updateTicketStatus(ticket, 'ESCALATED')} disabled={loading || opsBusy}>Escalate</button>
                                  <button className="btn" onClick={() => updateTicketStatus(ticket, 'RESOLVED')} disabled={loading || opsBusy}>Resolve</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {!supportTicketRows.length ? (
                          <tr><td style={{ padding: 8 }} colSpan={8}>No open or in-progress tickets.</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="mt12" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ border: '1px solid rgba(148,163,184,.3)', borderRadius: 10, padding: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Reliability Program</div>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    RTO target: <b>{reliabilitySnapshot?.targets?.rtoMinutes ?? '-'}</b> min
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    RPO target: <b>{reliabilitySnapshot?.targets?.rpoMinutes ?? '-'}</b> min
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    Backup mode: <b>{String(reliabilityAutomation?.mode || 'checkpoint').toUpperCase()}</b>
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    Last backup: <b>{formatDateTime(reliabilitySnapshot?.latestBackup?.updatedAt || reliabilitySnapshot?.latestBackup?.createdAt)}</b>
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    Last restore drill: <b>{formatDateTime(reliabilitySnapshot?.latestRestoreDrill?.updatedAt || reliabilitySnapshot?.latestRestoreDrill?.createdAt)}</b>
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>
                    Next drill due: <b>{formatDateTime(reliabilitySnapshot?.nextDrillDueAt)}</b>
                  </div>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>Runbooks</div>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>
                    {(Array.isArray(reliabilitySnapshot?.runbooks) ? reliabilitySnapshot.runbooks : [])
                      .slice(0, 6)
                      .map((item) => (
                        <div key={item.id}>
                          <b>{item.title}</b>: <code>{item.path}</code>
                        </div>
                      ))}
                  </div>
                  <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 1fr' }}>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      value={restoreDrillForm.observedRtoMinutes}
                      onChange={(e) => setRestoreDrillForm((p) => ({ ...p, observedRtoMinutes: e.target.value }))}
                      placeholder="Observed RTO (min)"
                    />
                    <input
                      className="input"
                      type="number"
                      min="1"
                      value={restoreDrillForm.observedRpoMinutes}
                      onChange={(e) => setRestoreDrillForm((p) => ({ ...p, observedRpoMinutes: e.target.value }))}
                      placeholder="Observed RPO (min)"
                    />
                    <select
                      className="select"
                      value={restoreDrillForm.status}
                      onChange={(e) => setRestoreDrillForm((p) => ({ ...p, status: e.target.value }))}
                    >
                      <option value="SUCCESS">SUCCESS</option>
                      <option value="PARTIAL">PARTIAL</option>
                      <option value="FAILED">FAILED</option>
                    </select>
                  </div>
                  <textarea
                    className="input mt6"
                    rows={2}
                    value={restoreDrillForm.notes}
                    onChange={(e) => setRestoreDrillForm((p) => ({ ...p, notes: e.target.value }))}
                    placeholder="Restore drill notes"
                  />
                  <div className="row mt6">
                    <button className="btn" onClick={logRestoreDrill} disabled={loading || opsBusy}>
                      Log Restore Drill
                    </button>
                  </div>
                </div>

                <div style={{ border: '1px solid rgba(148,163,184,.3)', borderRadius: 10, padding: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Health Alerts</div>
                  <div style={{ maxHeight: 220, overflow: 'auto' }}>
                    {displayedHealthAlerts.slice(0, 40).map((alert) => (
                      <div
                        key={alert.id}
                        style={{
                          fontSize: 12,
                          padding: '6px 0',
                          borderBottom: '1px solid rgba(148,163,184,.2)',
                        }}
                      >
                        <b>{alert.severity}</b> [{alert.category}] {alert.message}
                        <div style={{ opacity: 0.75 }}>{alert.action}</div>
                      </div>
                    ))}
                    {!displayedHealthAlerts.length ? (
                      <EmptyState
                        title="No health alerts"
                        subtitle="All monitored reliability/support/governance checks are clear."
                      />
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="mt12" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
                <input className="input" value={statusForm.scopeId} onChange={(e) => setStatusForm((p) => ({ ...p, scopeId: e.target.value.toUpperCase() }))} placeholder="GLOBAL" />
                <input className="input" value={statusForm.component} onChange={(e) => setStatusForm((p) => ({ ...p, component: e.target.value }))} placeholder="Component" />
                <select className="select" value={statusForm.severity} onChange={(e) => setStatusForm((p) => ({ ...p, severity: e.target.value }))}>
                  <option value="INFO">INFO</option>
                  <option value="WARN">WARN</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
                <select className="select" value={statusForm.state} onChange={(e) => setStatusForm((p) => ({ ...p, state: e.target.value }))}>
                  <option value="OPEN">OPEN</option>
                  <option value="MONITORING">MONITORING</option>
                  <option value="RESOLVED">RESOLVED</option>
                </select>
                <select className="select" value={statusForm.incidentState} onChange={(e) => setStatusForm((p) => ({ ...p, incidentState: e.target.value }))}>
                  <option value="OPEN">OPEN</option>
                  <option value="MONITORING">MONITORING</option>
                  <option value="RESOLVED">RESOLVED</option>
                </select>
                <input className="input" value={statusForm.link} onChange={(e) => setStatusForm((p) => ({ ...p, link: e.target.value }))} placeholder="Link" />
              </div>
              <textarea className="input mt6" rows={2} value={statusForm.message} onChange={(e) => setStatusForm((p) => ({ ...p, message: e.target.value }))} placeholder="Status incident message" />
              <div className="row mt6">
                <button className="btn" onClick={createStatusEvent} disabled={loading || opsBusy}>Publish Status Event</button>
              </div>

              <div className="mt6" style={{ maxHeight: 140, overflow: 'auto' }}>
                {statusEvents.slice(0, 30).map((event) => (
                  <div key={`${event.scopeId}:${event.statusKey}`} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,.2)' }}>
                    <b>{event.payload?.severity || 'INFO'}</b> {event.payload?.incidentState || event.payload?.state || 'OPEN'} - {event.payload?.message || event.statusKey}
                  </div>
                ))}
                {!statusEvents.length ? (
                  <EmptyState
                    title="No status events"
                    subtitle="Publish an incident update to start your public timeline."
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {activeView === 'overview' ? (
            <div className="mt16" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Users By Site</div>
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Site</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Users</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Open Rooms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usersBySite.map((row) => (
                        <tr key={row.siteId}>
                          <td style={{ padding: 8 }}>{row.siteId}</td>
                          <td style={{ padding: 8 }}>{row.users}</td>
                          <td style={{ padding: 8 }}>{row.openRooms}</td>
                        </tr>
                      ))}
                      {!usersBySite.length ? <tr><td style={{ padding: 8 }} colSpan={3}>No site data.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Current Users</div>
                <input
                  className="input"
                  style={{ marginBottom: 6 }}
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Filter users by id, role, or site"
                />
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>User</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Role</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Site</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Last Seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCurrentUsers.map((row) => (
                        <tr key={row.uid}>
                          <td style={{ padding: 8 }}>{row.uid}</td>
                          <td style={{ padding: 8 }}>{row.role || '—'}</td>
                          <td style={{ padding: 8 }}>{row.siteId || '—'}</td>
                          <td style={{ padding: 8 }}>{row.lastSeenIso || '—'}</td>
                        </tr>
                      ))}
                      {!filteredCurrentUsers.length ? <tr><td style={{ padding: 8 }} colSpan={4}>No current users.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          {activeView === 'overview' || activeView === 'access' ? (
            <div className="mt16">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                {activeView === 'access' ? 'Recent Codes' : 'Active Rooms + Recent Codes'}
              </div>
              <div className="row mt6 wrap">
                <input
                  className="input"
                  style={{ maxWidth: 320 }}
                  value={codeSearch}
                  onChange={(e) => setCodeSearch(e.target.value)}
                  placeholder="Filter codes by id, role, site, license"
                />
                <select
                  className="select"
                  style={{ maxWidth: 180 }}
                  value={codeStatusFilter}
                  onChange={(e) => setCodeStatusFilter(e.target.value)}
                >
                  <option value="ALL">ALL STATUS</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="CONSUMED">CONSUMED</option>
                  <option value="REVOKED">REVOKED</option>
                  <option value="EXPIRED">EXPIRED</option>
                </select>
              </div>
              <div
                style={{
                  display: 'grid',
                  gap: 14,
                  gridTemplateColumns:
                    activeView === 'access' ? '1fr' : '1fr 1fr',
                }}
              >
                {activeView === 'overview' ? (
                  <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: 8 }}>Room</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Stage</th>
                          <th style={{ textAlign: 'left', padding: 8 }}>Seats</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeRooms.map((room) => (
                          <tr key={room.roomId}>
                            <td style={{ padding: 8 }}>{room.roomId}</td>
                            <td style={{ padding: 8 }}>{room.stage}</td>
                            <td style={{ padding: 8 }}>{room.seats}</td>
                          </tr>
                        ))}
                        {!activeRooms.length ? <tr><td style={{ padding: 8 }} colSpan={3}>No active rooms.</td></tr> : null}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8 }}>Code</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Role</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Site</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>License</th>
                        <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCodes.map((row) => {
                        const status = row.revoked
                          ? 'REVOKED'
                          : row.consumed
                          ? 'CONSUMED'
                          : row.expired
                          ? 'EXPIRED'
                          : 'ACTIVE';
                        return (
                          <tr key={row.code}>
                            <td style={{ padding: 8 }}>{row.code}</td>
                            <td style={{ padding: 8 }}>{row.role}</td>
                            <td style={{ padding: 8 }}>{row.siteId || '—'}</td>
                            <td style={{ padding: 8 }}>{row.licenseId || '—'}</td>
                            <td style={{ padding: 8 }}>{status}</td>
                          </tr>
                        );
                      })}
                      {!filteredCodes.length ? <tr><td style={{ padding: 8 }} colSpan={5}>No code data found.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          {activeView === 'overview' || activeView === 'tenants' ? (
            <div className="mt16">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Org Snapshot</div>
              <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 8 }}>Org ID</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Tier</th>
                      <th style={{ textAlign: 'left', padding: 8 }}>Support Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOrgs.map((org) => (
                      <tr key={org.orgId}>
                        <td style={{ padding: 8 }}>{org.orgId}</td>
                        <td style={{ padding: 8 }}>{org.status}</td>
                        <td style={{ padding: 8 }}>{org.tier}</td>
                        <td style={{ padding: 8 }}>{org.supportPlan || 'STANDARD'}</td>
                      </tr>
                    ))}
                    {!filteredOrgs.length ? <tr><td style={{ padding: 8 }} colSpan={4}>No org data found.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
