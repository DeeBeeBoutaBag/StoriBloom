import React, { useEffect, useMemo, useState } from 'react';
import { API_BASE, authHeaders, ensureGuest, setAuthSession } from '../api.js';
import CopilotPanel from '../components/CopilotPanel.jsx';
import { GaugeCard, MiniBarChart, SparklineCard } from '../components/AnalyticsCharts.jsx';
import { EmptyState, SkeletonCard } from '../components/LoadingSkeleton.jsx';

function listToMultiline(values) {
  if (!Array.isArray(values)) return '';
  return values.join('\n');
}

function listToCsv(values) {
  if (!Array.isArray(values)) return '';
  return values.join(', ');
}

function parseCsv(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function parseLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensurePhaseCount(phases, count) {
  const n = Math.max(1, Number(count || 1));
  const next = Array.isArray(phases) ? phases.slice(0, n) : [];
  while (next.length < n) {
    next.push({
      id: `phase-${next.length + 1}`,
      title: `Phase ${next.length + 1}`,
      durationMin: 10,
      goal: '',
    });
  }
  return next.map((phase, idx) => ({
    id: phase.id || `phase-${idx + 1}`,
    title: phase.title || `Phase ${idx + 1}`,
    durationMin: Number(phase.durationMin || 10),
    goal: phase.goal || '',
  }));
}

const ORG_SIZE_PRESETS = {
  SMALL: {
    label: 'Small Team (up to 30)',
    expectedUsers: 24,
    activeUserCap: 30,
    seatLimitPerRoom: 6,
    phaseCount: 5,
    seatCap: 30,
    usageCap: 180,
    tier: 'STARTER',
    aiBehavior: 'GUIDE',
    siteCount: 1,
  },
  MID: {
    label: 'Growing Org (30-120)',
    expectedUsers: 72,
    activeUserCap: 100,
    seatLimitPerRoom: 8,
    phaseCount: 6,
    seatCap: 120,
    usageCap: 520,
    tier: 'PRO',
    aiBehavior: 'HELPER',
    siteCount: 2,
  },
  LARGE: {
    label: 'Enterprise (120+)',
    expectedUsers: 180,
    activeUserCap: 240,
    seatLimitPerRoom: 10,
    phaseCount: 7,
    seatCap: 260,
    usageCap: 1800,
    tier: 'ENTERPRISE',
    aiBehavior: 'BACKGROUND',
    siteCount: 4,
  },
};

function workshopToForm(workshop) {
  const phasesRaw = Array.isArray(workshop?.phases) ? workshop.phases : [];
  const phases = phasesRaw.map((phase, idx) => ({
    id: phase.id || `phase-${idx + 1}`,
    title: phase.title || `Phase ${idx + 1}`,
    durationMin: Math.max(1, Math.round(Number(phase.durationSec || 600) / 60)),
    goal: phase.goal || '',
  }));
  return {
    name: workshop?.name || '',
    mode: workshop?.mode || 'HIDDEN_GENIUS',
    description: workshop?.description || '',
    siteIdsText: listToCsv(workshop?.siteIds || []),
    expectedUsers: Number(workshop?.expectedUsers || 30),
    activeUserCap: Number(workshop?.activeUserCap || workshop?.expectedUsers || 30),
    seatLimitPerRoom: Number(workshop?.seatLimitPerRoom || 6),
    aiBehavior: workshop?.aiBehavior || 'GUIDE',
    phaseCount: phases.length || Number(workshop?.phaseCount || 1),
    phases: ensurePhaseCount(phases, phases.length || Number(workshop?.phaseCount || 1)),
    topicCatalogText: listToMultiline(workshop?.topicCatalog || []),
    enableTopicVoting: !!workshop?.enableTopicVoting,
    assistantPersona: workshop?.assistantPersona || '',
  };
}

function emptyWorkshopForm() {
  return workshopToForm(null);
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

export default function Admin() {
  const [authReady, setAuthReady] = useState(false);
  const [role, setRole] = useState(() => sessionStorage.getItem('role') || '');
  const [licenseId, setLicenseId] = useState(() => sessionStorage.getItem('licenseId') || '');
  const [orgId, setOrgId] = useState(() => sessionStorage.getItem('orgId') || '');
  const [code, setCode] = useState('');

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [modes, setModes] = useState([]);
  const [workshopForm, setWorkshopForm] = useState(emptyWorkshopForm());
  const [consoleSnapshot, setConsoleSnapshot] = useState(null);

  const [userForm, setUserForm] = useState({
    userId: '',
    email: '',
    name: '',
    role: 'PARTICIPANT',
    siteIdsText: '',
    notes: '',
  });
  const [licenseForm, setLicenseForm] = useState({
    status: 'ACTIVE',
    tier: 'STARTER',
    seatCap: 30,
    activeUserCap: 30,
    usageCap: 240,
    renewDays: 0,
    siteIdsText: '',
  });
  const [flagDraft, setFlagDraft] = useState({});
  const [policyDraft, setPolicyDraft] = useState({
    tone: 'BALANCED',
    strictness: 'MEDIUM',
    dataUsage: 'NO_TRAINING',
    modelChoice: 'gpt-4.1-mini',
    piiRedaction: true,
    citationMode: false,
    ageSafeMode: 'K12',
    moderationLevel: 'STANDARD',
    blockedTermsText: '',
  });
  const [retentionDraft, setRetentionDraft] = useState({
    messageRetentionDays: 90,
    draftRetentionDays: 365,
    sessionRetentionHours: 24,
    auditRetentionDays: 365,
    legalHold: false,
  });
  const [templateForm, setTemplateForm] = useState({
    templateId: '',
    name: '',
    mode: 'HIDDEN_GENIUS',
    description: '',
  });
  const [templateVersionInputs, setTemplateVersionInputs] = useState({});
  const [billingForm, setBillingForm] = useState({
    amountCents: 0,
    currency: 'USD',
    description: '',
  });
  const [supportForm, setSupportForm] = useState({
    subject: '',
    description: '',
    priority: 'P3',
    escalate: false,
  });
  const [codeGenForm, setCodeGenForm] = useState({
    role: 'PARTICIPANT',
    count: 12,
    siteIdsText: '',
    expiresDays: 30,
  });
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem('admin_onboarding_done') !== '1';
  });
  const [orgPreset, setOrgPreset] = useState('MID');
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('admin_view_mode') || 'ops');

  const isAdmin = role === 'ADMIN';
  const adminOpsMode = viewMode === 'ops';

  useEffect(() => {
    localStorage.setItem('admin_view_mode', viewMode);
  }, [viewMode]);

  const featureFlagKeys = useMemo(
    () => Object.keys(consoleSnapshot?.featureFlags?.effective || {}).sort(),
    [consoleSnapshot]
  );

  const users = Array.isArray(consoleSnapshot?.users) ? consoleSnapshot.users : [];
  const templates = Array.isArray(consoleSnapshot?.templates) ? consoleSnapshot.templates : [];
  const approvals = Array.isArray(consoleSnapshot?.approvals) ? consoleSnapshot.approvals : [];
  const billingEvents = Array.isArray(consoleSnapshot?.billingEvents)
    ? consoleSnapshot.billingEvents
    : [];
  const supportTickets = Array.isArray(consoleSnapshot?.supportTickets)
    ? consoleSnapshot.supportTickets
    : [];
  const codes = Array.isArray(consoleSnapshot?.codes) ? consoleSnapshot.codes : [];

  const usage = consoleSnapshot?.usage || {};
  const org = consoleSnapshot?.org || {};
  const license = consoleSnapshot?.license || {};
  const workshop = consoleSnapshot?.workshop || {};
  const billingSummary = consoleSnapshot?.billingSummary || {};
  const outcomes = consoleSnapshot?.outcomes || {};
  const seatCap = Number(license.seatCap || licenseForm.seatCap || workshop.expectedUsers || 0);
  const assignedSeats = Number(usage.assignedSeats || 0);
  const openSupportCount = supportTickets.filter((ticket) => ticket.ticketStatus !== 'RESOLVED').length;
  const availableCodeCount = codes.filter(
    (codeRow) => !codeRow.consumed && !codeRow.revoked && !codeRow.expired
  ).length;
  const consumedCodeCount = codes.filter((codeRow) => !!codeRow.consumed).length;
  const meteredUnits = Number(billingSummary?.usage?.meteredUnits || 0);
  const usageCap = Number(billingSummary?.entitlements?.usageCap || license.usageCap || 0);
  const overageUnits = Number(billingSummary?.overage?.units || 0);
  const projectedOverageUsd = Number(
    billingSummary?.overage?.projectedAmountUsd || 0
  );
  const outcomeOrg = outcomes?.org || {};
  const outcomeBySite = Array.isArray(outcomes?.bySite) ? outcomes.bySite : [];
  const outcomeTrend = Array.isArray(outcomes?.trendline) ? outcomes.trendline : [];
  const aiUsageSeries = billingEvents
    .slice(0, 8)
    .reverse()
    .map((event) => Number(event.amountCents || 0) / 100);
  const sessionScoreSeries = outcomeTrend.map((entry) =>
    Number(entry?.sessionScore || 0)
  );

  const usersByRoleChart = useMemo(() => {
    const counts = users.reduce((acc, user) => {
      const key = user.role || 'PARTICIPANT';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    return Object.keys(counts)
      .sort()
      .map((key) => ({ label: key, value: counts[key] }));
  }, [users]);

  const usersBySiteChart = useMemo(() => {
    const counts = users.reduce((acc, user) => {
      const siteIds = Array.isArray(user.siteIds) && user.siteIds.length ? user.siteIds : ['UNASSIGNED'];
      siteIds.forEach((siteId) => {
        const key = String(siteId || 'UNASSIGNED').toUpperCase();
        acc[key] = Number(acc[key] || 0) + 1;
      });
      return acc;
    }, {});
    return Object.keys(counts)
      .sort()
      .map((key) => ({ label: key, value: counts[key] }));
  }, [users]);

  const incidentByPriorityChart = useMemo(() => {
    const counts = supportTickets.reduce((acc, ticket) => {
      const key = ticket.priority || 'P3';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    return ['P1', 'P2', 'P3', 'P4'].map((label) => ({ label, value: Number(counts[label] || 0) }));
  }, [supportTickets]);

  useEffect(() => {
    let active = true;
    ensureGuest()
      .then(() => {
        if (!active) return;
        setRole(sessionStorage.getItem('role') || '');
        setLicenseId(sessionStorage.getItem('licenseId') || '');
        setOrgId(sessionStorage.getItem('orgId') || '');
        setAuthReady(true);
      })
      .catch((err) => {
        console.error('[Admin] ensureGuest failed', err);
        if (!active) return;
        setAuthReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authReady || !isAdmin) return;
    loadModes();
    loadConsole();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, isAdmin]);

  useEffect(() => {
    const effective = consoleSnapshot?.featureFlags?.effective || {};
    setFlagDraft(effective);
  }, [consoleSnapshot?.featureFlags?.effective]);

  useEffect(() => {
    const policy = consoleSnapshot?.aiPolicy;
    if (!policy) return;
    setPolicyDraft({
      tone: policy.tone || 'BALANCED',
      strictness: policy.strictness || 'MEDIUM',
      dataUsage: policy.dataUsage || 'NO_TRAINING',
      modelChoice: policy.modelChoice || 'gpt-4.1-mini',
      piiRedaction: policy.piiRedaction !== false,
      citationMode: !!policy.citationMode,
      ageSafeMode: policy.ageSafeMode || 'K12',
      moderationLevel: policy.moderationLevel || 'STANDARD',
      blockedTermsText: listToMultiline(policy.blockedTerms || []),
    });
  }, [consoleSnapshot?.aiPolicy]);

  useEffect(() => {
    const workshopSettings = consoleSnapshot?.workshop;
    if (!workshopSettings) return;
    setRetentionDraft({
      messageRetentionDays: Number(workshopSettings.messageRetentionDays || 90),
      draftRetentionDays: Number(workshopSettings.draftRetentionDays || 365),
      sessionRetentionHours: Number(workshopSettings.sessionRetentionHours || 24),
      auditRetentionDays: Number(workshopSettings.auditRetentionDays || 365),
      legalHold: !!workshopSettings.legalHold,
    });
  }, [consoleSnapshot?.workshop]);

  useEffect(() => {
    if (!consoleSnapshot) return;
    const hasSavedWorkshop = Boolean(consoleSnapshot?.workshop?.updatedAt);
    if (!hasSavedWorkshop) {
      setOnboardingOpen(true);
    }
  }, [consoleSnapshot]);

  function updateWorkshopForm(key, value) {
    setWorkshopForm((prev) => ({ ...prev, [key]: value }));
  }

  function updatePhase(index, key, value) {
    setWorkshopForm((prev) => {
      const phases = prev.phases.slice();
      const current = phases[index] || {
        id: `phase-${index + 1}`,
        title: `Phase ${index + 1}`,
        durationMin: 10,
        goal: '',
      };
      phases[index] = { ...current, [key]: value };
      return { ...prev, phases };
    });
  }

  function setPhaseCount(nextCount) {
    setWorkshopForm((prev) => {
      const phaseCount = Math.max(1, Math.min(24, Number(nextCount || 1)));
      return {
        ...prev,
        phaseCount,
        phases: ensurePhaseCount(prev.phases, phaseCount),
      };
    });
  }

  function applyOrgPreset(presetKey) {
    const preset = ORG_SIZE_PRESETS[presetKey] || ORG_SIZE_PRESETS.MID;
    const siteIds = parseCsv(workshopForm.siteIdsText);
    const defaultSiteIds = siteIds.length
      ? siteIds
      : Array.from({ length: preset.siteCount }, (_, idx) => `E${idx + 1}`);

    setWorkshopForm((prev) => {
      const basePhases = ensurePhaseCount(prev.phases, preset.phaseCount);
      const tunedPhases = basePhases.map((phase, idx) => ({
        ...phase,
        durationMin: Math.max(6, Math.round(preset.expectedUsers / 24) + idx + 7),
      }));
      return {
        ...prev,
        expectedUsers: preset.expectedUsers,
        activeUserCap: preset.activeUserCap,
        seatLimitPerRoom: preset.seatLimitPerRoom,
        phaseCount: preset.phaseCount,
        phases: tunedPhases,
        siteIdsText: defaultSiteIds.join(', '),
        aiBehavior: preset.aiBehavior,
      };
    });

    setLicenseForm((prev) => ({
      ...prev,
      tier: preset.tier,
      seatCap: preset.seatCap,
      activeUserCap: preset.activeUserCap,
      usageCap: preset.usageCap,
      siteIdsText: defaultSiteIds.join(', '),
    }));

    setNotice(`Applied smart defaults: ${preset.label}. Review and save when ready.`);
  }

  function completeOnboarding() {
    setOnboardingOpen(false);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('admin_onboarding_done', '1');
    }
  }

  async function loadModes() {
    try {
      const { data } = await apiRequest('/admin/workshop/modes');
      setModes(Array.isArray(data.modes) ? data.modes : []);
    } catch (err) {
      console.warn('[Admin] loadModes failed', err);
    }
  }

  async function loadConsole() {
    try {
      setBusy(true);
      setError('');
      const { data } = await apiRequest('/admin/console');
      setConsoleSnapshot(data);
      setWorkshopForm(workshopToForm(data.workshop || null));
      const resolvedSiteIdsText = listToCsv(data.workshop?.siteIds || data.org?.siteIds || []);
      setLicenseForm({
        status: data.license?.status || 'ACTIVE',
        tier: data.license?.tier || 'STARTER',
        seatCap: Number(data.license?.seatCap || data.workshop?.expectedUsers || 30),
        activeUserCap: Number(
          data.license?.activeUserCap || data.workshop?.activeUserCap || data.workshop?.expectedUsers || 30
        ),
        usageCap: Number(data.license?.usageCap || 240),
        renewDays: 0,
        siteIdsText: resolvedSiteIdsText,
      });
      setCodeGenForm((prev) => ({
        ...prev,
        siteIdsText: prev.siteIdsText || resolvedSiteIdsText,
      }));
      setLicenseId(data.license?.licenseId || sessionStorage.getItem('licenseId') || '');
      setOrgId(data.org?.orgId || sessionStorage.getItem('orgId') || '');
      if (data.license?.licenseId) sessionStorage.setItem('licenseId', data.license.licenseId);
      if (data.org?.orgId) sessionStorage.setItem('orgId', data.org.orgId);
    } catch (err) {
      setError(err.message || 'Could not load admin console.');
    } finally {
      setBusy(false);
    }
  }

  async function loginAsAdmin() {
    if (!code.trim()) {
      setError('Enter your admin license code.');
      return;
    }
    try {
      setBusy(true);
      setError('');
      setNotice('');
      const { data } = await apiRequest('/admin/auth/consume', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setAuthSession({
        token: data.token,
        userId: data.userId || sessionStorage.getItem('userId'),
        role: data.role || 'ADMIN',
        licenseId: data.licenseId || '',
        orgId: data.orgId || '',
      });
      setRole('ADMIN');
      setLicenseId(data.licenseId || '');
      setOrgId(data.orgId || '');
      setCode('');
      setNotice('Admin access granted.');
      await loadModes();
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Admin login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkshop() {
    try {
      setSaving(true);
      setError('');
      setNotice('');
      const payload = {
        name: workshopForm.name.trim(),
        mode: workshopForm.mode,
        description: workshopForm.description.trim(),
        siteIds: parseCsv(workshopForm.siteIdsText),
        expectedUsers: Number(workshopForm.expectedUsers || 1),
        activeUserCap: Number(workshopForm.activeUserCap || workshopForm.expectedUsers || 1),
        seatLimitPerRoom: Number(workshopForm.seatLimitPerRoom || 1),
        aiBehavior: workshopForm.aiBehavior,
        phaseCount: Number(workshopForm.phaseCount || 1),
        phases: ensurePhaseCount(workshopForm.phases, workshopForm.phaseCount).map((phase, idx) => ({
          id: phase.id || `phase-${idx + 1}`,
          title: String(phase.title || `Phase ${idx + 1}`).trim(),
          durationSec: Math.max(60, Math.round(Number(phase.durationMin || 10) * 60)),
          goal: String(phase.goal || '').trim(),
        })),
        topicCatalog: parseLines(workshopForm.topicCatalogText),
        enableTopicVoting: !!workshopForm.enableTopicVoting,
        assistantPersona: String(workshopForm.assistantPersona || '').trim(),
      };
      await apiRequest('/admin/workshop', { method: 'PUT', body: payload });
      setNotice('Workshop settings saved.');
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to save workshop settings.');
    } finally {
      setSaving(false);
    }
  }

  async function saveUser() {
    try {
      const userId = String(userForm.userId || '').trim() || `email:${String(userForm.email || '').trim().toLowerCase()}`;
      if (!userId || !userForm.email.trim()) {
        setError('User ID or email is required.');
        return;
      }
      setSaving(true);
      setError('');
      const { data } = await apiRequest(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: {
          email: userForm.email.trim(),
          name: userForm.name.trim(),
          role: userForm.role,
          siteIds: parseCsv(userForm.siteIdsText),
          notes: userForm.notes,
          active: true,
        },
      });
      setNotice(`Saved user ${data.user?.email || userId}.`);
      setUserForm({
        userId: '',
        email: '',
        name: '',
        role: 'PARTICIPANT',
        siteIdsText: '',
        notes: '',
      });
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to save user.');
    } finally {
      setSaving(false);
    }
  }

  async function deactivateUser(userId) {
    try {
      setSaving(true);
      setError('');
      await apiRequest(`/admin/users/${encodeURIComponent(userId)}/deactivate`, {
        method: 'POST',
      });
      setNotice(`Deactivated ${userId}.`);
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to deactivate user.');
    } finally {
      setSaving(false);
    }
  }

  async function saveSites() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/sites', {
        method: 'PUT',
        body: {
          siteIds: parseCsv(licenseForm.siteIdsText),
        },
      });
      setNotice('Sites updated.');
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to update sites.');
    } finally {
      setSaving(false);
    }
  }

  async function saveLicense() {
    try {
      setSaving(true);
      setError('');
      const { data } = await apiRequest('/admin/license', {
        method: 'PUT',
        body: {
          seatCap: Number(licenseForm.seatCap || 1),
          activeUserCap: Number(licenseForm.activeUserCap || 1),
          usageCap: Number(licenseForm.usageCap || 1),
          renewDays: Number(licenseForm.renewDays || 0),
        },
      });
      if (data.approvalRequired && data.approval?.approvalId) {
        setNotice(`License change submitted for approval: ${data.approval.approvalId}`);
      } else {
        setNotice('License updated.');
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to update license.');
    } finally {
      setSaving(false);
    }
  }

  async function saveFlags() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/feature-flags', {
        method: 'PUT',
        body: {
          scope: 'ORG',
          flags: flagDraft,
        },
      });
      setNotice('Feature flags saved.');
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to save feature flags.');
    } finally {
      setSaving(false);
    }
  }

  async function savePolicy() {
    try {
      setSaving(true);
      setError('');
      const policyPayload = {
        ...policyDraft,
        blockedTerms: parseLines(policyDraft.blockedTermsText),
      };
      const { data } = await apiRequest('/admin/policies/ai', {
        method: 'PUT',
        body: {
          policy: policyPayload,
        },
      });
      if (data.approvalRequired && data.approval?.approvalId) {
        setNotice(`AI policy change submitted for approval: ${data.approval.approvalId}`);
      } else {
        setNotice('AI policy saved.');
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to save AI policy.');
    } finally {
      setSaving(false);
    }
  }

  async function saveRetention() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/retention', {
        method: 'PUT',
        body: {
          messageRetentionDays: Number(retentionDraft.messageRetentionDays || 1),
          draftRetentionDays: Number(retentionDraft.draftRetentionDays || 1),
          sessionRetentionHours: Number(retentionDraft.sessionRetentionHours || 1),
          auditRetentionDays: Number(retentionDraft.auditRetentionDays || 1),
          legalHold: !!retentionDraft.legalHold,
        },
      });
      setNotice('Retention policy saved.');
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to save retention policy.');
    } finally {
      setSaving(false);
    }
  }

  async function createTemplate() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/templates', {
        method: 'POST',
        body: {
          templateId: templateForm.templateId.trim() || undefined,
          name: templateForm.name.trim() || undefined,
          mode: templateForm.mode,
          description: templateForm.description.trim(),
        },
      });
      setNotice('Template draft created.');
      setTemplateForm({
        templateId: '',
        name: '',
        mode: 'HIDDEN_GENIUS',
        description: '',
      });
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to create template.');
    } finally {
      setSaving(false);
    }
  }

  async function publishTemplate(templateId) {
    const version = Number(templateVersionInputs[templateId] || 0);
    try {
      setSaving(true);
      setError('');
      const { data } = await apiRequest(`/admin/templates/${encodeURIComponent(templateId)}/publish`, {
        method: 'POST',
        body: version ? { version } : {},
      });
      if (data.approvalRequired && data.approval?.approvalId) {
        setNotice(`Template publish submitted for approval: ${data.approval.approvalId}`);
      } else {
        setNotice(`Template ${templateId} published.`);
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to publish template.');
    } finally {
      setSaving(false);
    }
  }

  async function deprecateTemplate(templateId) {
    const version = Number(templateVersionInputs[templateId] || 0);
    if (!version) {
      setError('Provide a version number to deprecate.');
      return;
    }
    try {
      setSaving(true);
      setError('');
      const { data } = await apiRequest(`/admin/templates/${encodeURIComponent(templateId)}/deprecate`, {
        method: 'POST',
        body: { version },
      });
      if (data.approvalRequired && data.approval?.approvalId) {
        setNotice(`Template deprecation submitted for approval: ${data.approval.approvalId}`);
      } else {
        setNotice(`Template ${templateId} v${version} deprecated.`);
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to deprecate template.');
    } finally {
      setSaving(false);
    }
  }

  async function rollbackTemplate(templateId) {
    const toVersion = Number(templateVersionInputs[templateId] || 0);
    if (!toVersion) {
      setError('Provide the version to roll back to.');
      return;
    }
    try {
      setSaving(true);
      setError('');
      const { data } = await apiRequest(`/admin/templates/${encodeURIComponent(templateId)}/rollback`, {
        method: 'POST',
        body: { toVersion },
      });
      if (data.approvalRequired && data.approval?.approvalId) {
        setNotice(`Template rollback submitted for approval: ${data.approval.approvalId}`);
      } else {
        setNotice(`Template ${templateId} rolled back to v${toVersion}.`);
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to roll back template.');
    } finally {
      setSaving(false);
    }
  }

  async function createInvoice() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/billing/invoices', {
        method: 'POST',
        body: {
          amountCents: Number(billingForm.amountCents || 0),
          currency: billingForm.currency || 'USD',
          description: billingForm.description || '',
        },
      });
      setNotice('Invoice request sent.');
      setBillingForm({ amountCents: 0, currency: 'USD', description: '' });
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to create invoice.');
    } finally {
      setSaving(false);
    }
  }

  async function runBillingCycleNow() {
    try {
      setSaving(true);
      setError('');
      setNotice('');
      const { data } = await apiRequest('/admin/billing/run-cycle', {
        method: 'POST',
      });
      const overage = Number(data?.summary?.overage?.units || 0);
      if (overage > 0) {
        setNotice(
          `Billing cycle updated. Overage: ${overage} units, projected ${Number(
            data?.summary?.overage?.projectedAmountUsd || 0
          ).toFixed(2)} USD.`
        );
      } else {
        setNotice('Billing cycle updated. You are within entitlement limits.');
      }
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to run billing cycle.');
    } finally {
      setSaving(false);
    }
  }

  async function createSupportTicket() {
    try {
      setSaving(true);
      setError('');
      await apiRequest('/admin/support/tickets', {
        method: 'POST',
        body: {
          subject: supportForm.subject,
          description: supportForm.description,
          priority: supportForm.priority,
          escalate: !!supportForm.escalate,
        },
      });
      setNotice('Support ticket created.');
      setSupportForm({
        subject: '',
        description: '',
        priority: 'P3',
        escalate: false,
      });
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to create support ticket.');
    } finally {
      setSaving(false);
    }
  }

  async function generateCodes() {
    try {
      setSaving(true);
      setError('');
      setNotice('');
      const siteIds = parseCsv(codeGenForm.siteIdsText);
      if (!siteIds.length) {
        setError('Add at least one site ID for code generation.');
        return;
      }
      const expiresDays = Math.max(1, Number(codeGenForm.expiresDays || 30));
      const expiresAt = Date.now() + expiresDays * 24 * 60 * 60 * 1000;
      const { data } = await apiRequest('/admin/codes/generate', {
        method: 'POST',
        body: {
          role: codeGenForm.role,
          count: Number(codeGenForm.count || 1),
          siteIds,
          defaultMode: workshopForm.mode,
          expiresAt,
        },
      });
      setNotice(`Generated ${data.count || 0} ${codeGenForm.role.toLowerCase()} code(s).`);
      await loadConsole();
    } catch (err) {
      setError(err.message || 'Failed to generate codes.');
    } finally {
      setSaving(false);
    }
  }

  const copilotSuggestions = [
    {
      id: 'policy-tighten',
      title: 'Tighten policy guardrails',
      description: 'Switch to coach tone, high strictness, and citation mode.',
      successText: 'Policy draft updated. Save AI policy to apply.',
      onApply: () => {
        setPolicyDraft((prev) => ({
          ...prev,
          tone: 'COACH',
          strictness: 'HIGH',
          citationMode: true,
          piiRedaction: true,
          ageSafeMode: 'K12',
          moderationLevel: 'STRICT',
        }));
      },
    },
    {
      id: 'phase-tune',
      title: 'Tune phase pacing',
      description: 'Balance phase timing for collaborative cohorts.',
      successText: 'Workshop phase plan tuned. Save workshop to apply.',
      onApply: () => applyOrgPreset(orgPreset),
    },
    {
      id: 'template-nudge',
      title: 'Template tuning draft',
      description: 'Draft a stronger narrative template description.',
      successText: 'Template draft updated.',
      onApply: () => {
        setTemplateForm((prev) => ({
          ...prev,
          mode: workshopForm.mode || prev.mode,
          description:
            'Frame the workshop around lived experience, concrete community impacts, and one action-forward ending.',
        }));
      },
    },
  ];

  const modeOptions = modes.length
    ? modes
    : [
        { id: 'HIDDEN_GENIUS', label: 'Hidden Genius Project' },
        { id: 'CREATIVE_WRITING', label: 'Creative Writing' },
        { id: 'PROJECT_IDEATION', label: 'Project Ideation' },
        { id: 'RESTORATIVE_CIRCLE', label: 'Restorative Circle' },
      ];

  if (!authReady) {
    return (
      <div className="center-wrap">
        <div className="glass">Loading admin workspace…</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <div className="heatmap-bg" />
        <div className="grain" />
        <div className="center-wrap">
          <div className="glass admin-login-card">
            <div className="brand">
              <div className="brand-badge">ORG ADMIN</div>
              <div className="brand-title">Organization Admin Console</div>
            </div>
            <div className="brand-sub mt12">
              Enter your admin code to manage users, workshop settings, licenses, billing, and support for your organization.
            </div>
            <div className="mt16">
              <label className="form-label-muted">ADMIN LICENSE CODE</label>
              <input
                className="input mt6"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="A-XXXXX"
                onKeyDown={(e) => (e.key === 'Enter' ? loginAsAdmin() : null)}
                disabled={busy}
              />
            </div>

            {error && <div className="mt12 text-danger">{error}</div>}
            {notice && <div className="mt12 text-success">{notice}</div>}

            <div className="row mt16">
              <button className="btn primary" onClick={loginAsAdmin} disabled={busy}>
                {busy ? 'Checking code…' : 'Open Admin Console'}
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

  if (busy && !consoleSnapshot) {
    return (
      <>
        <div className="heatmap-bg" />
        <div className="grain" />
        <div className="room-wrap page-max-1280">
          <div className="glass glass-full">
            <div className="brand">
              <div className="brand-badge">ORG ADMIN</div>
              <div className="brand-title">Loading workspace…</div>
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
              <div className="brand-badge">ORG ADMIN</div>
              <div className="brand-title">Organization Admin Console</div>
            </div>
            <div className="meta-muted-right">
              <div>Org: <b>{orgId || org.orgId || '—'}</b></div>
              <div>License: <b>{licenseId || license.licenseId || '—'}</b></div>
            </div>
          </div>

          <div className="row mt12 wrap">
            <button className="btn" onClick={loadConsole} disabled={busy || saving}>
              {busy ? 'Refreshing…' : 'Refresh Data'}
            </button>
            <a href="/trust-center" className="btn ghost link-plain">
              Trust Center
            </a>
            <button
              className={`btn ${adminOpsMode ? 'primary' : 'ghost'}`}
              type="button"
              onClick={() => setViewMode('ops')}
            >
              Ops Mode
            </button>
            <button
              className={`btn ${!adminOpsMode ? 'primary' : 'ghost'}`}
              type="button"
              onClick={() => setViewMode('full')}
            >
              Full Mode
            </button>
          </div>

          {onboardingOpen ? (
            <div className="mt12 onboarding-panel">
              <div className="onboarding-title">Guided Onboarding</div>
              <div className="onboarding-subtitle">
                Start with recommended defaults for your org size, then fine-tune phases and AI behavior.
              </div>
              <div className="onboarding-options mt12">
                {Object.entries(ORG_SIZE_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    className={`onboarding-option ${orgPreset === key ? 'active' : ''}`}
                    onClick={() => setOrgPreset(key)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="row mt12 wrap">
                <button className="btn primary" onClick={() => applyOrgPreset(orgPreset)}>
                  Apply Smart Defaults
                </button>
                <button className="btn ghost" onClick={completeOnboarding}>
                  Dismiss Guide
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt12" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <div className="status-chip">Users Active: <b>{usage.activeUsers || 0}</b></div>
            <div className="status-chip">Assigned Seats: <b>{usage.assignedSeats || 0}</b></div>
            <div className="status-chip">Active Rooms: <b>{usage.activeRooms || 0}</b></div>
            <div className="status-chip">Open Tickets: <b>{openSupportCount}</b></div>
            <div className="status-chip">Codes Available: <b>{availableCodeCount}</b></div>
            <div className="status-chip">AI Cost (30d): <b>${((usage.aiUsageCostCents30d || 0) / 100).toFixed(2)}</b></div>
            <div className="status-chip">Metered Units: <b>{meteredUnits}</b></div>
            <div className="status-chip">Overage: <b>{overageUnits > 0 ? `${overageUnits}` : '0'}</b></div>
          </div>

          {error && <div className="mt12" style={{ color: 'var(--tone-persimmon)' }}>{error}</div>}
          {notice && <div className="mt12" style={{ color: 'var(--tone-leaf)' }}>{notice}</div>}

          <div className="analytics-grid mt16">
            <GaugeCard
              title="Seat Usage"
              value={assignedSeats}
              max={seatCap || 1}
              subtitle="Assigned vs licensed seats"
              tone="leaf"
            />
            <GaugeCard
              title="Active Rooms"
              value={usage.activeRooms || 0}
              max={Math.max(1, Math.ceil(Number(workshopForm.expectedUsers || 1) / Math.max(1, Number(workshopForm.seatLimitPerRoom || 1))))}
              subtitle="Live rooms vs planned rooms"
              tone="persimmon"
            />
            <MiniBarChart
              title="Users by Role"
              items={usersByRoleChart}
              emptyLabel="No org users provisioned yet."
              tone="sunflower"
            />
            <MiniBarChart
              title="Incidents by Priority"
              items={incidentByPriorityChart}
              emptyLabel="No open support incidents."
              tone="persimmon"
            />
            <MiniBarChart
              title="Users by Site"
              items={usersBySiteChart}
              emptyLabel="No site assignments yet."
              tone="leaf"
            />
            <SparklineCard
              title="Billing Trend"
              values={aiUsageSeries}
              subtitle="Recent invoice activity"
            />
            <GaugeCard
              title="Completion Rate"
              value={Number(outcomeOrg.completionRate || 0)}
              max={100}
              subtitle="Rooms reaching completion"
              tone="sunflower"
            />
            <GaugeCard
              title="Participation Quality"
              value={Number(outcomeOrg.participationQualityScore || 0)}
              max={100}
              subtitle="Collaboration signal score"
              tone="leaf"
            />
            <GaugeCard
              title="Policy Adherence"
              value={Number(outcomeOrg.policyAdherenceRate || 0)}
              max={100}
              subtitle="Completed outputs meeting policy"
              tone="persimmon"
            />
            <GaugeCard
              title="Export Quality"
              value={Number(outcomeOrg.exportQualityScore || 0)}
              max={100}
              subtitle="Readiness of shared stakeholder output"
              tone="sunflower"
            />
            <SparklineCard
              title="Session Score Trend"
              values={sessionScoreSeries}
              subtitle="Outcome score over time"
            />
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Outcomes Analytics</div>
            <div className="row wrap" style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
              <span>Value Index: <b>{Number(outcomeOrg.valueIndex || 0)}</b></span>
              <span>Session Score: <b>{Number(outcomeOrg.sessionScore || 0)}</b></span>
              <span>Cost / Completed Room: <b>${Number(outcomeOrg.costPerCompletedRoomUsd || 0).toFixed(2)}</b></span>
              <span>Rooms / Dollar: <b>{Number(outcomeOrg.roomsPerDollar || 0).toFixed(2)}</b></span>
              <span>Window: <b>{Number(outcomes.windowDays || 30)} days</b></span>
            </div>
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Site</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Completion</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Quality</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Export</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Policy</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Session</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Value Index</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomeBySite.map((entry) => (
                    <tr key={entry.siteId}>
                      <td style={{ padding: 8 }}>{entry.siteId}</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.completionRate || 0).toFixed(1)}%</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.participationQualityScore || 0)}</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.exportQualityScore || 0)}</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.policyAdherenceRate || 0).toFixed(1)}%</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.sessionScore || 0)}</td>
                      <td style={{ padding: 8 }}>{Number(entry.metrics?.valueIndex || 0)}</td>
                    </tr>
                  ))}
                  {!outcomeBySite.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={7}>No recent outcome data yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Workshop Setup</div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Workshop Name</div>
                <input className="input mt6" value={workshopForm.name} onChange={(e) => updateWorkshopForm('name', e.target.value)} />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Mode</div>
                <select className="select mt6" value={workshopForm.mode} onChange={(e) => updateWorkshopForm('mode', e.target.value)}>
                  {modeOptions.map((mode) => (
                    <option key={mode.id} value={mode.id}>{mode.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Sites</div>
                <input
                  className="input mt6"
                  value={workshopForm.siteIdsText}
                  onChange={(e) => updateWorkshopForm('siteIdsText', e.target.value)}
                  placeholder="E1, E2"
                />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Expected Users</div>
                <input className="input mt6" type="number" min="1" value={workshopForm.expectedUsers} onChange={(e) => updateWorkshopForm('expectedUsers', e.target.value)} />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Active User Cap</div>
                <input className="input mt6" type="number" min="1" value={workshopForm.activeUserCap} onChange={(e) => updateWorkshopForm('activeUserCap', e.target.value)} />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Seat Limit Per Room</div>
                <input className="input mt6" type="number" min="1" value={workshopForm.seatLimitPerRoom} onChange={(e) => updateWorkshopForm('seatLimitPerRoom', e.target.value)} />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>AI Behavior</div>
                <select className="select mt6" value={workshopForm.aiBehavior} onChange={(e) => updateWorkshopForm('aiBehavior', e.target.value)}>
                  <option value="BACKGROUND">Background</option>
                  <option value="GUIDE">Guide</option>
                  <option value="HELPER">Helper</option>
                </select>
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Phase Count</div>
                <input className="input mt6" type="number" min="1" max="24" value={workshopForm.phaseCount} onChange={(e) => setPhaseCount(e.target.value)} />
              </label>
              <label className="row mt24">
                <input type="checkbox" checked={workshopForm.enableTopicVoting} onChange={(e) => updateWorkshopForm('enableTopicVoting', e.target.checked)} />
                Enable topic voting
              </label>
            </div>
            <div className="mt12" style={{ display: 'grid', gap: 8 }}>
              {ensurePhaseCount(workshopForm.phases, workshopForm.phaseCount).map((phase, idx) => (
                <div key={phase.id || idx} style={{ border: '1px solid rgba(148,163,184,.35)', borderRadius: 10, padding: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
                    <input className="input" value={phase.title} onChange={(e) => updatePhase(idx, 'title', e.target.value)} placeholder={`Phase ${idx + 1} title`} />
                    <input className="input" type="number" min="1" value={phase.durationMin} onChange={(e) => updatePhase(idx, 'durationMin', e.target.value)} placeholder="Minutes" />
                  </div>
                  <textarea className="input mt6" rows={2} value={phase.goal} onChange={(e) => updatePhase(idx, 'goal', e.target.value)} placeholder="Goal" />
                </div>
              ))}
            </div>
            <div className="mt12" style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Topic Catalog</div>
                <textarea className="input mt6" rows={4} value={workshopForm.topicCatalogText} onChange={(e) => updateWorkshopForm('topicCatalogText', e.target.value)} />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>AI Persona</div>
                <textarea className="input mt6" rows={4} value={workshopForm.assistantPersona} onChange={(e) => updateWorkshopForm('assistantPersona', e.target.value)} />
              </label>
            </div>
            <div className="row mt12">
              <button className="btn primary" onClick={saveWorkshop} disabled={saving || busy}>
                {saving ? 'Saving…' : 'Save Workshop'}
              </button>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Team Access and Roles</div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
              <input className="input" value={userForm.userId} onChange={(e) => setUserForm((p) => ({ ...p, userId: e.target.value }))} placeholder="userId (optional)" />
              <input className="input" value={userForm.email} onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))} placeholder="email" />
              <input className="input" value={userForm.name} onChange={(e) => setUserForm((p) => ({ ...p, name: e.target.value }))} placeholder="name" />
              <select className="select" value={userForm.role} onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value }))}>
                <option value="PARTICIPANT">PARTICIPANT</option>
                <option value="PRESENTER">PRESENTER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
              <input className="input" value={userForm.siteIdsText} onChange={(e) => setUserForm((p) => ({ ...p, siteIdsText: e.target.value }))} placeholder="sites: E1,E2" />
            </div>
            <textarea className="input mt6" rows={2} value={userForm.notes} onChange={(e) => setUserForm((p) => ({ ...p, notes: e.target.value }))} placeholder="notes" />
            <div className="row mt6">
              <button className="btn" onClick={saveUser} disabled={saving || busy}>Save User</button>
            </div>

            <div className="mt12" style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Email</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Role</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Sites</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Active</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.userId}>
                      <td style={{ padding: 8 }}>{user.email || user.userId}</td>
                      <td style={{ padding: 8 }}>{user.role}</td>
                      <td style={{ padding: 8 }}>{Array.isArray(user.siteIds) ? user.siteIds.join(', ') : '—'}</td>
                      <td style={{ padding: 8 }}>{user.active === false ? 'No' : 'Yes'}</td>
                      <td style={{ padding: 8 }}>
                        <button className="btn" onClick={() => deactivateUser(user.userId)} disabled={saving || busy || user.active === false}>
                          Deactivate
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!users.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={5}>No org users yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Sites and License Limits</div>
            <div className="row wrap" style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
              <span>License status: <b>{license.status || 'ACTIVE'}</b></span>
              <span>Tier: <b>{license.tier || 'STARTER'}</b></span>
              <span>Expiry: <b>{license.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : 'Not set'}</b></span>
            </div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <input className="input" value={licenseForm.siteIdsText} onChange={(e) => setLicenseForm((p) => ({ ...p, siteIdsText: e.target.value }))} placeholder="Sites: E1,E2" />
              <input className="input" type="number" min="1" value={licenseForm.seatCap} onChange={(e) => setLicenseForm((p) => ({ ...p, seatCap: e.target.value }))} placeholder="Seat cap" />
              <input className="input" type="number" min="1" value={licenseForm.activeUserCap} onChange={(e) => setLicenseForm((p) => ({ ...p, activeUserCap: e.target.value }))} placeholder="Active cap" />
              <input className="input" type="number" min="0" value={licenseForm.usageCap} onChange={(e) => setLicenseForm((p) => ({ ...p, usageCap: e.target.value }))} placeholder="Usage cap" />
            </div>
            <div className="row mt6">
              <label style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                Renew days
                <input className="input mt6" type="number" min="0" value={licenseForm.renewDays} onChange={(e) => setLicenseForm((p) => ({ ...p, renewDays: e.target.value }))} />
              </label>
            </div>
            <div className="row mt6 wrap">
              <button className="btn" onClick={saveSites} disabled={saving || busy}>Save Sites</button>
              <button className="btn primary" onClick={saveLicense} disabled={saving || busy}>Save License Capacity</button>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                Status and tier changes are controlled by platform operations.
              </span>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Access Codes</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
              Generate participant and presenter access codes for your licensed sites.
            </div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <select
                className="select"
                value={codeGenForm.role}
                onChange={(e) => setCodeGenForm((prev) => ({ ...prev, role: e.target.value }))}
              >
                <option value="PARTICIPANT">PARTICIPANT</option>
                <option value="PRESENTER">PRESENTER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
              <input
                className="input"
                type="number"
                min="1"
                max="500"
                value={codeGenForm.count}
                onChange={(e) => setCodeGenForm((prev) => ({ ...prev, count: e.target.value }))}
                placeholder="Code count"
              />
              <input
                className="input"
                value={codeGenForm.siteIdsText}
                onChange={(e) => setCodeGenForm((prev) => ({ ...prev, siteIdsText: e.target.value }))}
                placeholder="Sites: E1,E2"
              />
              <input
                className="input"
                type="number"
                min="1"
                value={codeGenForm.expiresDays}
                onChange={(e) => setCodeGenForm((prev) => ({ ...prev, expiresDays: e.target.value }))}
                placeholder="Expires in days"
              />
            </div>
            <div className="row mt6 wrap">
              <button className="btn primary" onClick={generateCodes} disabled={saving || busy}>
                Generate Codes
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                Available: {availableCodeCount} | Consumed: {consumedCodeCount}
              </span>
            </div>

            <div className="mt12" style={{ maxHeight: 220, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Code</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Role</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Site</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Created</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Expires</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.slice(0, 150).map((codeRow) => {
                    const status = codeRow.revoked
                      ? 'REVOKED'
                      : codeRow.consumed
                      ? 'CONSUMED'
                      : codeRow.expired
                      ? 'EXPIRED'
                      : 'ACTIVE';
                    return (
                      <tr key={`${codeRow.code}-${codeRow.createdAt || 0}`}>
                        <td style={{ padding: 8, fontFamily: 'monospace' }}>{codeRow.code}</td>
                        <td style={{ padding: 8 }}>{codeRow.role}</td>
                        <td style={{ padding: 8 }}>{codeRow.siteId || '—'}</td>
                        <td style={{ padding: 8 }}>
                          {codeRow.createdAt ? new Date(codeRow.createdAt).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: 8 }}>
                          {codeRow.expiresAt ? new Date(codeRow.expiresAt).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: 8 }}>{status}</td>
                        <td style={{ padding: 8 }}>
                          <button
                            className="btn"
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard?.writeText(codeRow.code || '');
                                setNotice(`Copied ${codeRow.code}`);
                              } catch {
                                setNotice(`Code: ${codeRow.code}`);
                              }
                            }}
                          >
                            Copy
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!codes.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={7}>No recent codes for this license.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Safety and Retention</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
              Configure retention by org policy for compliance and legal hold needs.
            </div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Message retention (days)</div>
                <input
                  className="input mt6"
                  type="number"
                  min="1"
                  value={retentionDraft.messageRetentionDays}
                  onChange={(e) => setRetentionDraft((p) => ({ ...p, messageRetentionDays: e.target.value }))}
                />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Draft retention (days)</div>
                <input
                  className="input mt6"
                  type="number"
                  min="1"
                  value={retentionDraft.draftRetentionDays}
                  onChange={(e) => setRetentionDraft((p) => ({ ...p, draftRetentionDays: e.target.value }))}
                />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Session retention (hours)</div>
                <input
                  className="input mt6"
                  type="number"
                  min="1"
                  value={retentionDraft.sessionRetentionHours}
                  onChange={(e) => setRetentionDraft((p) => ({ ...p, sessionRetentionHours: e.target.value }))}
                />
              </label>
              <label>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Audit retention (days)</div>
                <input
                  className="input mt6"
                  type="number"
                  min="1"
                  value={retentionDraft.auditRetentionDays}
                  onChange={(e) => setRetentionDraft((p) => ({ ...p, auditRetentionDays: e.target.value }))}
                />
              </label>
            </div>
            <label className="row mt6">
              <input
                type="checkbox"
                checked={!!retentionDraft.legalHold}
                onChange={(e) => setRetentionDraft((p) => ({ ...p, legalHold: e.target.checked }))}
              />
              Legal hold (pause data deletion)
            </label>
            <div className="row mt6">
              <button className="btn" onClick={saveRetention} disabled={saving || busy}>
                Save Retention Policy
              </button>
            </div>
          </div>

          {!adminOpsMode && (
            <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Feature Toggles and AI Policy</div>
              <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Flags</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {featureFlagKeys.map((flagKey) => (
                    <label key={flagKey} className="row">
                      <input
                        type="checkbox"
                        checked={!!flagDraft[flagKey]}
                        onChange={(e) =>
                          setFlagDraft((prev) => ({
                            ...prev,
                            [flagKey]: e.target.checked,
                          }))
                        }
                      />
                      <span>{flagKey}</span>
                    </label>
                  ))}
                  {!featureFlagKeys.length ? <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No flags configured.</div> : null}
                </div>
                <div className="row mt6">
                  <button className="btn" onClick={saveFlags} disabled={saving || busy}>Save Flags</button>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>AI Policy</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <select className="select" value={policyDraft.tone} onChange={(e) => setPolicyDraft((p) => ({ ...p, tone: e.target.value }))}>
                    <option value="SOFT">SOFT</option>
                    <option value="BALANCED">BALANCED</option>
                    <option value="DIRECT">DIRECT</option>
                    <option value="COACH">COACH</option>
                  </select>
                  <select className="select" value={policyDraft.strictness} onChange={(e) => setPolicyDraft((p) => ({ ...p, strictness: e.target.value }))}>
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                  </select>
                  <select className="select" value={policyDraft.dataUsage} onChange={(e) => setPolicyDraft((p) => ({ ...p, dataUsage: e.target.value }))}>
                    <option value="NO_TRAINING">NO_TRAINING</option>
                    <option value="ANONYMIZED">ANONYMIZED</option>
                    <option value="ANALYTICS_ONLY">ANALYTICS_ONLY</option>
                  </select>
                  <select className="select" value={policyDraft.ageSafeMode} onChange={(e) => setPolicyDraft((p) => ({ ...p, ageSafeMode: e.target.value }))}>
                    <option value="K12">K12</option>
                    <option value="TEEN">TEEN</option>
                    <option value="ADULT">ADULT</option>
                    <option value="OFF">OFF</option>
                  </select>
                  <select className="select" value={policyDraft.moderationLevel} onChange={(e) => setPolicyDraft((p) => ({ ...p, moderationLevel: e.target.value }))}>
                    <option value="STANDARD">STANDARD</option>
                    <option value="STRICT">STRICT</option>
                    <option value="OFF">OFF</option>
                  </select>
                  <input className="input" value={policyDraft.modelChoice} onChange={(e) => setPolicyDraft((p) => ({ ...p, modelChoice: e.target.value }))} placeholder="Model choice" />
                  <label className="row">
                    <input type="checkbox" checked={!!policyDraft.piiRedaction} onChange={(e) => setPolicyDraft((p) => ({ ...p, piiRedaction: e.target.checked }))} />
                    PII redaction
                  </label>
                  <label className="row">
                    <input type="checkbox" checked={!!policyDraft.citationMode} onChange={(e) => setPolicyDraft((p) => ({ ...p, citationMode: e.target.checked }))} />
                    Citation mode
                  </label>
                  <textarea
                    className="input"
                    rows={3}
                    value={policyDraft.blockedTermsText}
                    onChange={(e) => setPolicyDraft((p) => ({ ...p, blockedTermsText: e.target.value }))}
                    placeholder="Blocked terms (one per line)"
                  />
                  <button className="btn" onClick={savePolicy} disabled={saving || busy}>Save AI Policy</button>
                </div>
              </div>
            </div>
            </div>
          )}

          {!adminOpsMode && (
            <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Template Management</div>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <input className="input" value={templateForm.templateId} onChange={(e) => setTemplateForm((p) => ({ ...p, templateId: e.target.value }))} placeholder="templateId (optional)" />
              <input className="input" value={templateForm.name} onChange={(e) => setTemplateForm((p) => ({ ...p, name: e.target.value }))} placeholder="template name" />
              <select className="select" value={templateForm.mode} onChange={(e) => setTemplateForm((p) => ({ ...p, mode: e.target.value }))}>
                {modeOptions.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.id}</option>
                ))}
              </select>
              <button className="btn" onClick={createTemplate} disabled={saving || busy}>Create Draft</button>
            </div>
            <textarea className="input mt6" rows={2} value={templateForm.description} onChange={(e) => setTemplateForm((p) => ({ ...p, description: e.target.value }))} placeholder="template description" />

            <div className="mt12" style={{ maxHeight: 260, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Template</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Version</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Mode</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Action Version</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((template) => (
                    <tr key={template.templateKey}>
                      <td style={{ padding: 8 }}>{template.templateId}</td>
                      <td style={{ padding: 8 }}>v{template.version}</td>
                      <td style={{ padding: 8 }}>{template.status}</td>
                      <td style={{ padding: 8 }}>{template.mode}</td>
                      <td style={{ padding: 8 }}>
                        <input
                          className="input"
                          type="number"
                          min="1"
                          value={templateVersionInputs[template.templateId] || ''}
                          onChange={(e) =>
                            setTemplateVersionInputs((prev) => ({
                              ...prev,
                              [template.templateId]: e.target.value,
                            }))
                          }
                          placeholder="version"
                        />
                      </td>
                      <td style={{ padding: 8 }}>
                        <div className="row wrap">
                          <button className="btn" onClick={() => publishTemplate(template.templateId)} disabled={saving || busy}>Publish</button>
                          <button className="btn" onClick={() => deprecateTemplate(template.templateId)} disabled={saving || busy}>Deprecate</button>
                          <button className="btn" onClick={() => rollbackTemplate(template.templateId)} disabled={saving || busy}>Rollback</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!templates.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={6}>No templates yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
              </div>
            </div>
          )}

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Billing, Entitlements, and Support</div>
            <div className="row wrap" style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
              <span>Period: <b>{billingSummary.periodKey || '—'}</b></span>
              <span>Tier: <b>{billingSummary?.entitlements?.tier || license.tier || 'STARTER'}</b></span>
              <span>Usage Cap: <b>{usageCap || 0}</b></span>
              <span>Metered: <b>{meteredUnits}</b></span>
              <span>Overage Policy: <b>{billingSummary?.entitlements?.overagePolicy || license.overagePolicy || 'NOTIFY_ONLY'}</b></span>
              <span>Projected Overage: <b>${projectedOverageUsd.toFixed(2)}</b></span>
            </div>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <button className="btn" onClick={runBillingCycleNow} disabled={saving || busy}>
                {saving ? 'Running cycle…' : 'Run Billing Cycle'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                Usage components:
                {' '}
                users {Number(billingSummary?.usage?.unitComponents?.activeUsersUnits || 0)}
                {' | '}
                seats {Number(billingSummary?.usage?.unitComponents?.assignedSeatUnits || 0)}
                {' | '}
                rooms {Number(billingSummary?.usage?.unitComponents?.activeRoomUnits || 0)}
                {' | '}
                AI {Number(billingSummary?.usage?.unitComponents?.aiCostUnits || 0)}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 600 }}>Billing</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <input className="input" type="number" min="0" value={billingForm.amountCents} onChange={(e) => setBillingForm((p) => ({ ...p, amountCents: e.target.value }))} placeholder="Amount cents" />
                  <input className="input" value={billingForm.currency} onChange={(e) => setBillingForm((p) => ({ ...p, currency: e.target.value.toUpperCase() }))} placeholder="USD" />
                  <input className="input" value={billingForm.description} onChange={(e) => setBillingForm((p) => ({ ...p, description: e.target.value }))} placeholder="Description" />
                  <button className="btn" onClick={createInvoice} disabled={saving || busy}>Create Invoice</button>
                </div>
                <div className="mt6" style={{ maxHeight: 140, overflow: 'auto' }}>
                  {billingEvents.map((event) => (
                    <div key={event.billingEventId} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,.2)' }}>
                      {event.eventType} {event.status} ${(Number(event.amountCents || 0) / 100).toFixed(2)}
                      {event.payload?.periodKey ? ` (${event.payload.periodKey})` : ''}
                    </div>
                  ))}
                  {!billingEvents.length ? (
                    <EmptyState
                      title="No billing events"
                      subtitle="Invoices and usage events will show up here."
                    />
                  ) : null}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600 }}>Support</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  <input className="input" value={supportForm.subject} onChange={(e) => setSupportForm((p) => ({ ...p, subject: e.target.value }))} placeholder="Subject" />
                  <textarea className="input" rows={2} value={supportForm.description} onChange={(e) => setSupportForm((p) => ({ ...p, description: e.target.value }))} placeholder="Description" />
                  <select className="select" value={supportForm.priority} onChange={(e) => setSupportForm((p) => ({ ...p, priority: e.target.value }))}>
                    <option value="P1">P1</option>
                    <option value="P2">P2</option>
                    <option value="P3">P3</option>
                    <option value="P4">P4</option>
                  </select>
                  <label className="row">
                    <input type="checkbox" checked={supportForm.escalate} onChange={(e) => setSupportForm((p) => ({ ...p, escalate: e.target.checked }))} />
                    Escalate immediately
                  </label>
                  <button className="btn" onClick={createSupportTicket} disabled={saving || busy}>Create Ticket</button>
                </div>
                <div className="mt6" style={{ maxHeight: 140, overflow: 'auto' }}>
                  {supportTickets.map((ticket) => (
                    <div key={ticket.ticketId} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,.2)' }}>
                      {ticket.priority} {ticket.ticketStatus} - {ticket.subject}
                    </div>
                  ))}
                  {!supportTickets.length ? (
                    <EmptyState
                      title="No support tickets"
                      subtitle="Create one from this panel when your team needs help."
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="mt16" style={{ borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Pending Approvals</div>
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid rgba(148,163,184,.3)', borderRadius: 10 }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 8 }}>Approval ID</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Type</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Target</th>
                    <th style={{ textAlign: 'left', padding: 8 }}>Requested At</th>
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((approval) => (
                    <tr key={approval.approvalId}>
                      <td style={{ padding: 8 }}>{approval.approvalId}</td>
                      <td style={{ padding: 8 }}>{approval.status}</td>
                      <td style={{ padding: 8 }}>{approval.requestType || '—'}</td>
                      <td style={{ padding: 8 }}>{approval.targetType || '—'} {approval.targetId || ''}</td>
                      <td style={{ padding: 8 }}>{approval.requestedAt ? new Date(approval.requestedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                  {!approvals.length ? (
                    <tr><td style={{ padding: 8 }} colSpan={5}>No pending approvals.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {workshop.updatedAt ? (
            <div className="mt12" style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
              Last workshop update: {new Date(workshop.updatedAt).toLocaleString()}
            </div>
          ) : null}
        </div>
      </div>
      <CopilotPanel
        className="copilot-admin"
        title="Admin Copilot"
        subtitle="Policy, phase, and template suggestions"
        suggestions={copilotSuggestions}
      />
    </>
  );
}
