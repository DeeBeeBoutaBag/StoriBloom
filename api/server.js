// server.js (FULL FILE — NO OMISSIONS)

try {
  await import('dotenv/config');
} catch (err) {
  console.warn(
    '[dotenv] not loaded (probably running on AWS with real env vars):',
    err?.message || err
  );
}

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Optional deps
let compression = null;
let morgan = null;
try {
  ({ default: compression } = await import('compression'));
} catch {}
try {
  ({ default: morgan } = await import('morgan'));
} catch {}

import { CreateBackupCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import { getOpenAI } from './openaiClient.js';
import { Asema } from './asemaPersona.js';
import {
  collectTenantTargetsFromRequest,
  evaluateRoomAccess,
  evaluateTenantHierarchy,
} from './authz.js';
import {
  createSessionToken,
  resolveJwtSecret,
  verifySessionToken,
} from './auth.js';

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 8080);
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const AWS_DYNAMO_ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TABLES = {
  codes:
    process.env.DDB_TABLE_CODES ||
    process.env.TABLE_CODES ||
    'storibloom_codes',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  personas: process.env.DDB_TABLE_PERSONAS || 'storibloom_personas',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
  authSessions: process.env.DDB_TABLE_AUTH_SESSIONS || 'storibloom_auth_sessions',
  scimUsers: process.env.DDB_TABLE_SCIM_USERS || 'storibloom_scim_users',
  scimGroups: process.env.DDB_TABLE_SCIM_GROUPS || 'storibloom_scim_groups',
  workshops: process.env.DDB_TABLE_WORKSHOPS || 'storibloom_workshops',
  audit: process.env.DDB_TABLE_AUDIT || 'storibloom_audit',
  orgs: process.env.DDB_TABLE_ORGS || 'storibloom_orgs',
  orgUsers: process.env.DDB_TABLE_ORG_USERS || 'storibloom_org_users',
  licenses: process.env.DDB_TABLE_LICENSES || 'storibloom_licenses',
  featureFlags: process.env.DDB_TABLE_FEATURE_FLAGS || 'storibloom_feature_flags',
  policies: process.env.DDB_TABLE_POLICIES || 'storibloom_policies',
  templates: process.env.DDB_TABLE_TEMPLATES || 'storibloom_templates',
  approvals: process.env.DDB_TABLE_APPROVALS || 'storibloom_approvals',
  billing: process.env.DDB_TABLE_BILLING || 'storibloom_billing',
  support: process.env.DDB_TABLE_SUPPORT || 'storibloom_support',
  status: process.env.DDB_TABLE_STATUS || 'storibloom_status',

  // Optional gallery table (if not provisioned, gallery endpoint falls back to room records)
  gallery: process.env.DDB_TABLE_GALLERY || 'storibloom_gallery',
};

const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const ENABLE_SPA = String(process.env.STATIC_INDEX || '0') === '1';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const SUPER_ADMIN_EMAIL = String(
  process.env.SUPER_ADMIN_EMAIL || 'demetrious@hiddengeniusproject.org'
)
  .trim()
  .toLowerCase();
const MESSAGE_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.MESSAGE_RETENTION_DAYS || 90)
);
const DRAFT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.DRAFT_RETENTION_DAYS || 365)
);
const SESSION_TTL_HOURS = Math.max(
  1,
  Number(process.env.SESSION_TTL_HOURS || 24)
);
const SESSION_HEARTBEAT_MS = Math.max(
  5_000,
  Number(process.env.SESSION_HEARTBEAT_MS || 30_000)
);
const SUPER_ADMIN_ACTIVE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.SUPER_ADMIN_ACTIVE_WINDOW_MS || 5 * 60_000)
);
const LICENSE_ACTIVE_USER_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.LICENSE_ACTIVE_USER_WINDOW_MS || SUPER_ADMIN_ACTIVE_WINDOW_MS)
);
const DEFAULT_AUDIT_RETENTION_DAYS = Math.max(
  30,
  Number(process.env.AUDIT_RETENTION_DAYS || 365)
);
const CODE_TTL_DAYS = Math.max(1, Number(process.env.CODE_TTL_DAYS || 30));
const CODE_HASH_SECRET = String(process.env.CODE_HASH_SECRET || '').trim();
const SCIM_BEARER_TOKEN = String(process.env.SCIM_BEARER_TOKEN || '').trim();
const SSO_DOMAIN_ALLOWLIST = (process.env.SSO_DOMAIN_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SSO_GROUP_ROLE_MAP = (() => {
  try {
    const parsed = JSON.parse(process.env.SSO_GROUP_ROLE_MAP || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();
const SSO_JIT_PROVISION = String(process.env.SSO_JIT_PROVISION || '1') !== '0';
const ACCESS_TOKEN_TTL_SECONDS = Math.max(
  60,
  Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 15 * 60)
);
const REFRESH_TOKEN_TTL_SECONDS = Math.max(
  5 * 60,
  Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 60 * 60)
);
const BILLING_PROVIDER = String(process.env.BILLING_PROVIDER || 'enterprise')
  .trim()
  .toLowerCase();
const BILLING_STRIPE_INVOICE_ENDPOINT = String(
  process.env.BILLING_STRIPE_INVOICE_ENDPOINT ||
    'https://api.stripe.com/v1/invoices'
).trim();
const BILLING_ENTERPRISE_INVOICE_ENDPOINT = String(
  process.env.BILLING_ENTERPRISE_INVOICE_ENDPOINT || ''
).trim();
const BILLING_API_KEY = String(process.env.BILLING_API_KEY || '').trim();
const BILLING_AUTOMATION_ENABLED =
  String(process.env.BILLING_AUTOMATION_ENABLED || '1') !== '0';
const BILLING_OVERAGE_UNIT_PRICE_STARTER_CENTS = Math.max(
  1,
  Number(process.env.BILLING_OVERAGE_UNIT_PRICE_STARTER_CENTS || 125)
);
const BILLING_OVERAGE_UNIT_PRICE_PRO_CENTS = Math.max(
  1,
  Number(process.env.BILLING_OVERAGE_UNIT_PRICE_PRO_CENTS || 95)
);
const BILLING_OVERAGE_UNIT_PRICE_ENTERPRISE_CENTS = Math.max(
  1,
  Number(process.env.BILLING_OVERAGE_UNIT_PRICE_ENTERPRISE_CENTS || 75)
);
const OUTCOMES_WINDOW_DAYS = Math.max(
  7,
  Number(process.env.OUTCOMES_WINDOW_DAYS || 30)
);
const TRUST_CENTER_BRAND_NAME = String(
  process.env.TRUST_CENTER_BRAND_NAME || 'StoriBloom Trust Center'
).trim();
const TRUST_CENTER_PRIVACY_URL = String(
  process.env.TRUST_CENTER_PRIVACY_URL || ''
).trim();
const TRUST_CENTER_TERMS_URL = String(
  process.env.TRUST_CENTER_TERMS_URL || ''
).trim();
const TRUST_CENTER_DPA_URL = String(
  process.env.TRUST_CENTER_DPA_URL || ''
).trim();
const TRUST_CENTER_SECURITY_WHITEPAPER_URL = String(
  process.env.TRUST_CENTER_SECURITY_WHITEPAPER_URL || ''
).trim();
const TRUST_CENTER_SUBPROCESSOR_LIST_URL = String(
  process.env.TRUST_CENTER_SUBPROCESSOR_LIST_URL || ''
).trim();
const TRUST_CENTER_PENTEST_SUMMARY_URL = String(
  process.env.TRUST_CENTER_PENTEST_SUMMARY_URL || ''
).trim();
const TRUST_CENTER_SOC2_URL = String(
  process.env.TRUST_CENTER_SOC2_URL || ''
).trim();
const TRUST_CENTER_DEFAULT_SUBPROCESSORS = String(
  process.env.TRUST_CENTER_DEFAULT_SUBPROCESSORS ||
    'Amazon Web Services|Cloud infrastructure|Global;OpenAI|Generative AI processing|United States;Render|Application hosting|United States'
)
  .split(';')
  .map((entry) => {
    const [name, purpose, region] = String(entry || '').split('|');
    return {
      name: String(name || '').trim(),
      purpose: String(purpose || '').trim(),
      region: String(region || '').trim(),
    };
  })
  .filter((item) => item.name);
const SUPPORT_ESCALATION_EMAIL = String(
  process.env.SUPPORT_ESCALATION_EMAIL || 'support@storibloom.app'
).trim();
const STATUS_PAGE_URL = String(process.env.STATUS_PAGE_URL || '/status').trim();
const ENTITLEMENT_CACHE_MS = Math.max(
  5_000,
  Number(process.env.ENTITLEMENT_CACHE_MS || 20_000)
);
const BILLING_AUTOMATION_COOLDOWN_MS = Math.max(
  30_000,
  Number(process.env.BILLING_AUTOMATION_COOLDOWN_MS || 5 * 60_000)
);
const SUPPORT_AUTO_ESCALATE_ENABLED =
  String(process.env.SUPPORT_AUTO_ESCALATE_ENABLED || '1') !== '0';
const SUPPORT_AUTO_ESCALATE_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.SUPPORT_AUTO_ESCALATE_INTERVAL_MS || 60_000)
);
const SUPPORT_SLA_RESPONSE_MINUTES_BY_PRIORITY = Object.freeze({
  P1: Math.max(5, Number(process.env.SUPPORT_SLA_RESPONSE_MIN_P1 || 60)),
  P2: Math.max(15, Number(process.env.SUPPORT_SLA_RESPONSE_MIN_P2 || 240)),
  P3: Math.max(30, Number(process.env.SUPPORT_SLA_RESPONSE_MIN_P3 || 24 * 60)),
  P4: Math.max(30, Number(process.env.SUPPORT_SLA_RESPONSE_MIN_P4 || 2 * 24 * 60)),
});
const SUPPORT_SLA_RESOLUTION_MINUTES_BY_PRIORITY = Object.freeze({
  P1: Math.max(10, Number(process.env.SUPPORT_SLA_RESOLUTION_MIN_P1 || 4 * 60)),
  P2: Math.max(30, Number(process.env.SUPPORT_SLA_RESOLUTION_MIN_P2 || 8 * 60)),
  P3: Math.max(60, Number(process.env.SUPPORT_SLA_RESOLUTION_MIN_P3 || 3 * 24 * 60)),
  P4: Math.max(60, Number(process.env.SUPPORT_SLA_RESOLUTION_MIN_P4 || 5 * 24 * 60)),
});
const SUPPORT_SLA_ESCALATE_AFTER_RESPONSE_MISSES = Math.max(
  1,
  Number(process.env.SUPPORT_SLA_ESCALATE_AFTER_RESPONSE_MISSES || 1)
);
const RELIABILITY_SCOPE_ID = String(
  process.env.RELIABILITY_SCOPE_ID || 'RELIABILITY'
).trim().toUpperCase();
const RELIABILITY_RTO_TARGET_MINUTES = Math.max(
  1,
  Number(process.env.RELIABILITY_RTO_TARGET_MINUTES || 240)
);
const RELIABILITY_RPO_TARGET_MINUTES = Math.max(
  1,
  Number(process.env.RELIABILITY_RPO_TARGET_MINUTES || 60)
);
const RELIABILITY_DRILL_INTERVAL_DAYS = Math.max(
  1,
  Number(process.env.RELIABILITY_DRILL_INTERVAL_DAYS || 30)
);
const RELIABILITY_AUTO_BACKUP_ENABLED =
  String(process.env.RELIABILITY_AUTO_BACKUP_ENABLED || '1') !== '0';
const RELIABILITY_AUTO_BACKUP_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.RELIABILITY_AUTO_BACKUP_INTERVAL_MS || 6 * 60 * 60_000)
);
const RELIABILITY_BACKUP_EXECUTION_MODE = String(
  process.env.RELIABILITY_BACKUP_EXECUTION_MODE || 'checkpoint'
)
  .trim()
  .toLowerCase();
const DEMO_MODE_FALLBACK = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.DEMO_MODE_FALLBACK || '')
    .trim()
    .toLowerCase()
);
const DEMO_DEFAULT_ORG_ID = String(process.env.DEMO_DEFAULT_ORG_ID || 'ORG-DEMO')
  .trim()
  .toUpperCase();
const DEMO_DEFAULT_LICENSE_ID = String(
  process.env.DEMO_DEFAULT_LICENSE_ID || 'LIC-DEMO'
)
  .trim()
  .toUpperCase();
const DEMO_DEFAULT_SITE_ID = String(process.env.DEMO_DEFAULT_SITE_ID || 'E1')
  .trim()
  .toUpperCase();
const DEMO_DEFAULT_SUPER_ADMIN_EMAIL = String(
  process.env.DEMO_DEFAULT_SUPER_ADMIN_EMAIL || SUPER_ADMIN_EMAIL
)
  .trim()
  .toLowerCase();

const DEPENDENCY_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'ResourceNotFoundException',
  'InternalServerError',
  'TimeoutError',
  'NetworkingError',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ServiceUnavailable',
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestTimeout',
  'RequestTimeoutException',
  'EndpointError',
  'UnknownEndpoint',
  'UnknownError',
]);

const sessionHeartbeatCache = new Map(); // uid -> last write ms
let sessionsTableMissingWarned = false;
let auditTableMissingWarned = false;
const tenantWorkshopCache = new Map(); // licenseId -> { workshop, loadedAt }
const TENANT_WORKSHOP_CACHE_MS = 60_000;
const entitlementRuntimeCache = new Map(); // key -> { at, value }
const billingAutomationRunCache = new Map(); // licenseId -> last run ms
let supportEscalationLoopInFlight = false;
let reliabilityBackupLoopInFlight = false;
const cerReminderCache = new Map(); // roomId -> last reminder ms
const CER_REMINDER_INTERVAL_MS = 45_000;
const phaseGateReminderCache = new Map(); // roomId -> last reminder ms
const PHASE_GATE_REMINDER_INTERVAL_MS = 45_000;
const ROLE_ROTATION_ROLES = Object.freeze([
  'facilitator',
  'timekeeper',
  'editor',
  'evidence_lead',
]);
const AI_FALLBACK_ACTIVE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.AI_FALLBACK_ACTIVE_WINDOW_MS || 20 * 60_000)
);
const DEPENDENCY_HEALTH_CACHE_MS = Math.max(
  5_000,
  Number(process.env.DEPENDENCY_HEALTH_CACHE_MS || 20_000)
);
const dependencyHealthState = {
  api: { ok: true, lastCheckedAt: Date.now() },
  aws: { ok: false, lastCheckedAt: 0, error: '' },
  openai: { ok: false, lastCheckedAt: 0, error: '' },
};
let dependencyHealthInFlight = null;

function dependencyErrorCode(err) {
  return String(err?.code || err?.name || '').trim();
}

function dependencyErrorMessage(err) {
  return String(err?.message || '').trim().toLowerCase();
}

function isDependencyFailure(err) {
  if (!err || typeof err !== 'object') return false;
  const code = dependencyErrorCode(err);
  if (DEPENDENCY_ERROR_NAMES.has(code)) return true;
  const msg = dependencyErrorMessage(err);
  if (
    msg.includes('could not load credentials') ||
    msg.includes('credential') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('service unavailable') ||
    msg.includes('temporary unavailable')
  ) {
    return true;
  }
  const httpCode = Number(err?.$metadata?.httpStatusCode || 0);
  return httpCode >= 500;
}

function shouldUseDemoFallback(err) {
  return DEMO_MODE_FALLBACK && isDependencyFailure(err);
}

function logDemoFallback(context, err) {
  if (!DEMO_MODE_FALLBACK) return;
  const code = dependencyErrorCode(err) || 'dependency_error';
  const msg = String(err?.message || err || '').slice(0, 240);
  console.warn(`[demo-fallback] ${context}: ${code}${msg ? ` (${msg})` : ''}`);
}

// ---------- AWS ----------
const ddb = new DynamoDBClient({
  region: AWS_REGION,
  ...(AWS_DYNAMO_ENDPOINT ? { endpoint: AWS_DYNAMO_ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

async function refreshDependencyHealth({ force = false } = {}) {
  const now = Date.now();
  const lastChecked = Math.max(
    Number(dependencyHealthState.aws.lastCheckedAt || 0),
    Number(dependencyHealthState.openai.lastCheckedAt || 0)
  );
  if (!force && lastChecked && now - lastChecked < DEPENDENCY_HEALTH_CACHE_MS) {
    return dependencyHealthState;
  }
  if (dependencyHealthInFlight) return dependencyHealthInFlight;
  dependencyHealthInFlight = (async () => {
    const checkedAt = Date.now();

    try {
      const creds = await ddb.config.credentials();
      dependencyHealthState.aws = {
        ok: !!creds?.accessKeyId,
        lastCheckedAt: checkedAt,
        error: creds?.accessKeyId ? '' : 'credentials_unavailable',
      };
    } catch (err) {
      dependencyHealthState.aws = {
        ok: false,
        lastCheckedAt: checkedAt,
        error: String(err?.message || err || 'credentials_error').slice(0, 180),
      };
    }

    try {
      getOpenAI();
      dependencyHealthState.openai = {
        ok: true,
        lastCheckedAt: checkedAt,
        error: '',
      };
    } catch (err) {
      dependencyHealthState.openai = {
        ok: false,
        lastCheckedAt: checkedAt,
        error: String(err?.message || err || 'openai_unavailable').slice(0, 180),
      };
    }
    dependencyHealthState.api = {
      ok: true,
      lastCheckedAt: checkedAt,
    };
    return dependencyHealthState;
  })();

  try {
    return await dependencyHealthInFlight;
  } finally {
    dependencyHealthInFlight = null;
  }
}

// Log AWS + OpenAI
(async () => {
  const health = await refreshDependencyHealth({ force: true });
  if (health.aws.ok) console.log('[aws] credentials resolved');
  else console.warn('[aws] credentials not resolved');
  if (health.openai.ok) console.log('[openai] enabled');
  else console.warn('[openai] disabled:', health.openai.error || 'unavailable');

  console.log('[env] tables', TABLES);
})();

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

const runtimeMetrics = {
  requestsTotal: 0,
  byRoute: new Map(),
  byStatus: new Map(),
  byMethod: new Map(),
  errors5xx: 0,
};

app.use((req, res, next) => {
  const requestId =
    String(req.headers['x-request-id'] || '').trim() || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const safeUrl = String(req.originalUrl || '').replace(
      /([?&]token=)[^&]+/gi,
      '$1[redacted]'
    );
    const routeKey = `${req.method} ${req.path || req.url || ''}`;
    const status = Number(res.statusCode || 0);
    const durationMs = Date.now() - startedAt;

    runtimeMetrics.requestsTotal += 1;
    runtimeMetrics.byRoute.set(routeKey, (runtimeMetrics.byRoute.get(routeKey) || 0) + 1);
    runtimeMetrics.byStatus.set(status, (runtimeMetrics.byStatus.get(status) || 0) + 1);
    runtimeMetrics.byMethod.set(
      req.method,
      (runtimeMetrics.byMethod.get(req.method) || 0) + 1
    );
    if (status >= 500) runtimeMetrics.errors5xx += 1;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        requestId,
        method: req.method,
        url: safeUrl,
        path: req.path,
        status,
        durationMs,
        uid: req.user?.uid || '',
        role: req.user?.role || '',
        orgId: req.user?.orgId || '',
        licenseId: req.user?.licenseId || '',
        siteId: req.user?.siteId || '',
      })
    );
  });
  next();
});

// ---------- Auth ----------
const JWT_SECRET = resolveJwtSecret();

async function handleGuestAuth(req, res) {
  try {
    const id = crypto.randomUUID();
    const pair = await issueTokenPair({ uid: id, role: 'PARTICIPANT' }, req);
    res.json({
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      userId: id,
      role: 'PARTICIPANT',
      expiresIn: pair.accessTtlSeconds,
    });
  } catch (e) {
    console.error('[auth/guest] error', e);
    res.status(500).json({ error: 'guest auth failed' });
  }
}
app.post('/auth/guest', handleGuestAuth);
app.post('/api/auth/guest', handleGuestAuth);

function extractRefreshToken(req) {
  const bodyToken = req.body?.refreshToken;
  if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

app.post('/auth/refresh', async (req, res) => {
  try {
    const refreshToken = extractRefreshToken(req);
    if (!refreshToken) return res.status(400).json({ error: 'refresh_token_required' });

    const claims = verifySessionToken(refreshToken, { secret: JWT_SECRET });
    if (String(claims.tokenType || '').toLowerCase() !== 'refresh') {
      return res.status(401).json({ error: 'refresh_token_required' });
    }
    if (!claims.sessionId || !claims.jti) {
      return res.status(401).json({ error: 'refresh_token_malformed' });
    }

    const session = await getAuthSessionRecord(claims.uid, claims.sessionId);
    if (!session || !!session.revoked) {
      return res.status(401).json({ error: 'session_revoked' });
    }

    const expectedHash = String(session.refreshHash || '');
    const actualHash = hashTokenValue(claims.jti);
    if (!expectedHash || expectedHash !== actualHash) {
      await revokeAllAuthSessions(claims.uid);
      await writeAuditEvent({
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        actor: {
          uid: claims.uid,
          role: claims.role,
          orgId: claims.orgId,
          licenseId: claims.licenseId,
          siteId: claims.siteId,
          email: claims.email,
        },
        target: {
          resourceType: 'AUTH_SESSION',
          resourceId: claims.sessionId,
          orgId: claims.orgId,
          licenseId: claims.licenseId,
          siteId: claims.siteId,
        },
        details: { reason: 'refresh_token_reuse' },
      });
      return res.status(401).json({ error: 'refresh_token_reused' });
    }

    const pair = await issueTokenPair(
      {
        uid: claims.uid,
        role: claims.role,
        siteId: claims.siteId,
        licenseId: claims.licenseId,
        orgId: claims.orgId,
        email: claims.email,
      },
      req,
      { sessionId: claims.sessionId }
    );

    return res.json({
      ok: true,
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      expiresIn: pair.accessTtlSeconds,
    });
  } catch (err) {
    console.error('[/auth/refresh] error', err);
    return res.status(401).json({ error: 'refresh_failed' });
  }
});

app.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    const allSessions = !!req.body?.allSessions;
    if (allSessions) {
      await revokeAllAuthSessions(req.user.uid);
    } else if (req.user.sessionId) {
      await revokeAuthSession(req.user.uid, req.user.sessionId);
    }
    await writeAuditEvent({
      action: allSessions ? 'AUTH_LOGOUT_ALL' : 'AUTH_LOGOUT',
      actor: req.user,
      target: {
        resourceType: 'AUTH_SESSION',
        resourceId: allSessions ? 'ALL' : req.user.sessionId || '',
        orgId: req.user.orgId,
        licenseId: req.user.licenseId,
        siteId: req.user.siteId,
      },
      details: { allSessions },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[/auth/logout] error', err);
    return res.status(500).json({ error: 'logout_failed' });
  }
});

app.get('/auth/sessions', requireAuth, async (req, res) => {
  try {
    const rows = await listAuthSessions(req.user.uid, 100);
    const sessions = rows.map((row) => ({
      sessionId: String(row.sessionId || ''),
      role: String(row.role || '').toUpperCase(),
      siteId: normalizedSiteId(row.siteId || ''),
      licenseId: normalizedLicenseId(row.licenseId || ''),
      orgId: normalizedOrgId(row.orgId || '', row.licenseId || ''),
      createdAt: Number(row.createdAt || 0) || null,
      lastSeenAt: Number(row.lastSeenAt || 0) || null,
      revoked: !!row.revoked,
      ip: String(row.ip || ''),
      userAgent: String(row.userAgent || ''),
    }));
    return res.json({ sessions });
  } catch (err) {
    console.error('[/auth/sessions] error', err);
    return res.status(500).json({ error: 'session_list_failed' });
  }
});

function allowedSsoProvider(provider) {
  const p = String(provider || '').trim().toUpperCase();
  return p === 'OKTA' || p === 'ENTRA' || p === 'GOOGLE';
}

function roleWeight(role) {
  const r = String(role || '').trim().toUpperCase();
  if (r === 'SUPER_ADMIN') return 100;
  if (r === 'ADMIN') return 80;
  if (r === 'PRESENTER') return 60;
  return 10;
}

function mapGroupsToRole(groups = [], fallbackRole = 'PARTICIPANT') {
  const normalizedGroups = Array.isArray(groups)
    ? groups.map((g) => String(g || '').trim().toLowerCase()).filter(Boolean)
    : [];
  let selected = String(fallbackRole || 'PARTICIPANT').toUpperCase();
  for (const group of normalizedGroups) {
    const mapped = String(SSO_GROUP_ROLE_MAP[group] || '').trim().toUpperCase();
    if (!mapped) continue;
    if (roleWeight(mapped) > roleWeight(selected)) selected = mapped;
  }
  if (!['PARTICIPANT', 'PRESENTER', 'ADMIN', 'SUPER_ADMIN'].includes(selected)) {
    return 'PARTICIPANT';
  }
  return selected;
}

function emailAllowedForSso(email) {
  const normalizedEmail = normalizeSuperAdminEmail(email);
  if (!normalizedEmail) return false;
  if (!SSO_DOMAIN_ALLOWLIST.length) return true;
  const atIdx = normalizedEmail.lastIndexOf('@');
  if (atIdx < 0) return false;
  const domain = normalizedEmail.slice(atIdx + 1);
  return SSO_DOMAIN_ALLOWLIST.includes(domain);
}

app.post('/auth/sso/exchange', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim().toUpperCase();
    const email = normalizeSuperAdminEmail(req.body?.email);
    const subject = String(req.body?.subject || '').trim();
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    const bodyRole = String(req.body?.role || '').trim().toUpperCase();
    if (!allowedSsoProvider(provider)) {
      return res.status(400).json({ error: 'unsupported_sso_provider' });
    }
    if (!email || !subject) {
      return res.status(400).json({ error: 'email_and_subject_required' });
    }
    if (!emailAllowedForSso(email)) {
      return res.status(403).json({ error: 'sso_email_domain_not_allowed' });
    }

    let role = mapGroupsToRole(groups, bodyRole || 'PARTICIPANT');
    if (email === SUPER_ADMIN_EMAIL) role = 'SUPER_ADMIN';

    const licenseId = normalizedLicenseId(req.body?.licenseId || '');
    const siteId = normalizedSiteId(req.body?.siteId || '');
    const orgId = normalizedOrgId(req.body?.orgId || '', licenseId);
    if (role !== 'SUPER_ADMIN' && (!orgId || !licenseId)) {
      return res.status(400).json({ error: 'tenant_required_for_sso' });
    }
    if ((role === 'PARTICIPANT' || role === 'PRESENTER') && !siteId) {
      return res.status(400).json({ error: 'site_required_for_sso_role' });
    }

    let workshop = null;
    if (role !== 'SUPER_ADMIN') {
      if (SSO_JIT_PROVISION) {
        workshop = await ensureWorkshopConfig({
          licenseId,
          orgId,
          siteIds: siteId ? [siteId] : [],
        });
      } else {
        workshop = await getWorkshopByLicenseCached(licenseId);
      }
      if (workshop && siteId && Array.isArray(workshop.siteIds) && !workshop.siteIds.includes(siteId)) {
        return res.status(403).json({ error: 'sso_site_not_in_license' });
      }
      const licenseState = evaluateWorkshopLicenseState(workshop);
      if (!licenseState.ok) {
        return res.status(licenseState.statusCode || 403).json({ error: licenseState.error });
      }
    }

    const uid = `sso:${provider.toLowerCase()}:${subject}`;
    if (role !== 'SUPER_ADMIN') {
      const activeCapCheck = await enforceLicenseActiveUserCap({
        licenseId,
        activeUserCap:
          Number(workshop?.activeUserCap || workshop?.expectedUsers || 0) || 0,
        uid,
      });
      if (!activeCapCheck.ok) {
        return res.status(429).json({
          error: activeCapCheck.error,
          activeUsers: activeCapCheck.activeUsers,
          activeUserCap: activeCapCheck.cap,
        });
      }
    }
    const pair = await issueTokenPair(
      {
        uid,
        role,
        email,
        siteId: siteId || null,
        licenseId: licenseId || null,
        orgId: orgId || null,
      },
      req
    );

    await writeAuditEvent({
      action: 'SSO_EXCHANGE_LOGIN',
      actor: { uid, role, email, orgId, licenseId, siteId },
      target: {
        resourceType: 'SSO_PROVIDER',
        resourceId: provider,
        orgId,
        licenseId,
        siteId,
      },
      details: {
        provider,
        groups,
      },
    });

    return res.json({
      ok: true,
      provider,
      userId: uid,
      role,
      email,
      orgId: orgId || null,
      licenseId: licenseId || null,
      siteId: siteId || null,
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      expiresIn: pair.accessTtlSeconds,
    });
  } catch (err) {
    console.error('[/auth/sso/exchange] error:', err);
    return res.status(500).json({ error: 'sso_exchange_failed' });
  }
});

function requireScimAuth(req, res, next) {
  if (!SCIM_BEARER_TOKEN) {
    return res.status(503).json({ error: 'scim_not_configured' });
  }
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== SCIM_BEARER_TOKEN) {
    return res.status(401).json({ error: 'scim_unauthorized' });
  }
  return next();
}

function deterministicScimId(orgId, value) {
  return crypto
    .createHash('sha1')
    .update(`${String(orgId || '').trim().toUpperCase()}:${String(value || '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

function scimUserFromItem(item = {}) {
  const email = normalizeSuperAdminEmail(
    item.primaryEmail ||
      (Array.isArray(item.emails) && item.emails[0]?.value) ||
      item.userName ||
      ''
  );
  return {
    id: item.scimUserId,
    externalId: item.externalId || '',
    userName: item.userName || email || '',
    active: item.active !== false,
    name: item.name || {},
    emails: Array.isArray(item.emails) ? item.emails : email ? [{ value: email, primary: true }] : [],
    groups: Array.isArray(item.groups) ? item.groups : [],
    meta: {
      resourceType: 'User',
      created: item.createdAt ? new Date(Number(item.createdAt)).toISOString() : undefined,
      lastModified: item.updatedAt
        ? new Date(Number(item.updatedAt)).toISOString()
        : undefined,
    },
  };
}

function scimGroupFromItem(item = {}) {
  return {
    id: item.scimGroupId,
    displayName: item.displayName || '',
    externalId: item.externalId || '',
    members: Array.isArray(item.members) ? item.members : [],
    meta: {
      resourceType: 'Group',
      created: item.createdAt ? new Date(Number(item.createdAt)).toISOString() : undefined,
      lastModified: item.updatedAt
        ? new Date(Number(item.updatedAt)).toISOString()
        : undefined,
    },
  };
}

app.get('/scim/v2/Users', requireScimAuth, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.scimUsers,
        KeyConditionExpression: 'orgId = :orgId',
        ExpressionAttributeValues: { ':orgId': orgId },
        ScanIndexForward: true,
        Limit: Math.min(500, Number(req.query?.count || 200)),
      })
    );
    let resources = (Items || []).map(scimUserFromItem);
    const filter = String(req.query?.filter || '').trim();
    const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(filter);
    if (match) {
      const needle = normalizeSuperAdminEmail(match[1]);
      resources = resources.filter((r) => normalizeSuperAdminEmail(r.userName) === needle);
    }
    return res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    });
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      return res.json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      });
    }
    console.error('[/scim/v2/Users GET] error:', err);
    return res.status(500).json({ error: 'scim_users_list_failed' });
  }
});

app.post('/scim/v2/Users', requireScimAuth, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.body?.orgId || '', req.body?.licenseId || '');
    const licenseId = normalizedLicenseId(req.body?.licenseId || '');
    if (!orgId || !licenseId) return res.status(400).json({ error: 'orgId_and_licenseId_required' });
    const userName = String(req.body?.userName || '').trim();
    const externalId = String(req.body?.externalId || '').trim();
    const scimUserId =
      String(req.body?.id || '').trim() ||
      deterministicScimId(orgId, externalId || userName);
    if (!scimUserId || (!userName && !externalId)) {
      return res.status(400).json({ error: 'scim_user_identifier_required' });
    }
    const now = Date.now();
    const active = req.body?.active !== false;
    const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
    const primaryEmail = normalizeSuperAdminEmail(
      req.body?.primaryEmail ||
        emails.find((e) => e?.primary)?.value ||
        emails[0]?.value ||
        userName
    );
    const item = {
      orgId,
      scimUserId,
      externalId,
      userName: userName || primaryEmail,
      active,
      name: req.body?.name || {},
      emails,
      primaryEmail,
      groups: Array.isArray(req.body?.groups) ? req.body.groups : [],
      siteId: normalizedSiteId(req.body?.siteId || ''),
      licenseId,
      role: String(req.body?.role || 'PARTICIPANT').trim().toUpperCase(),
      createdAt: Number(req.body?.createdAt || now),
      updatedAt: now,
    };

    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.scimUsers,
        Item: item,
      })
    );

    await writeAuditEvent({
      action: 'SCIM_USER_UPSERT',
      actor: { uid: 'scim', role: 'SYSTEM', orgId, licenseId },
      target: { resourceType: 'SCIM_USER', resourceId: scimUserId, orgId, licenseId, siteId: item.siteId },
      details: { active, userName: item.userName },
    });

    return res.status(201).json(scimUserFromItem(item));
  } catch (err) {
    console.error('[/scim/v2/Users POST] error:', err);
    return res.status(500).json({ error: 'scim_user_upsert_failed' });
  }
});

app.put('/scim/v2/Users/:id', requireScimAuth, async (req, res) => {
  try {
    const scimUserId = String(req.params?.id || '').trim();
    const orgId = normalizedOrgId(req.body?.orgId || req.query?.orgId || '', req.body?.licenseId || req.query?.licenseId || '');
    if (!scimUserId || !orgId) return res.status(400).json({ error: 'orgId_and_id_required' });
    const { Item } = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.scimUsers,
        Key: { orgId, scimUserId },
      })
    );
    const next = {
      ...(Item || { orgId, scimUserId, createdAt: Date.now() }),
      externalId: String(req.body?.externalId ?? Item?.externalId ?? '').trim(),
      userName: String(req.body?.userName ?? Item?.userName ?? '').trim(),
      active: req.body?.active !== false,
      name: req.body?.name ?? Item?.name ?? {},
      emails: Array.isArray(req.body?.emails) ? req.body.emails : Item?.emails || [],
      groups: Array.isArray(req.body?.groups) ? req.body.groups : Item?.groups || [],
      siteId: normalizedSiteId(req.body?.siteId ?? Item?.siteId ?? ''),
      licenseId: normalizedLicenseId(req.body?.licenseId ?? Item?.licenseId ?? ''),
      role: String(req.body?.role ?? Item?.role ?? 'PARTICIPANT').trim().toUpperCase(),
      updatedAt: Date.now(),
    };
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.scimUsers,
        Item: next,
      })
    );
    await writeAuditEvent({
      action: 'SCIM_USER_UPSERT',
      actor: { uid: 'scim', role: 'SYSTEM', orgId, licenseId: next.licenseId },
      target: { resourceType: 'SCIM_USER', resourceId: scimUserId, orgId, licenseId: next.licenseId, siteId: next.siteId },
      details: { active: next.active, userName: next.userName },
    });
    return res.json(scimUserFromItem(next));
  } catch (err) {
    console.error('[/scim/v2/Users/:id PUT] error:', err);
    return res.status(500).json({ error: 'scim_user_update_failed' });
  }
});

app.delete('/scim/v2/Users/:id', requireScimAuth, async (req, res) => {
  try {
    const scimUserId = String(req.params?.id || '').trim();
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (!scimUserId || !orgId) return res.status(400).json({ error: 'orgId_and_id_required' });
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.scimUsers,
        Key: { orgId, scimUserId },
        UpdateExpression: 'SET active = :false, updatedAt = :now',
        ExpressionAttributeValues: {
          ':false': false,
          ':now': Date.now(),
        },
      })
    );
    await writeAuditEvent({
      action: 'SCIM_USER_DEACTIVATE',
      actor: { uid: 'scim', role: 'SYSTEM', orgId },
      target: { resourceType: 'SCIM_USER', resourceId: scimUserId, orgId },
      details: { active: false },
    });
    return res.status(204).end();
  } catch (err) {
    console.error('[/scim/v2/Users/:id DELETE] error:', err);
    return res.status(500).json({ error: 'scim_user_delete_failed' });
  }
});

app.get('/scim/v2/Groups', requireScimAuth, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.scimGroups,
        KeyConditionExpression: 'orgId = :orgId',
        ExpressionAttributeValues: { ':orgId': orgId },
        ScanIndexForward: true,
        Limit: Math.min(500, Number(req.query?.count || 200)),
      })
    );
    const resources = (Items || []).map(scimGroupFromItem);
    return res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    });
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      return res.json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      });
    }
    console.error('[/scim/v2/Groups GET] error:', err);
    return res.status(500).json({ error: 'scim_groups_list_failed' });
  }
});

app.post('/scim/v2/Groups', requireScimAuth, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.body?.orgId || '', req.body?.licenseId || '');
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const displayName = String(req.body?.displayName || '').trim();
    const externalId = String(req.body?.externalId || '').trim();
    const scimGroupId =
      String(req.body?.id || '').trim() ||
      deterministicScimId(orgId, externalId || displayName);
    if (!scimGroupId || (!displayName && !externalId)) {
      return res.status(400).json({ error: 'scim_group_identifier_required' });
    }
    const now = Date.now();
    const item = {
      orgId,
      scimGroupId,
      externalId,
      displayName: displayName || externalId || scimGroupId,
      members: Array.isArray(req.body?.members) ? req.body.members : [],
      createdAt: Number(req.body?.createdAt || now),
      updatedAt: now,
    };
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.scimGroups,
        Item: item,
      })
    );
    await writeAuditEvent({
      action: 'SCIM_GROUP_UPSERT',
      actor: { uid: 'scim', role: 'SYSTEM', orgId },
      target: { resourceType: 'SCIM_GROUP', resourceId: scimGroupId, orgId },
      details: { displayName: item.displayName, memberCount: item.members.length },
    });
    return res.status(201).json(scimGroupFromItem(item));
  } catch (err) {
    console.error('[/scim/v2/Groups POST] error:', err);
    return res.status(500).json({ error: 'scim_group_upsert_failed' });
  }
});

app.patch('/scim/v2/Groups/:id', requireScimAuth, async (req, res) => {
  try {
    const scimGroupId = String(req.params?.id || '').trim();
    const orgId = normalizedOrgId(req.body?.orgId || req.query?.orgId || '', req.body?.licenseId || req.query?.licenseId || '');
    if (!scimGroupId || !orgId) return res.status(400).json({ error: 'orgId_and_id_required' });
    const { Item } = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.scimGroups,
        Key: { orgId, scimGroupId },
      })
    );
    const operations = Array.isArray(req.body?.Operations) ? req.body.Operations : [];
    let members = Array.isArray(Item?.members) ? Item.members.slice() : [];
    for (const op of operations) {
      const opName = String(op?.op || '').trim().toLowerCase();
      if (opName === 'replace' && Array.isArray(op?.value?.members)) {
        members = op.value.members;
      }
      if (opName === 'add' && Array.isArray(op?.value?.members)) {
        members = [...members, ...op.value.members];
      }
      if (opName === 'remove' && Array.isArray(op?.value?.members)) {
        const removeIds = new Set(op.value.members.map((m) => String(m?.value || '')));
        members = members.filter((m) => !removeIds.has(String(m?.value || '')));
      }
    }
    const deduped = [];
    const seen = new Set();
    for (const m of members) {
      const v = String(m?.value || '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      deduped.push({ value: v, display: String(m?.display || '').trim() });
    }
    const next = {
      ...(Item || { orgId, scimGroupId, createdAt: Date.now() }),
      displayName: String(req.body?.displayName ?? Item?.displayName ?? '').trim() || Item?.displayName || scimGroupId,
      members: deduped,
      updatedAt: Date.now(),
    };
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.scimGroups,
        Item: next,
      })
    );
    await writeAuditEvent({
      action: 'SCIM_GROUP_MEMBERS_SYNC',
      actor: { uid: 'scim', role: 'SYSTEM', orgId },
      target: { resourceType: 'SCIM_GROUP', resourceId: scimGroupId, orgId },
      details: { memberCount: next.members.length },
    });
    return res.json(scimGroupFromItem(next));
  } catch (err) {
    console.error('[/scim/v2/Groups/:id PATCH] error:', err);
    return res.status(500).json({ error: 'scim_group_patch_failed' });
  }
});

const TENANT_BOOTSTRAP_PATH_PREFIXES = [
  '/codes/consume',
  '/admin/auth/consume',
  '/super-admin/auth/email',
  '/auth/refresh',
  '/auth/logout',
  '/auth/sessions',
];

function isTenantBootstrapPath(pathname) {
  const p = String(pathname || '').trim();
  if (!p) return false;
  return TENANT_BOOTSTRAP_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

async function getWorkshopByLicenseCached(licenseIdRaw) {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (!licenseId) return null;
  const now = Date.now();
  const cached = tenantWorkshopCache.get(licenseId);
  if (cached && now - Number(cached.loadedAt || 0) < TENANT_WORKSHOP_CACHE_MS) {
    return cached.workshop || null;
  }
  const workshop = await getWorkshopConfig(licenseId);
  tenantWorkshopCache.set(licenseId, { workshop: workshop || null, loadedAt: now });
  return workshop || null;
}

function clearWorkshopTenantCache(licenseIdRaw = '') {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (licenseId) tenantWorkshopCache.delete(licenseId);
}

function tenantTargetsFromRequest(req) {
  const targets = collectTenantTargetsFromRequest({
    params: req.params || {},
    query: req.query || {},
    body: req.body || {},
  });
  const licenseId = normalizedLicenseId(targets.licenseId || '');
  const orgId = normalizedOrgId(targets.orgId || '', licenseId);
  const siteIds = sanitizeSiteIds(targets.siteIds || [], []);
  return { orgId, licenseId, siteIds };
}

function enforceTenantRequestScope(req, user, workshop = null) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return { ok: true };
  if (isTenantBootstrapPath(req.path)) return { ok: true };

  const userLicenseId = normalizedLicenseId(user?.licenseId || '');
  const userOrgId = normalizedOrgId(user?.orgId || '', userLicenseId);
  const userSiteId = normalizedSiteId(user?.siteId || '');
  const targets = tenantTargetsFromRequest(req);
  if (!targets.orgId && !targets.licenseId && !targets.siteIds.length) {
    return { ok: true };
  }

  const targetLicenseId = normalizedLicenseId(targets.licenseId || userLicenseId);
  const targetOrgId = normalizedOrgId(targets.orgId || userOrgId, targetLicenseId || userLicenseId);
  const licensedSiteIds =
    role === 'ADMIN' ? [] : sanitizeSiteIds(workshop?.siteIds, []);
  const candidateSites = targets.siteIds.length ? targets.siteIds : [''];

  for (const targetSiteId of candidateSites) {
    const tenantCheck = evaluateTenantHierarchy({
      role,
      userOrgId,
      userLicenseId,
      userSiteId,
      targetOrgId,
      targetLicenseId,
      targetSiteId: normalizedSiteId(targetSiteId || ''),
      licensedSiteIds,
    });
    if (!tenantCheck.allowed) {
      return { ok: false, error: tenantCheck.reason || 'tenant_forbidden' };
    }
  }

  return { ok: true };
}

function evaluateWorkshopLicenseState(workshop) {
  if (!workshop || typeof workshop !== 'object') return { ok: true };
  const status = String(workshop.licenseStatus || 'ACTIVE').trim().toUpperCase();
  const expiresAt = Number(workshop.licenseExpiresAt || 0);
  if (status === 'SUSPENDED') {
    return { ok: false, error: 'license_suspended', statusCode: 423 };
  }
  if (status === 'EXPIRED') {
    return { ok: false, error: 'license_expired', statusCode: 402 };
  }
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() >= expiresAt) {
    return { ok: false, error: 'license_expired', statusCode: 402 };
  }
  return { ok: true };
}

async function enforceTenantClaims(req, user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return { ok: true };
  if (isTenantBootstrapPath(req.path)) return { ok: true };

  const orgId = normalizedOrgId(user?.orgId || '', user?.licenseId || '');
  const licenseId = normalizedLicenseId(user?.licenseId || '');
  const siteId = normalizedSiteId(user?.siteId || '');
  if (!orgId || !licenseId) {
    return { ok: false, error: 'tenant_claims_required' };
  }
  if ((role === 'PARTICIPANT' || role === 'PRESENTER') && !siteId) {
    return { ok: false, error: 'tenant_site_required' };
  }

  let workshop = null;
  try {
    workshop = await getWorkshopByLicenseCached(licenseId);
  } catch (err) {
    console.warn('[tenant] workshop lookup failed:', err?.message || err);
  }

  if (workshop) {
    const workshopOrgId = normalizedOrgId(workshop.orgId || '', workshop.licenseId || licenseId);
    if (workshopOrgId && workshopOrgId !== orgId) {
      return { ok: false, error: 'tenant_org_mismatch' };
    }

    const sites = sanitizeSiteIds(workshop.siteIds, []);
    if (siteId && sites.length && !sites.includes(siteId)) {
      return { ok: false, error: 'tenant_site_mismatch' };
    }

    const licenseState = evaluateWorkshopLicenseState(workshop);
    if (!licenseState.ok) {
      return { ok: false, error: licenseState.error };
    }
  }

  return { ok: true, workshop };
}

function extractAuthToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string') {
    return queryToken.trim();
  }
  return '';
}

async function requireAuth(req, res, next) {
  try {
    const token = extractAuthToken(req);
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const claims = verifySessionToken(token, { secret: JWT_SECRET });
    if (String(claims.tokenType || 'access').toLowerCase() !== 'access') {
      return res.status(401).json({ error: 'access_token_required' });
    }
    req.user = {
      uid: claims.uid,
      role: claims.role,
      siteId: claims.siteId || null,
      licenseId: claims.licenseId || null,
      orgId: claims.orgId || null,
      email: claims.email || null,
      exp: claims.exp,
      sessionId: claims.sessionId || null,
    };
    req.userToken = token;
    if (req.user.sessionId) {
      const session = await getAuthSessionRecord(req.user.uid, req.user.sessionId);
      if (!session || !!session.revoked) {
        return res.status(401).json({ error: 'session_revoked' });
      }
      void touchAuthSession(req.user.uid, req.user.sessionId, req);
    }
    const tenantCheck = await enforceTenantClaims(req, req.user);
    if (!tenantCheck.ok) {
      return res.status(403).json({ error: tenantCheck.error || 'tenant_forbidden' });
    }
    req.tenantWorkshop = tenantCheck.workshop || null;
    const tenantScopeCheck = enforceTenantRequestScope(
      req,
      req.user,
      req.tenantWorkshop
    );
    if (!tenantScopeCheck.ok) {
      return res
        .status(403)
        .json({ error: tenantScopeCheck.error || 'tenant_forbidden' });
    }
    const entitlementCheck = await enforceRuntimeLicenseEntitlements({
      role: req.user.role,
      licenseId: req.user.licenseId,
      orgId: req.user.orgId,
      siteId: req.user.siteId,
      workshop: req.tenantWorkshop,
      automate: true,
      bypassAdmin: true,
    });
    if (!entitlementCheck.ok) {
      return res.status(entitlementCheck.statusCode || 403).json({
        error: entitlementCheck.error || 'license_forbidden',
        usageCap: Number(entitlementCheck.usageCap || 0) || undefined,
        meteredUnits: Number(entitlementCheck.meteredUnits || 0) || undefined,
        overageUnits: Number(entitlementCheck.overageUnits || 0) || undefined,
      });
    }
    req.entitlements = entitlementCheck;
    touchSessionHeartbeat(req.user, req);
    return next();
  } catch (err) {
    console.error('[requireAuth] error', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Presenter gating is token-based (never trust client role headers)
function isPresenterReq(req) {
  return String(req.user?.role || '').toUpperCase() === 'PRESENTER';
}
function requirePresenter(req, res, next) {
  if (!isPresenterReq(req)) {
    return res.status(403).json({ error: 'presenter_only' });
  }
  return next();
}

function isAdminReq(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}
function requireAdmin(req, res, next) {
  if (!isAdminReq(req)) {
    return res.status(403).json({ error: 'admin_only' });
  }
  return next();
}

function isSuperAdminReq(req) {
  return String(req.user?.role || '').toUpperCase() === 'SUPER_ADMIN';
}
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminReq(req)) {
    return res.status(403).json({ error: 'super_admin_only' });
  }
  const email = normalizeSuperAdminEmail(req.user?.email);
  if (email !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ error: 'super_admin_email_not_allowed' });
  }
  return next();
}

function normalizedSiteId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedLicenseId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedOrgId(value, fallbackLicenseId = '') {
  const direct = String(value || '').trim().toUpperCase();
  if (direct) return direct;
  const license = normalizedLicenseId(fallbackLicenseId);
  if (!license) return '';
  return `ORG-${license}`;
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function computeRetentionTtlSeconds(days) {
  const safeDays = Math.max(1, Number(days || 1));
  return nowEpochSeconds() + safeDays * 24 * 60 * 60;
}

function pruneSessionHeartbeatCache(now = Date.now()) {
  if (sessionHeartbeatCache.size < 2500) return;
  const staleMs = SESSION_HEARTBEAT_MS * 4;
  for (const [uid, lastSeenMs] of sessionHeartbeatCache.entries()) {
    if (now - Number(lastSeenMs || 0) > staleMs) {
      sessionHeartbeatCache.delete(uid);
    }
  }
}

function touchSessionHeartbeat(user, req) {
  const uid = String(user?.uid || '').trim();
  if (!uid) return;

  const now = Date.now();
  const prev = Number(sessionHeartbeatCache.get(uid) || 0);
  if (now - prev < SESSION_HEARTBEAT_MS) return;
  sessionHeartbeatCache.set(uid, now);
  pruneSessionHeartbeatCache(now);

  const role = String(user?.role || 'PARTICIPANT').toUpperCase();
  const siteId = normalizedSiteId(user?.siteId || 'UNASSIGNED');
  const licenseId = normalizedLicenseId(user?.licenseId || '');
  const orgId = normalizedOrgId(user?.orgId || '', licenseId);
  const email = normalizeSuperAdminEmail(user?.email || '');
  const ip = String(req?.ip || req?.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
    .slice(0, 120);
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 300);
  const sessionRetentionHours = toPositiveInt(
    req?.tenantWorkshop?.sessionRetentionHours,
    SESSION_TTL_HOURS,
    { min: 1, max: 24 * 365 }
  );
  const expiresAt = nowEpochSeconds() + sessionRetentionHours * 60 * 60;

  void ddbDoc
    .send(
      new UpdateCommand({
        TableName: TABLES.sessions,
        Key: { uid },
        UpdateExpression: [
          'SET #role = :role',
          '#siteId = :siteId',
          '#licenseId = :licenseId',
          '#orgId = :orgId',
          '#email = :email',
          '#lastSeenAt = :lastSeenAt',
          '#lastSeenIso = :lastSeenIso',
          '#ip = :ip',
          '#userAgent = :userAgent',
          '#expiresAt = :expiresAt',
        ].join(', '),
        ExpressionAttributeNames: {
          '#role': 'role',
          '#siteId': 'siteId',
          '#licenseId': 'licenseId',
          '#orgId': 'orgId',
          '#email': 'email',
          '#lastSeenAt': 'lastSeenAt',
          '#lastSeenIso': 'lastSeenIso',
          '#ip': 'ip',
          '#userAgent': 'userAgent',
          '#expiresAt': 'expiresAt',
        },
        ExpressionAttributeValues: {
          ':role': role,
          ':siteId': siteId || 'UNASSIGNED',
          ':licenseId': licenseId || '',
          ':orgId': orgId || '',
          ':email': email || '',
          ':lastSeenAt': now,
          ':lastSeenIso': new Date(now).toISOString(),
          ':ip': ip || '',
          ':userAgent': userAgent || '',
          ':expiresAt': expiresAt,
        },
      })
    )
    .catch((err) => {
      if (err?.name === 'ResourceNotFoundException') {
        if (!sessionsTableMissingWarned) {
          console.warn(
            `[sessions] table '${TABLES.sessions}' missing; session heartbeat disabled`
          );
          sessionsTableMissingWarned = true;
        }
        return;
      }
      if (shouldUseDemoFallback(err)) {
        logDemoFallback('session_heartbeat', err);
        return;
      }
      console.warn('[sessions] heartbeat write skipped:', err?.message || err);
    });
}

function hashTokenValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function extractClientIp(req) {
  return String(req?.ip || req?.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
    .slice(0, 120);
}

function extractUserAgent(req) {
  return String(req?.headers?.['user-agent'] || '').slice(0, 300);
}

async function saveAuthSessionRecord({
  uid,
  role,
  siteId = '',
  licenseId = '',
  orgId = '',
  email = '',
  sessionId,
  refreshJti,
  req = null,
  revoked = false,
  createdAt = Date.now(),
} = {}) {
  if (!uid || !sessionId) return;
  const now = Date.now();
  const refreshHash = hashTokenValue(refreshJti || '');
  const normalizedSite = normalizedSiteId(siteId || '');
  const normalizedLicense = normalizedLicenseId(licenseId || '');
  const normalizedOrg = normalizedOrgId(orgId || '', normalizedLicense);
  const normalizedEmail = normalizeSuperAdminEmail(email || '');
  const item = {
    uid: String(uid).trim(),
    sessionId: String(sessionId).trim(),
    role: String(role || 'PARTICIPANT').toUpperCase(),
    refreshHash,
    revoked: !!revoked,
    createdAt: Number(createdAt || now),
    updatedAt: now,
    lastSeenAt: now,
    ip: extractClientIp(req),
    userAgent: extractUserAgent(req),
    expiresAt: nowEpochSeconds() + Math.ceil(REFRESH_TOKEN_TTL_SECONDS),
  };
  if (normalizedSite) item.siteId = normalizedSite;
  if (normalizedLicense) item.licenseId = normalizedLicense;
  if (normalizedOrg) item.orgId = normalizedOrg;
  if (normalizedEmail) item.email = normalizedEmail;

  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.authSessions,
        Item: item,
      })
    );
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('auth_session_put', err);
    saveDemoAuthSessionRecord(item);
  }
}

async function getAuthSessionRecord(uid, sessionId) {
  if (!uid || !sessionId) return null;
  try {
    const { Item } = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.authSessions,
        Key: { uid: String(uid).trim(), sessionId: String(sessionId).trim() },
      })
    );
    return Item || null;
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return null;
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('auth_session_get', err);
      return getDemoAuthSessionRecord(uid, sessionId);
    }
    throw err;
  }
}

async function revokeAuthSession(uid, sessionId) {
  if (!uid || !sessionId) return;
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.authSessions,
        Key: { uid: String(uid).trim(), sessionId: String(sessionId).trim() },
        UpdateExpression: 'SET revoked = :true, updatedAt = :now',
        ExpressionAttributeValues: {
          ':true': true,
          ':now': Date.now(),
        },
      })
    );
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('auth_session_revoke', err);
    revokeDemoAuthSession(uid, sessionId);
  }
}

async function listAuthSessions(uid, limit = 50) {
  if (!uid) return [];
  try {
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.authSessions,
        KeyConditionExpression: 'uid = :uid',
        ExpressionAttributeValues: {
          ':uid': String(uid).trim(),
        },
        ScanIndexForward: false,
        Limit: Math.min(200, limit),
      })
    );
    return Items || [];
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return [];
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('auth_session_list', err);
      return listDemoAuthSessions(uid, limit);
    }
    throw err;
  }
}

async function revokeAllAuthSessions(uid) {
  const sessions = await listAuthSessions(uid, 200);
  for (const sess of sessions) {
    if (!sess?.sessionId) continue;
    // eslint-disable-next-line no-await-in-loop
    await revokeAuthSession(uid, sess.sessionId);
  }
}

async function touchAuthSession(uid, sessionId, req) {
  if (!uid || !sessionId) return;
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.authSessions,
        Key: { uid: String(uid).trim(), sessionId: String(sessionId).trim() },
        UpdateExpression:
          'SET lastSeenAt = :now, updatedAt = :now, ip = :ip, userAgent = :ua',
        ExpressionAttributeValues: {
          ':now': Date.now(),
          ':ip': extractClientIp(req),
          ':ua': extractUserAgent(req),
        },
      })
    );
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return;
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('auth_session_touch', err);
      touchDemoAuthSession(uid, sessionId, req);
      return;
    }
    console.warn('[auth session] touch failed:', err?.message || err);
  }
}

async function issueTokenPair(claims = {}, req = null, { sessionId = '' } = {}) {
  const uid = String(claims.uid || '').trim();
  if (!uid) throw new Error('uid_required_for_token_pair');

  const sid = String(sessionId || crypto.randomUUID()).trim();
  const refreshJti = crypto.randomUUID();
  const commonClaims = {
    uid,
    role: claims.role || 'PARTICIPANT',
    siteId: claims.siteId || null,
    licenseId: claims.licenseId || null,
    orgId: claims.orgId || null,
    email: claims.email || null,
    sessionId: sid,
  };

  const accessToken = createSessionToken(
    {
      ...commonClaims,
      tokenType: 'access',
      jti: crypto.randomUUID(),
    },
    { secret: JWT_SECRET, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS }
  );
  const refreshToken = createSessionToken(
    {
      ...commonClaims,
      tokenType: 'refresh',
      jti: refreshJti,
    },
    { secret: JWT_SECRET, ttlSeconds: REFRESH_TOKEN_TTL_SECONDS }
  );

  await saveAuthSessionRecord({
    ...commonClaims,
    uid,
    sessionId: sid,
    refreshJti,
    req,
  });

  return {
    accessToken,
    refreshToken,
    sessionId: sid,
    accessTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
  };
}

function requirePresenterSiteMatchFromQuery(req, res, next) {
  const tokenSiteId = normalizedSiteId(req.user?.siteId);
  const requestedSiteId = normalizedSiteId(req.query?.siteId);

  if (!requestedSiteId) return res.status(400).json({ error: 'siteId required' });
  if (!tokenSiteId || tokenSiteId !== requestedSiteId) {
    return res.status(403).json({ error: 'site_forbidden' });
  }
  const workshopSites = sanitizeSiteIds(req.tenantWorkshop?.siteIds, []);
  if (workshopSites.length && !workshopSites.includes(requestedSiteId)) {
    return res.status(403).json({ error: 'tenant_site_mismatch' });
  }
  return next();
}

function requirePresenterRoomScope(req, res, next) {
  const tokenSiteId = normalizedSiteId(req.user?.siteId);
  const roomSiteId = parseRoomId(req.params.roomId).siteId;

  if (!tokenSiteId || tokenSiteId !== roomSiteId) {
    return res.status(403).json({ error: 'site_forbidden' });
  }
  const workshopSites = sanitizeSiteIds(req.tenantWorkshop?.siteIds, []);
  if (workshopSites.length && !workshopSites.includes(roomSiteId)) {
    return res.status(403).json({ error: 'tenant_site_mismatch' });
  }
  return next();
}

function requireAdminLicense(req, res, next) {
  const licenseId = normalizedLicenseId(req.user?.licenseId);
  if (!licenseId) {
    return res.status(403).json({ error: 'license_forbidden' });
  }
  return next();
}

function seatMembershipForUid(room, uid) {
  const target = String(uid || '').trim();
  if (!target) return false;
  const seatUids = Array.isArray(room?.seatUids)
    ? room.seatUids.map((s) => String(s || '').trim())
    : [];
  if (seatUids.includes(target)) return true;

  const seats = Array.isArray(room?.seats) ? room.seats : [];
  return seats.some((seat) => String(seat?.uid || '').trim() === target);
}

async function adminCanAccessRoom(adminUser, roomSiteId) {
  const role = String(adminUser?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return true;
  if (role !== 'ADMIN') return false;

  const tokenSite = normalizedSiteId(adminUser?.siteId);
  const licenseId = normalizedLicenseId(adminUser?.licenseId);
  if (!licenseId) return false;

  try {
    const workshop = await getWorkshopConfig(licenseId);
    const allowedSites = sanitizeSiteIds(workshop?.siteIds, tokenSite ? [tokenSite] : []);
    return allowedSites.includes(roomSiteId);
  } catch (err) {
    console.warn('[authz] admin room access fallback:', err?.message || err);
    return !!tokenSite && tokenSite === roomSiteId;
  }
}

async function requireRoomAccess(req, res, next) {
  try {
    const roomId = String(req.params?.roomId || '').trim();
    if (!roomId) {
      return res.status(400).json({ error: 'roomId required' });
    }

    const room = await ensureRoom(roomId);
    const roomSiteId = normalizedSiteId(room.siteId || parseRoomId(roomId).siteId);
    const tokenSiteId = normalizedSiteId(req.user?.siteId);
    const role = String(req.user?.role || '').trim().toUpperCase();
    const userLicenseId = normalizedLicenseId(req.user?.licenseId || '');
    const userOrgId = normalizedOrgId(req.user?.orgId || '', userLicenseId);
    const roomLicenseId = normalizedLicenseId(room.licenseId || '');
    const roomOrgId = normalizedOrgId(room.orgId || '', roomLicenseId);
    const tenantCheck = evaluateTenantHierarchy({
      role,
      userOrgId,
      userLicenseId,
      userSiteId: tokenSiteId,
      targetOrgId: roomOrgId,
      targetLicenseId: roomLicenseId,
      targetSiteId: roomSiteId,
      licensedSiteIds: sanitizeSiteIds(req.tenantWorkshop?.siteIds, []),
    });
    if (!tenantCheck.allowed) {
      return res.status(403).json({ error: tenantCheck.reason || 'tenant_forbidden' });
    }

    const adminAllowed =
      role === 'ADMIN' ? await adminCanAccessRoom(req.user, roomSiteId) : false;
    const membershipAllowed = seatMembershipForUid(room, req.user?.uid);
    const authz = evaluateRoomAccess({
      role,
      tokenSiteId,
      roomSiteId,
      isSeatMember: membershipAllowed,
      adminAllowed,
    });
    if (!authz.allowed) {
      return res.status(403).json({ error: authz.reason || 'room_forbidden' });
    }

    const progressed = await advanceRoomTimeline(roomId, { room });
    req.room = progressed || room;
    return next();
  } catch (err) {
    console.error('[requireRoomAccess] error:', err);
    return res.status(500).json({ error: 'room_access_failed' });
  }
}

// ---------- Helpers ----------
const DEFAULT_STAGE = 'LOBBY';
const ROOM_ORDER = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
];
const STAGE_SET = new Set(ROOM_ORDER);

// Align durations with UI (Room.jsx TOTAL_BY_STAGE) — milliseconds
const STAGE_DURATIONS = {
  LOBBY: 1200 * 1000, // 20 min
  DISCOVERY: 600 * 1000, // 10 min
  IDEA_DUMP: 600 * 1000, // 10 min
  PLANNING: 600 * 1000, // 10 min
  ROUGH_DRAFT: 240 * 1000, // 4 min
  EDITING: 600 * 1000, // 10 min
  FINAL: 360 * 1000, // 6 min
};
function getStageDuration(stage) {
  return STAGE_DURATIONS[stage] || 6 * 60_000;
}

function getRoomStageDurationMs(room, stage) {
  const idx = ROOM_ORDER.indexOf(stage || DEFAULT_STAGE);
  if (idx >= 0 && idx < ROOM_ORDER.length - 1) {
    const phase = Array.isArray(room?.phasePlan) ? room.phasePlan[idx] : null;
    const customSec = Number(phase?.durationSec || 0);
    if (Number.isFinite(customSec) && customSec > 0) {
      return customSec * 1000;
    }
  }
  return getStageDuration(stage);
}

const DEFAULT_WORKSHOP_MODE = 'HIDDEN_GENIUS';
const DEFAULT_EXPECTED_USERS = 30;
const DEFAULT_SEAT_LIMIT_PER_ROOM = 6;
const MAX_ROOMS_PER_SITE = 40;
const MAX_SEAT_LIMIT_PER_ROOM = 24;
const MAX_PHASE_COUNT = 24;
const DEFAULT_ASSISTANT_PERSONA =
  'Warm, direct, practical facilitator that keeps teams on track and focused on outcomes.';

const WORKSHOP_MODE_TEMPLATES = Object.freeze({
  HIDDEN_GENIUS: {
    id: 'HIDDEN_GENIUS',
    label: 'Hidden Genius Project',
    description:
      'Teams uncover community truths through collaborative story building with AI guidance.',
    defaultPhases: [
      { title: 'Context Circle', durationSec: 600, goal: 'Name the issue and community impact.' },
      { title: 'Discovery', durationSec: 900, goal: 'Share lived examples and key evidence.' },
      { title: 'Story Architecture', durationSec: 900, goal: 'Define protagonist, conflict, and stakes.' },
      { title: 'Drafting', durationSec: 900, goal: 'Co-create first story draft with AI.' },
      { title: 'Truth Edit', durationSec: 600, goal: 'Sharpen facts, voice, and accountability.' },
      { title: 'Final Share', durationSec: 600, goal: 'Publish final abstract and call to action.' },
    ],
    defaultTopics: [
      'Law Enforcement Profiling',
      'Food Deserts',
      'Red Lining',
      'Homelessness',
      'Wealth Gap',
    ],
  },
  CREATIVE_WRITING: {
    id: 'CREATIVE_WRITING',
    label: 'Creative Writing Workshop',
    description:
      'Groups move from prompt to polished narrative through collaborative writing phases.',
    defaultPhases: [
      { title: 'Prompt Warmup', durationSec: 600, goal: 'Align on writing prompt and POV.' },
      { title: 'Brainstorm', durationSec: 900, goal: 'Generate characters, scenes, and tensions.' },
      { title: 'Outline', durationSec: 900, goal: 'Lock narrative structure and key beats.' },
      { title: 'Draft', durationSec: 900, goal: 'Draft full piece with AI guidance.' },
      { title: 'Peer Edit', durationSec: 600, goal: 'Revise clarity, tone, and impact.' },
      { title: 'Readout', durationSec: 600, goal: 'Share final version with group.' },
    ],
    defaultTopics: [],
  },
  PROJECT_IDEATION: {
    id: 'PROJECT_IDEATION',
    label: 'Project Ideation Sprint',
    description:
      'Cross-functional teams identify problems, design solutions, and leave with an execution-ready concept.',
    defaultPhases: [
      { title: 'Problem Framing', durationSec: 600, goal: 'Define target user and pain point.' },
      { title: 'Opportunity Mapping', durationSec: 900, goal: 'Expand solution possibilities quickly.' },
      { title: 'Concept Selection', durationSec: 900, goal: 'Choose one concept and scope it.' },
      { title: 'Execution Plan', durationSec: 900, goal: 'Draft milestones, owners, and risks.' },
      { title: 'Pitch Polish', durationSec: 600, goal: 'Prepare concise pitch and value narrative.' },
      { title: 'Commitment Round', durationSec: 600, goal: 'Confirm next actions and owners.' },
    ],
    defaultTopics: [],
  },
  RESTORATIVE_CIRCLE: {
    id: 'RESTORATIVE_CIRCLE',
    label: 'Restorative Circle',
    description:
      'Teams surface tensions safely, identify root causes, and co-design repair commitments.',
    defaultPhases: [
      { title: 'Safety Agreements', durationSec: 600, goal: 'Establish norms and intentions.' },
      { title: 'Shared Facts', durationSec: 900, goal: 'Document what happened without blame.' },
      { title: 'Impact Reflection', durationSec: 900, goal: 'Express impact and unmet needs.' },
      { title: 'Repair Options', durationSec: 900, goal: 'Generate realistic repair actions.' },
      { title: 'Agreement Draft', durationSec: 600, goal: 'Write ownership and follow-through plan.' },
      { title: 'Close & Follow-Up', durationSec: 600, goal: 'Confirm commitments and check-in cadence.' },
    ],
    defaultTopics: [],
  },
});

function toPositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeMode(value) {
  const key = String(value || '').trim().toUpperCase();
  return WORKSHOP_MODE_TEMPLATES[key] ? key : DEFAULT_WORKSHOP_MODE;
}

function sanitizeSiteIds(siteIds, fallback = []) {
  const raw = Array.isArray(siteIds) ? siteIds : fallback;
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const site = normalizedSiteId(entry);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    out.push(site);
  }
  return out;
}

function normalizeTopicCatalog(input) {
  const raw = Array.isArray(input) ? input : [];
  return raw
    .map((topic) => String(topic || '').trim())
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeAiBehavior(value) {
  const key = String(value || '').trim().toUpperCase();
  if (key === 'BACKGROUND' || key === 'GUIDE' || key === 'HELPER') return key;
  return 'GUIDE';
}

const AUTOPILOT_DEFAULT = Object.freeze({
  enabled: false,
  autoNudgeOnStuck: true,
  autoVote: true,
  autoAdvance: true,
  nudgeBeforeEndSec: 45,
  stuckInactivitySec: 120,
  interventionExtendSec: 120,
});

function normalizeAutopilotConfig(input = {}, fallback = AUTOPILOT_DEFAULT) {
  const base =
    fallback && typeof fallback === 'object' ? fallback : AUTOPILOT_DEFAULT;
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled:
      src.enabled === undefined ? !!base.enabled : !!src.enabled,
    autoNudgeOnStuck:
      src.autoNudgeOnStuck === undefined
        ? !!base.autoNudgeOnStuck
        : !!src.autoNudgeOnStuck,
    autoVote:
      src.autoVote === undefined ? !!base.autoVote : !!src.autoVote,
    autoAdvance:
      src.autoAdvance === undefined ? !!base.autoAdvance : !!src.autoAdvance,
    nudgeBeforeEndSec: toPositiveInt(
      src.nudgeBeforeEndSec,
      toPositiveInt(base.nudgeBeforeEndSec, AUTOPILOT_DEFAULT.nudgeBeforeEndSec, {
        min: 10,
        max: 300,
      }),
      { min: 10, max: 300 }
    ),
    stuckInactivitySec: toPositiveInt(
      src.stuckInactivitySec,
      toPositiveInt(base.stuckInactivitySec, AUTOPILOT_DEFAULT.stuckInactivitySec, {
        min: 30,
        max: 900,
      }),
      { min: 30, max: 900 }
    ),
    interventionExtendSec: toPositiveInt(
      src.interventionExtendSec,
      toPositiveInt(base.interventionExtendSec, AUTOPILOT_DEFAULT.interventionExtendSec, {
        min: 30,
        max: 600,
      }),
      { min: 30, max: 600 }
    ),
  };
}

const LICENSE_TIERS = ['STARTER', 'PRO', 'ENTERPRISE'];
const LICENSE_STATES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'TRIAL'];
const APPROVAL_STATES = ['PENDING', 'APPROVED', 'REJECTED'];
const TEMPLATE_STATES = ['DRAFT', 'PUBLISHED', 'DEPRECATED'];
const INCIDENT_STATES = ['OPEN', 'MONITORING', 'RESOLVED'];

const FEATURE_FLAG_DEFAULTS_BY_TIER = Object.freeze({
  STARTER: {
    sso: false,
    scim: false,
    advancedTemplates: false,
    auditExport: false,
    aiPolicyControls: true,
    supportEscalation: false,
  },
  PRO: {
    sso: true,
    scim: false,
    advancedTemplates: true,
    auditExport: true,
    aiPolicyControls: true,
    supportEscalation: true,
  },
  ENTERPRISE: {
    sso: true,
    scim: true,
    advancedTemplates: true,
    auditExport: true,
    aiPolicyControls: true,
    supportEscalation: true,
  },
});

const AI_POLICY_AGE_SAFE_MODES = Object.freeze(['OFF', 'K12', 'TEEN', 'ADULT']);
const AI_POLICY_MODERATION_LEVELS = Object.freeze(['OFF', 'STANDARD', 'STRICT']);

const AI_POLICY_DEFAULT = Object.freeze({
  tone: 'BALANCED',
  strictness: 'MEDIUM',
  dataUsage: 'NO_TRAINING',
  modelChoice: OPENAI_MODEL,
  piiRedaction: true,
  citationMode: false,
  ageSafeMode: 'K12',
  moderationLevel: 'STANDARD',
  blockedTerms: [],
});

function normalizeLicenseTier(value) {
  const tier = String(value || '').trim().toUpperCase();
  return LICENSE_TIERS.includes(tier) ? tier : 'STARTER';
}

function normalizeLicenseState(value) {
  const status = String(value || '').trim().toUpperCase();
  return LICENSE_STATES.includes(status) ? status : 'ACTIVE';
}

function normalizeApprovalState(value) {
  const status = String(value || '').trim().toUpperCase();
  return APPROVAL_STATES.includes(status) ? status : 'PENDING';
}

function normalizeTemplateState(value) {
  const status = String(value || '').trim().toUpperCase();
  return TEMPLATE_STATES.includes(status) ? status : 'DRAFT';
}

function normalizeIncidentState(value) {
  const status = String(value || '').trim().toUpperCase();
  return INCIDENT_STATES.includes(status) ? status : 'OPEN';
}

function nowIso() {
  return new Date().toISOString();
}

function makePrefixedId(prefix) {
  const p = String(prefix || 'ID').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ID';
  return `${p}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value };
  }
  if (typeof value !== 'string') return { ...fallback };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return { ...fallback };
}

function normalizeBlockedTerms(input, limit = 40) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\n]/g)
      : [];
  const out = [];
  const seen = new Set();
  for (const term of raw) {
    const safe = String(term || '').trim().toLowerCase();
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeAiPolicy(input = {}) {
  const toneRaw = String(input.tone || AI_POLICY_DEFAULT.tone).trim().toUpperCase();
  const strictnessRaw = String(input.strictness || AI_POLICY_DEFAULT.strictness)
    .trim()
    .toUpperCase();
  const dataUsageRaw = String(input.dataUsage || AI_POLICY_DEFAULT.dataUsage)
    .trim()
    .toUpperCase();
  const ageSafeModeRaw = String(input.ageSafeMode || AI_POLICY_DEFAULT.ageSafeMode)
    .trim()
    .toUpperCase();
  const moderationLevelRaw = String(
    input.moderationLevel || AI_POLICY_DEFAULT.moderationLevel
  )
    .trim()
    .toUpperCase();
  const tone = ['SOFT', 'BALANCED', 'DIRECT', 'COACH'].includes(toneRaw)
    ? toneRaw
    : AI_POLICY_DEFAULT.tone;
  const strictness = ['LOW', 'MEDIUM', 'HIGH'].includes(strictnessRaw)
    ? strictnessRaw
    : AI_POLICY_DEFAULT.strictness;
  const dataUsage = ['NO_TRAINING', 'ANONYMIZED', 'ANALYTICS_ONLY'].includes(dataUsageRaw)
    ? dataUsageRaw
    : AI_POLICY_DEFAULT.dataUsage;
  const ageSafeMode = AI_POLICY_AGE_SAFE_MODES.includes(ageSafeModeRaw)
    ? ageSafeModeRaw
    : AI_POLICY_DEFAULT.ageSafeMode;
  const moderationLevel = AI_POLICY_MODERATION_LEVELS.includes(moderationLevelRaw)
    ? moderationLevelRaw
    : AI_POLICY_DEFAULT.moderationLevel;
  return {
    tone,
    strictness,
    dataUsage,
    modelChoice: String(input.modelChoice || OPENAI_MODEL).trim() || OPENAI_MODEL,
    piiRedaction: input.piiRedaction !== false,
    citationMode: !!input.citationMode,
    ageSafeMode,
    moderationLevel,
    blockedTerms: normalizeBlockedTerms(input.blockedTerms ?? AI_POLICY_DEFAULT.blockedTerms),
  };
}

function normalizeFeatureFlagPatch(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const flagKey = String(key || '').trim();
    if (!flagKey) continue;
    out[flagKey] = !!value;
  }
  return out;
}

function normalizePhase(phase, index) {
  const fallbackTitle = `Phase ${index + 1}`;
  const title = String(phase?.title || '').trim() || fallbackTitle;
  const goal = String(phase?.goal || '').trim();
  const durationSec = toPositiveInt(
    phase?.durationSec,
    toPositiveInt(Number(phase?.durationMin) * 60, 600, { min: 60, max: 7200 }),
    { min: 60, max: 7200 }
  );

  return {
    id:
      String(phase?.id || '').trim() ||
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') ||
      `phase-${index + 1}`,
    title,
    durationSec,
    goal,
  };
}

function cloneTemplatePhases(mode) {
  const template = WORKSHOP_MODE_TEMPLATES[normalizeMode(mode)];
  return (template.defaultPhases || []).map((phase, idx) =>
    normalizePhase(phase, idx)
  );
}

function applyPhaseCount(phases, phaseCount) {
  const targetCount = toPositiveInt(phaseCount, phases.length || 1, {
    min: 1,
    max: MAX_PHASE_COUNT,
  });
  const next = phases.slice(0, targetCount);
  while (next.length < targetCount) {
    next.push(
      normalizePhase(
        {
          title: `Phase ${next.length + 1}`,
          durationSec: 600,
          goal: '',
        },
        next.length
      )
    );
  }
  return next;
}

function deriveRoomsPerSite(expectedUsers, seatLimitPerRoom) {
  const seats = toPositiveInt(seatLimitPerRoom, DEFAULT_SEAT_LIMIT_PER_ROOM, {
    min: 1,
    max: MAX_SEAT_LIMIT_PER_ROOM,
  });
  const users = toPositiveInt(expectedUsers, DEFAULT_EXPECTED_USERS, {
    min: 1,
    max: 20_000,
  });
  const rooms = Math.ceil(users / seats);
  return toPositiveInt(rooms, 1, { min: 1, max: MAX_ROOMS_PER_SITE });
}

function createDefaultWorkshopConfig({
  licenseId,
  siteIds = [],
  mode = DEFAULT_WORKSHOP_MODE,
  orgId = '',
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId);
  const normalizedOrg = normalizedOrgId(orgId, normalizedLicense);
  const normalizedMode = normalizeMode(mode);
  const template = WORKSHOP_MODE_TEMPLATES[normalizedMode];
  const phases = cloneTemplatePhases(normalizedMode);
  const expectedUsers = DEFAULT_EXPECTED_USERS;
  const seatLimitPerRoom = DEFAULT_SEAT_LIMIT_PER_ROOM;
  const roomsPerSite = deriveRoomsPerSite(expectedUsers, seatLimitPerRoom);

  return {
    orgId: normalizedOrg,
    licenseId: normalizedLicense,
    name: template.label,
    mode: normalizedMode,
    description: template.description,
    siteIds: sanitizeSiteIds(siteIds),
    expectedUsers,
    activeUserCap: expectedUsers,
    seatLimitPerRoom,
    roomsPerSite,
    licenseStatus: 'ACTIVE',
    licenseExpiresAt: null,
    messageRetentionDays: MESSAGE_RETENTION_DAYS,
    draftRetentionDays: DRAFT_RETENTION_DAYS,
    sessionRetentionHours: SESSION_TTL_HOURS,
    auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    legalHold: false,
    aiBehavior: 'GUIDE',
    phaseCount: phases.length,
    phases,
    topicCatalog: normalizeTopicCatalog(template.defaultTopics || []),
    enableTopicVoting: true,
    assistantPersona: DEFAULT_ASSISTANT_PERSONA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function parseRoomId(roomId) {
  const [siteId, idxStr] = String(roomId).split('-');
  return { siteId: (siteId || 'E1').toUpperCase(), index: Number(idxStr || 1) };
}

function deepCloneDemo(value) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function demoCodeRoleFromPrefix(code = '') {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized.startsWith('A-')) return 'ADMIN';
  if (normalized.startsWith('P-')) return 'PRESENTER';
  if (normalized.startsWith('U-')) return 'PARTICIPANT';
  if (normalized.startsWith('SA-')) return 'SUPER_ADMIN';
  return '';
}

function createDemoRoomRecord(roomId) {
  const now = Date.now();
  const { siteId, index } = parseRoomId(roomId);
  return {
    roomId,
    siteId,
    index,
    stage: DEFAULT_STAGE,
    stageEndsAt: now + getStageDuration(DEFAULT_STAGE),
    inputLocked: false,
    topic: '',
    ideaSummary: '',
    licenseId: DEMO_DEFAULT_LICENSE_ID,
    orgId: DEMO_DEFAULT_ORG_ID,
    messageRetentionDays: MESSAGE_RETENTION_DAYS,
    draftRetentionDays: DRAFT_RETENTION_DAYS,
    auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    legalHold: false,
    voteOpen: false,
    voteTotal: 0,
    voteTallies: {},
    voteByUid: {},
    topicOptions: [],
    phasePlan: [],
    workshopMode: DEFAULT_WORKSHOP_MODE,
    aiBehavior: 'GUIDE',
    assistantPersona: DEFAULT_ASSISTANT_PERSONA,
    autopilot: { ...AUTOPILOT_DEFAULT },
    autopilotActions: {},
    lastParticipantMessageAt: 0,
    shareLinks: {},
    phaseCanvases: {},
    privateDrafts: {},
    decisionLog: [],
    draftApprovedByUids: [],
    draftApprovedVersion: 0,
    draftApprovedAt: 0,
    lastAiFallbackAt: 0,
    lastAiFallbackReason: '',
    lastAiFallbackStage: '',
    greetedForStage: {},
    seats: [],
    seatUids: [],
    voteReadyUids: [],
    voteReadyCount: 0,
    voteSubmittedUids: [],
    voteSubmittedCount: 0,
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,
    draftText: '',
    draftVersion: 0,
    draftUpdatedAt: null,
    finalAbstract: '',
    closedReason: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createDemoFallbackState() {
  const now = Date.now();
  const workshop = createDefaultWorkshopConfig({
    licenseId: DEMO_DEFAULT_LICENSE_ID,
    orgId: DEMO_DEFAULT_ORG_ID,
    siteIds: [DEMO_DEFAULT_SITE_ID],
    mode: DEFAULT_WORKSHOP_MODE,
  });
  workshop.orgId = DEMO_DEFAULT_ORG_ID;
  workshop.licenseId = DEMO_DEFAULT_LICENSE_ID;
  workshop.siteIds = [DEMO_DEFAULT_SITE_ID];
  workshop.updatedAt = now;

  const org = {
    orgId: DEMO_DEFAULT_ORG_ID,
    status: 'ACTIVE',
    tier: 'PRO',
    name: 'Demo Organization',
    primaryDomain: 'demo.local',
    siteIds: [DEMO_DEFAULT_SITE_ID],
    supportPlan: 'STANDARD',
    ownerEmail: DEMO_DEFAULT_SUPER_ADMIN_EMAIL,
    billingAccountId: 'demo-billing',
    notes: 'Demo fallback organization record.',
    createdAt: now,
    updatedAt: now,
  };

  const license = {
    licenseId: DEMO_DEFAULT_LICENSE_ID,
    orgId: DEMO_DEFAULT_ORG_ID,
    status: 'ACTIVE',
    tier: 'PRO',
    seatCap: 120,
    activeUserCap: 120,
    usageCap: 1200,
    startsAt: now,
    expiresAt: now + 180 * 24 * 60 * 60 * 1000,
    renewalAt: now + 150 * 24 * 60 * 60 * 1000,
    overagePolicy: 'NOTIFY_ONLY',
    billingMode: 'INVOICE',
    billingAccountId: 'demo-billing',
    notes: 'Demo fallback license record.',
    createdAt: now,
    updatedAt: now,
  };

  const state = {
    workshops: new Map([[DEMO_DEFAULT_LICENSE_ID, workshop]]),
    rooms: new Map(),
    messages: new Map(),
    drafts: new Map(),
    codes: new Map(),
    authSessions: new Map(), // key: `${uid}::${sessionId}`
    statusEvents: new Map(),
    orgs: new Map([[DEMO_DEFAULT_ORG_ID, org]]),
    licenses: new Map([[DEMO_DEFAULT_LICENSE_ID, license]]),
    orgUsers: new Map(),
    featureFlags: new Map(),
    policies: new Map(),
    templates: new Map(),
    approvals: new Map(),
    billing: new Map(),
    support: new Map(),
  };

  const defaultCodes = [
    'A-DEMO',
    'P-DEMO',
    'U-DEMO1',
    'U-DEMO2',
    'U-DEMO3',
    'U-DEMO4',
    'U-DEMO5',
    'U-DEMO6',
  ];
  for (const code of defaultCodes) {
    const role = demoCodeRoleFromPrefix(code);
    state.codes.set(code, {
      code,
      codeHash: hashCodeValue(code),
      role: role || 'PARTICIPANT',
      siteId: DEMO_DEFAULT_SITE_ID,
      siteIds: [DEMO_DEFAULT_SITE_ID],
      licenseId: DEMO_DEFAULT_LICENSE_ID,
      orgId: DEMO_DEFAULT_ORG_ID,
      defaultMode: DEFAULT_WORKSHOP_MODE,
      consumed: false,
      revoked: false,
      expiresAt: now + CODE_TTL_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
      createdBy: 'demo-fallback',
    });
  }

  state.statusEvents.set('GLOBAL', [
    {
      scopeId: 'GLOBAL',
      statusKey: `${String(now).padStart(13, '0')}#DEMO`,
      payload: JSON.stringify({
        component: 'platform',
        message: 'Demo mode fallback is active.',
        severity: 'INFO',
        state: 'OPEN',
        incidentState: 'OPEN',
        link: '',
      }),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return state;
}

const demoFallbackState = createDemoFallbackState();

function demoAuthSessionKey(uid = '', sessionId = '') {
  return `${String(uid || '').trim()}::${String(sessionId || '').trim()}`;
}

function saveDemoAuthSessionRecord(item = {}) {
  const uid = String(item.uid || '').trim();
  const sessionId = String(item.sessionId || '').trim();
  if (!uid || !sessionId) return;
  const key = demoAuthSessionKey(uid, sessionId);
  demoFallbackState.authSessions.set(key, {
    ...deepCloneDemo(item),
    uid,
    sessionId,
    updatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
}

function getDemoAuthSessionRecord(uid = '', sessionId = '') {
  const key = demoAuthSessionKey(uid, sessionId);
  const item = demoFallbackState.authSessions.get(key);
  return item ? deepCloneDemo(item) : null;
}

function listDemoAuthSessions(uid = '', limit = 50) {
  const userId = String(uid || '').trim();
  if (!userId) return [];
  return Array.from(demoFallbackState.authSessions.values())
    .filter((row) => String(row.uid || '').trim() === userId)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, Math.min(200, limit))
    .map((row) => deepCloneDemo(row));
}

function touchDemoAuthSession(uid = '', sessionId = '', req = null) {
  const existing = getDemoAuthSessionRecord(uid, sessionId);
  if (!existing) return;
  existing.updatedAt = Date.now();
  existing.lastSeenAt = Date.now();
  existing.ip = extractClientIp(req);
  existing.userAgent = extractUserAgent(req);
  saveDemoAuthSessionRecord(existing);
}

function revokeDemoAuthSession(uid = '', sessionId = '') {
  const existing = getDemoAuthSessionRecord(uid, sessionId);
  if (!existing) return;
  existing.revoked = true;
  existing.updatedAt = Date.now();
  saveDemoAuthSessionRecord(existing);
}

function getDemoWorkshopRecord(licenseIdRaw = '') {
  const licenseId = normalizedLicenseId(licenseIdRaw || DEMO_DEFAULT_LICENSE_ID);
  if (!licenseId) return null;
  const existing = demoFallbackState.workshops.get(licenseId);
  if (existing) return deepCloneDemo(existing);
  const created = createDefaultWorkshopConfig({
    licenseId,
    orgId: DEMO_DEFAULT_ORG_ID,
    siteIds: [DEMO_DEFAULT_SITE_ID],
    mode: DEFAULT_WORKSHOP_MODE,
  });
  created.orgId = normalizedOrgId(created.orgId || DEMO_DEFAULT_ORG_ID, licenseId);
  created.updatedAt = Date.now();
  demoFallbackState.workshops.set(licenseId, created);
  return deepCloneDemo(created);
}

function putDemoWorkshopRecord(workshop = {}) {
  const licenseId = normalizedLicenseId(workshop.licenseId || DEMO_DEFAULT_LICENSE_ID);
  if (!licenseId) return null;
  const next = deepCloneDemo({
    ...workshop,
    licenseId,
    orgId: normalizedOrgId(workshop.orgId || DEMO_DEFAULT_ORG_ID, licenseId),
    siteIds: sanitizeSiteIds(workshop.siteIds, [DEMO_DEFAULT_SITE_ID]),
    updatedAt: Date.now(),
  });
  demoFallbackState.workshops.set(licenseId, next);
  return deepCloneDemo(next);
}

function getOrCreateDemoCodeRecord(rawCode = '') {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const existing = demoFallbackState.codes.get(code);
  if (existing) return deepCloneDemo(existing);
  const role = demoCodeRoleFromPrefix(code);
  if (!role) return null;
  const now = Date.now();
  const created = {
    code,
    codeHash: hashCodeValue(code),
    role,
    siteId: DEMO_DEFAULT_SITE_ID,
    siteIds: [DEMO_DEFAULT_SITE_ID],
    licenseId: DEMO_DEFAULT_LICENSE_ID,
    orgId: DEMO_DEFAULT_ORG_ID,
    defaultMode: DEFAULT_WORKSHOP_MODE,
    consumed: false,
    revoked: false,
    expiresAt: now + CODE_TTL_DAYS * 24 * 60 * 60 * 1000,
    createdAt: now,
    createdBy: 'demo-fallback',
  };
  demoFallbackState.codes.set(code, created);
  return deepCloneDemo(created);
}

function consumeDemoCodeRecord(item = {}, uid = '') {
  const code = String(item.code || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'code_missing' };
  const existing = getOrCreateDemoCodeRecord(code);
  if (!existing) return { ok: false, error: 'code_not_found' };
  const unusable = classifyCodeUnusable(existing);
  if (unusable) {
    return { ok: false, conflict: true, reason: unusable };
  }
  const userId = String(uid || '').trim() || '(unknown)';
  const usedBy = String(existing.usedBy || '').trim();
  if (existing.consumed && usedBy && usedBy !== userId) {
    return { ok: false, conflict: true, reason: 'code_already_consumed' };
  }
  existing.consumed = true;
  existing.usedBy = userId;
  existing.consumedAt = Date.now();
  demoFallbackState.codes.set(code, existing);
  return { ok: true };
}

function getDemoRoomRecord(roomId = '') {
  const rid = String(roomId || '').trim();
  if (!rid) return null;
  const existing = demoFallbackState.rooms.get(rid);
  if (existing) return deepCloneDemo(existing);
  const created = createDemoRoomRecord(rid);
  demoFallbackState.rooms.set(rid, created);
  return deepCloneDemo(created);
}

function setDemoRoomRecord(room = {}) {
  const roomId = String(room.roomId || '').trim();
  if (!roomId) return null;
  const normalized = normalizeRoomShape({
    ...room,
    roomId,
    licenseId: normalizedLicenseId(room.licenseId || DEMO_DEFAULT_LICENSE_ID),
    orgId: normalizedOrgId(room.orgId || DEMO_DEFAULT_ORG_ID, room.licenseId || DEMO_DEFAULT_LICENSE_ID),
  });
  demoFallbackState.rooms.set(roomId, deepCloneDemo(normalized));
  return deepCloneDemo(normalized);
}

function getDemoMessages(roomId = '') {
  const rid = String(roomId || '').trim();
  if (!rid) return [];
  const entries = demoFallbackState.messages.get(rid);
  if (!Array.isArray(entries)) return [];
  return entries.map((row) => deepCloneDemo(row));
}

function setDemoMessages(roomId = '', messages = []) {
  const rid = String(roomId || '').trim();
  if (!rid) return;
  demoFallbackState.messages.set(
    rid,
    (Array.isArray(messages) ? messages : []).map((row) => deepCloneDemo(row))
  );
}

function putDemoTimestampedItem(tableName, roomId, makeItem, maxAttempts = 6) {
  const rid = String(roomId || '').trim();
  if (!rid) throw new Error('roomId_required_for_demo_item');
  const bucket =
    tableName === TABLES.messages
      ? getDemoMessages(rid)
      : tableName === TABLES.drafts
      ? (Array.isArray(demoFallbackState.drafts.get(rid))
          ? demoFallbackState.drafts.get(rid)
          : [])
      : [];
  let createdAt = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ts = Date.now() + attempt;
    if (bucket.some((item) => Number(item.createdAt || 0) === ts)) continue;
    bucket.push(makeItem(ts));
    createdAt = ts;
    break;
  }
  if (!createdAt) {
    throw new Error(`Failed demo timestamp write for ${rid}`);
  }
  bucket.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  if (tableName === TABLES.messages) {
    setDemoMessages(rid, bucket);
  } else if (tableName === TABLES.drafts) {
    demoFallbackState.drafts.set(rid, bucket.map((row) => deepCloneDemo(row)));
  }
  return createdAt;
}

function getDemoTableItem(tableName, key = {}) {
  if (!tableName || !key || typeof key !== 'object') return null;
  if (tableName === TABLES.workshops) {
    return getDemoWorkshopRecord(key.licenseId);
  }
  if (tableName === TABLES.codes) {
    return getOrCreateDemoCodeRecord(key.code);
  }
  if (tableName === TABLES.rooms) {
    return getDemoRoomRecord(key.roomId);
  }
  if (tableName === TABLES.authSessions) {
    return getDemoAuthSessionRecord(key.uid, key.sessionId);
  }
  if (tableName === TABLES.orgs) {
    const orgId = normalizedOrgId(key.orgId || '', DEMO_DEFAULT_LICENSE_ID);
    return orgId ? deepCloneDemo(demoFallbackState.orgs.get(orgId) || null) : null;
  }
  if (tableName === TABLES.licenses) {
    const licenseId = normalizedLicenseId(key.licenseId || '');
    return licenseId
      ? deepCloneDemo(demoFallbackState.licenses.get(licenseId) || null)
      : null;
  }
  if (tableName === TABLES.orgUsers) {
    const orgId = normalizedOrgId(key.orgId || '', DEMO_DEFAULT_LICENSE_ID);
    const userId = normalizeOrgUserId(key.userId || '');
    if (!orgId || !userId) return null;
    return deepCloneDemo(demoFallbackState.orgUsers.get(`${orgId}::${userId}`) || null);
  }
  if (tableName === TABLES.featureFlags) {
    const scopeId = String(key.scopeId || '').trim().toUpperCase();
    const flagKey = String(key.flagKey || '').trim();
    if (!scopeId || !flagKey) return null;
    return deepCloneDemo(
      demoFallbackState.featureFlags.get(`${scopeId}::${flagKey}`) || null
    );
  }
  if (tableName === TABLES.policies) {
    const scopeId = String(key.scopeId || '').trim().toUpperCase();
    const policyType = String(key.policyType || '').trim().toUpperCase();
    if (!scopeId || !policyType) return null;
    return deepCloneDemo(
      demoFallbackState.policies.get(`${scopeId}::${policyType}`) || null
    );
  }
  if (tableName === TABLES.support) {
    const orgId = normalizedOrgId(key.orgId || '', DEMO_DEFAULT_LICENSE_ID);
    const ticketId = String(key.ticketId || '').trim();
    if (!orgId || !ticketId) return null;
    return deepCloneDemo(
      demoFallbackState.support.get(`${orgId}::${ticketId}`) || null
    );
  }
  if (tableName === TABLES.billing) {
    const orgId = normalizedOrgId(key.orgId || '', DEMO_DEFAULT_LICENSE_ID);
    const billingEventId = String(key.billingEventId || '').trim();
    if (!orgId || !billingEventId) return null;
    return deepCloneDemo(
      demoFallbackState.billing.get(`${orgId}::${billingEventId}`) || null
    );
  }
  if (tableName === TABLES.status) {
    const scopeId = String(key.scopeId || 'GLOBAL').trim().toUpperCase();
    const statusKey = String(key.statusKey || '').trim();
    const rows = demoFallbackState.statusEvents.get(scopeId) || [];
    const found = rows.find((row) => String(row.statusKey || '') === statusKey);
    return found ? deepCloneDemo(found) : null;
  }
  return null;
}

function putDemoTableItem(tableName, item = {}) {
  if (!tableName || !item || typeof item !== 'object') return;
  if (tableName === TABLES.workshops) {
    putDemoWorkshopRecord(item);
    return;
  }
  if (tableName === TABLES.codes) {
    const code = String(item.code || '').trim().toUpperCase();
    if (!code) return;
    demoFallbackState.codes.set(code, deepCloneDemo({ ...item, code }));
    return;
  }
  if (tableName === TABLES.rooms) {
    setDemoRoomRecord(item);
    return;
  }
  if (tableName === TABLES.authSessions) {
    saveDemoAuthSessionRecord(item);
    return;
  }
  if (tableName === TABLES.orgs) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    if (!orgId) return;
    demoFallbackState.orgs.set(orgId, deepCloneDemo({ ...item, orgId }));
    return;
  }
  if (tableName === TABLES.licenses) {
    const licenseId = normalizedLicenseId(item.licenseId || '');
    if (!licenseId) return;
    demoFallbackState.licenses.set(licenseId, deepCloneDemo({ ...item, licenseId }));
    return;
  }
  if (tableName === TABLES.orgUsers) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    const userId = normalizeOrgUserId(item.userId || '');
    if (!orgId || !userId) return;
    demoFallbackState.orgUsers.set(
      `${orgId}::${userId}`,
      deepCloneDemo({ ...item, orgId, userId })
    );
    return;
  }
  if (tableName === TABLES.featureFlags) {
    const scopeId = String(item.scopeId || '').trim().toUpperCase();
    const flagKey = String(item.flagKey || '').trim();
    if (!scopeId || !flagKey) return;
    demoFallbackState.featureFlags.set(
      `${scopeId}::${flagKey}`,
      deepCloneDemo({ ...item, scopeId, flagKey })
    );
    return;
  }
  if (tableName === TABLES.policies) {
    const scopeId = String(item.scopeId || '').trim().toUpperCase();
    const policyType = String(item.policyType || '').trim().toUpperCase();
    if (!scopeId || !policyType) return;
    demoFallbackState.policies.set(
      `${scopeId}::${policyType}`,
      deepCloneDemo({ ...item, scopeId, policyType })
    );
    return;
  }
  if (tableName === TABLES.support) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    const ticketId = String(item.ticketId || '').trim();
    if (!orgId || !ticketId) return;
    demoFallbackState.support.set(
      `${orgId}::${ticketId}`,
      deepCloneDemo({ ...item, orgId, ticketId })
    );
    return;
  }
  if (tableName === TABLES.billing) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    const billingEventId = String(item.billingEventId || '').trim();
    if (!orgId || !billingEventId) return;
    demoFallbackState.billing.set(
      `${orgId}::${billingEventId}`,
      deepCloneDemo({ ...item, orgId, billingEventId })
    );
    return;
  }
  if (tableName === TABLES.approvals) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    const approvalId = String(item.approvalId || '').trim();
    if (!orgId || !approvalId) return;
    demoFallbackState.approvals.set(
      `${orgId}::${approvalId}`,
      deepCloneDemo({ ...item, orgId, approvalId })
    );
    return;
  }
  if (tableName === TABLES.templates) {
    const orgId = normalizedOrgId(item.orgId || '', item.licenseId || DEMO_DEFAULT_LICENSE_ID);
    const templateKey = String(item.templateKey || '').trim();
    if (!orgId || !templateKey) return;
    demoFallbackState.templates.set(
      `${orgId}::${templateKey}`,
      deepCloneDemo({ ...item, orgId, templateKey })
    );
    return;
  }
  if (tableName === TABLES.status) {
    const scopeId = String(item.scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
    const row = deepCloneDemo({
      ...item,
      scopeId,
      statusKey: String(item.statusKey || '').trim(),
      createdAt: Number(item.createdAt || Date.now()) || Date.now(),
      updatedAt: Number(item.updatedAt || Date.now()) || Date.now(),
    });
    const bucket = Array.isArray(demoFallbackState.statusEvents.get(scopeId))
      ? demoFallbackState.statusEvents.get(scopeId).slice()
      : [];
    const existingIndex = bucket.findIndex((entry) => entry.statusKey === row.statusKey);
    if (existingIndex >= 0) bucket[existingIndex] = row;
    else bucket.unshift(row);
    bucket.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    demoFallbackState.statusEvents.set(scopeId, bucket);
  }
}

function queryDemoByPartitionKey({
  tableName,
  partitionKey,
  partitionValue,
  limit = 100,
  scanForward = false,
}) {
  const max = Math.max(1, Number(limit || 100));
  const value = String(partitionValue || '').trim().toUpperCase();
  let rows = [];
  if (tableName === TABLES.codes) {
    rows = Array.from(demoFallbackState.codes.values()).filter((row) => {
      if (partitionKey === 'role') {
        return String(row.role || '').trim().toUpperCase() === value;
      }
      if (partitionKey === 'siteId') {
        return normalizedSiteId(row.siteId || '') === value;
      }
      if (partitionKey === 'licenseId') {
        return normalizedLicenseId(row.licenseId || '') === value;
      }
      return true;
    });
    rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  } else if (tableName === TABLES.rooms) {
    rows = Array.from(demoFallbackState.rooms.values()).filter((row) => {
      if (partitionKey !== 'siteId') return true;
      return normalizedSiteId(row.siteId || '') === value;
    });
    rows.sort((a, b) =>
      Number(a.index || 0) - Number(b.index || 0)
    );
  } else if (tableName === TABLES.authSessions) {
    rows = Array.from(demoFallbackState.authSessions.values()).filter((row) => {
      if (partitionKey === 'uid') {
        return String(row.uid || '').trim() === String(partitionValue || '').trim();
      }
      if (partitionKey === 'licenseId') {
        return normalizedLicenseId(row.licenseId || '') === value;
      }
      return true;
    });
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  } else if (tableName === TABLES.sessions) {
    rows = Array.from(demoFallbackState.authSessions.values()).map((session) => ({
      uid: session.uid,
      role: session.role,
      siteId: session.siteId,
      licenseId: session.licenseId,
      orgId: session.orgId,
      email: session.email,
      lastSeenAt: session.lastSeenAt || session.updatedAt || Date.now(),
      lastSeenIso: new Date(
        Number(session.lastSeenAt || session.updatedAt || Date.now())
      ).toISOString(),
      ip: session.ip || '',
    }));
    if (partitionKey === 'role') {
      rows = rows.filter(
        (row) => String(row.role || '').trim().toUpperCase() === value
      );
    }
    rows.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
  } else if (tableName === TABLES.status) {
    const scopeId = String(partitionValue || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
    rows = Array.isArray(demoFallbackState.statusEvents.get(scopeId))
      ? demoFallbackState.statusEvents.get(scopeId)
      : [];
    rows = rows.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  } else if (tableName === TABLES.orgs) {
    rows = Array.from(demoFallbackState.orgs.values());
    if (partitionKey === 'status') {
      rows = rows.filter(
        (row) => String(row.status || '').trim().toUpperCase() === value
      );
    }
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  } else if (tableName === TABLES.licenses) {
    rows = Array.from(demoFallbackState.licenses.values());
    if (partitionKey === 'status') {
      rows = rows.filter(
        (row) => String(row.status || '').trim().toUpperCase() === value
      );
    }
    if (partitionKey === 'orgId') {
      rows = rows.filter((row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === value);
    }
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  } else if (tableName === TABLES.orgUsers) {
    rows = Array.from(demoFallbackState.orgUsers.values());
    if (partitionKey === 'orgId') {
      rows = rows.filter(
        (row) => normalizedOrgId(row.orgId || '', DEMO_DEFAULT_LICENSE_ID) === value
      );
    }
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  } else if (tableName === TABLES.featureFlags) {
    rows = Array.from(demoFallbackState.featureFlags.values());
    if (partitionKey === 'scopeId') {
      rows = rows.filter(
        (row) => String(row.scopeId || '').trim().toUpperCase() === value
      );
    }
    rows.sort((a, b) => String(a.flagKey || '').localeCompare(String(b.flagKey || '')));
  } else if (tableName === TABLES.support) {
    rows = Array.from(demoFallbackState.support.values());
    if (partitionKey === 'orgId') {
      rows = rows.filter(
        (row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === value
      );
    } else if (partitionKey === 'ticketStatus') {
      rows = rows.filter(
        (row) => String(row.ticketStatus || '').trim().toUpperCase() === value
      );
    }
    rows.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  } else if (tableName === TABLES.billing) {
    rows = Array.from(demoFallbackState.billing.values());
    if (partitionKey === 'orgId') {
      rows = rows.filter(
        (row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === value
      );
    }
    rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  } else if (tableName === TABLES.approvals) {
    rows = Array.from(demoFallbackState.approvals.values());
    if (partitionKey === 'orgId') {
      rows = rows.filter(
        (row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === value
      );
    } else if (partitionKey === 'status') {
      rows = rows.filter(
        (row) => String(row.status || '').trim().toUpperCase() === value
      );
    }
    rows.sort((a, b) => Number(b.requestedAt || b.updatedAt || 0) - Number(a.requestedAt || a.updatedAt || 0));
  } else if (tableName === TABLES.templates) {
    rows = Array.from(demoFallbackState.templates.values());
    if (partitionKey === 'orgId') {
      rows = rows.filter(
        (row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === value
      );
    }
    rows.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  }
  if (!scanForward) {
    return { items: rows.slice(0, max).map((row) => deepCloneDemo(row)), lastKey: null };
  }
  return {
    items: rows
      .slice()
      .sort((a, b) => Number(a.createdAt || a.updatedAt || 0) - Number(b.createdAt || b.updatedAt || 0))
      .slice(0, max)
      .map((row) => deepCloneDemo(row)),
    lastKey: null,
  };
}

let stageEngine = null;
const roomEventStreams = new Map(); // roomId -> Set<ServerResponse>
const presenterEventStreams = new Map(); // siteId -> Set<ServerResponse>
const statusEventStreams = new Map(); // key GLOBAL -> Set<ServerResponse>
const superAdminEventStreams = new Map(); // key GLOBAL -> Set<ServerResponse>
const roomPresenceMap = new Map(); // roomId -> Map<uid, { uid, emoji, lastTypingAt }>
const PRESENCE_TYPING_WINDOW_MS = 8_000;

function setupSseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write('retry: 3000\n\n');

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {}
  }, 25_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  return () => clearInterval(heartbeat);
}

function writeSseEvent(res, event, payload) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function attachSseClient(streamMap, key, res, { upperCase = false } = {}) {
  const raw = String(key || '');
  const k = upperCase ? raw.toUpperCase() : raw;
  if (!k) return () => {};
  let set = streamMap.get(k);
  if (!set) {
    set = new Set();
    streamMap.set(k, set);
  }
  set.add(res);
  return () => {
    const cur = streamMap.get(k);
    if (!cur) return;
    cur.delete(res);
    if (cur.size === 0) streamMap.delete(k);
  };
}

function publishToStreamSet(set, event, payload) {
  if (!set || set.size === 0) return;
  for (const res of Array.from(set)) {
    if (res.writableEnded || res.destroyed || !writeSseEvent(res, event, payload)) {
      set.delete(res);
    }
  }
}

function publishRoomEvent(roomId, event, payload = {}) {
  if (!roomId) return;
  const parsed = parseRoomId(roomId);
  const siteId = String(payload.siteId || parsed.siteId || '').toUpperCase();
  const out = {
    roomId,
    siteId,
    event,
    at: Date.now(),
    ...payload,
  };

  const roomSet = roomEventStreams.get(roomId);
  publishToStreamSet(roomSet, event, out);
  if (roomSet && roomSet.size === 0) roomEventStreams.delete(roomId);

  const siteSet = presenterEventStreams.get(siteId);
  publishToStreamSet(siteSet, 'room_update', out);
  if (siteSet && siteSet.size === 0) presenterEventStreams.delete(siteId);

  const superSet = superAdminEventStreams.get('GLOBAL');
  publishToStreamSet(superSet, 'ops_update', {
    source: 'room',
    roomId,
    siteId,
    roomEvent: event,
    at: Date.now(),
  });
  if (superSet && superSet.size === 0) superAdminEventStreams.delete('GLOBAL');
}

function publishStatusStreamEvent(payload = {}) {
  const out = {
    source: 'status',
    at: Date.now(),
    ...payload,
  };
  const statusSet = statusEventStreams.get('GLOBAL');
  publishToStreamSet(statusSet, 'status_update', out);
  if (statusSet && statusSet.size === 0) statusEventStreams.delete('GLOBAL');

  const superSet = superAdminEventStreams.get('GLOBAL');
  publishToStreamSet(superSet, 'ops_update', out);
  if (superSet && superSet.size === 0) superAdminEventStreams.delete('GLOBAL');
}

function publishSuperAdminStreamEvent(payload = {}) {
  const out = {
    source: 'ops',
    at: Date.now(),
    ...payload,
  };
  const superSet = superAdminEventStreams.get('GLOBAL');
  publishToStreamSet(superSet, 'ops_update', out);
  if (superSet && superSet.size === 0) superAdminEventStreams.delete('GLOBAL');
}

function cleanRoomPresence(roomId, now = Date.now()) {
  const map = roomPresenceMap.get(roomId);
  if (!map) return [];
  const active = [];
  for (const [uid, row] of map.entries()) {
    const ts = Number(row?.lastTypingAt || 0);
    if (!ts || now - ts > PRESENCE_TYPING_WINDOW_MS) {
      map.delete(uid);
      continue;
    }
    active.push({
      uid: String(row.uid || ''),
      emoji: String(row.emoji || ''),
      lastTypingAt: ts,
    });
  }
  if (!map.size) roomPresenceMap.delete(roomId);
  return active.sort((a, b) => Number(b.lastTypingAt || 0) - Number(a.lastTypingAt || 0));
}

function upsertTypingPresence(roomId, uid, emoji = '') {
  const normalizedRoomId = String(roomId || '').trim();
  const normalizedUid = String(uid || '').trim();
  if (!normalizedRoomId || !normalizedUid) return [];
  let map = roomPresenceMap.get(normalizedRoomId);
  if (!map) {
    map = new Map();
    roomPresenceMap.set(normalizedRoomId, map);
  }
  map.set(normalizedUid, {
    uid: normalizedUid,
    emoji: String(emoji || '').trim(),
    lastTypingAt: Date.now(),
  });
  return cleanRoomPresence(normalizedRoomId);
}

function advanceStageVal(stage) {
  const i = ROOM_ORDER.indexOf(stage || DEFAULT_STAGE);
  return i >= 0 && i < ROOM_ORDER.length - 1
    ? ROOM_ORDER[i + 1]
    : stage || DEFAULT_STAGE;
}

function getSeatCount(room) {
  if (Array.isArray(room?.seatUids) && room.seatUids.length) {
    return room.seatUids.length;
  }
  return Array.isArray(room?.seats) ? room.seats.length : 0;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function phasesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i] || {};
    const pb = b[i] || {};
    if (
      String(pa.id || '') !== String(pb.id || '') ||
      String(pa.title || '') !== String(pb.title || '') ||
      Number(pa.durationSec || 0) !== Number(pb.durationSec || 0) ||
      String(pa.goal || '') !== String(pb.goal || '')
    ) {
      return false;
    }
  }
  return true;
}

function normalizeSeats(seats) {
  const raw = Array.isArray(seats) ? seats : [];
  const deduped = [];
  const seen = new Set();
  for (const entry of raw) {
    const uid = String(entry?.uid || '').trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    deduped.push({ uid });
  }
  return deduped;
}

function normalizeShareLinkEntry(key = '', raw = {}) {
  const linkId = String(raw?.linkId || key || '').trim();
  if (!linkId) return null;
  const createdAt = Number(raw?.createdAt || 0) || Date.now();
  const expiresAt = Number(raw?.expiresAt || 0) || 0;
  const maxViewsRaw = Number(raw?.maxViews || 0);
  const maxViews = Number.isFinite(maxViewsRaw) && maxViewsRaw > 0 ? Math.floor(maxViewsRaw) : 0;
  const viewCountRaw = Number(raw?.viewCount || 0);
  const viewCount = Number.isFinite(viewCountRaw) && viewCountRaw > 0 ? Math.floor(viewCountRaw) : 0;
  return {
    linkId,
    tokenHash: String(raw?.tokenHash || '').trim(),
    title: String(raw?.title || '').trim() || 'Workshop Story',
    topic: String(raw?.topic || '').trim(),
    content: String(raw?.content || ''),
    orgLabel: String(raw?.orgLabel || '').trim(),
    template: String(raw?.template || 'story').trim().toLowerCase() || 'story',
    theme: String(raw?.theme || 'heritage').trim().toLowerCase() || 'heritage',
    createdAt,
    createdBy: String(raw?.createdBy || '').trim(),
    expiresAt,
    revoked: !!raw?.revoked,
    maxViews,
    viewCount,
    lastViewedAt: Number(raw?.lastViewedAt || 0) || 0,
  };
}

function normalizeShareLinksMap(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const normalized = normalizeShareLinkEntry(key, value);
    if (!normalized) continue;
    out[normalized.linkId] = normalized;
  }
  return out;
}

function listShareLinksForRoom(room = {}, { includeSecrets = false } = {}) {
  const map = normalizeShareLinksMap(room?.shareLinks || {});
  const rows = Object.values(map)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map((entry) => {
      const base = {
        linkId: entry.linkId,
        title: entry.title,
        topic: entry.topic,
        orgLabel: entry.orgLabel,
        template: entry.template,
        theme: entry.theme,
        createdAt: entry.createdAt,
        createdBy: entry.createdBy,
        expiresAt: entry.expiresAt,
        revoked: !!entry.revoked,
        maxViews: Number(entry.maxViews || 0),
        viewCount: Number(entry.viewCount || 0),
        lastViewedAt: Number(entry.lastViewedAt || 0) || 0,
      };
      if (includeSecrets) {
        base.tokenHash = entry.tokenHash;
        base.content = entry.content;
      }
      return base;
    });
  return rows;
}

function normalizePrivateDraftEntry(raw = {}) {
  const text = String(raw?.text || '');
  const updatedAt = Number(raw?.updatedAt || 0) || 0;
  const submittedAt = Number(raw?.submittedAt || 0) || 0;
  const mergedAt = Number(raw?.mergedAt || 0) || 0;
  return {
    text,
    updatedAt,
    submittedAt,
    submitted: submittedAt > 0,
    mergedAt,
    mergedBy: String(raw?.mergedBy || '').trim(),
  };
}

function normalizePrivateDraftMap(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [uidRaw, value] of Object.entries(src)) {
    const uid = String(uidRaw || '').trim();
    if (!uid) continue;
    out[uid] = normalizePrivateDraftEntry(value || {});
  }
  return out;
}

function normalizeDecisionLogEntry(raw = {}) {
  const at = Number(raw?.at || 0) || Date.now();
  const type = String(raw?.type || '').trim().toUpperCase() || 'EVENT';
  const stage = String(raw?.stage || '').trim().toUpperCase();
  return {
    id:
      String(raw?.id || '').trim() ||
      `${String(at).padStart(13, '0')}_${Math.random().toString(16).slice(2, 8)}`,
    at,
    type,
    stage: STAGE_SET.has(stage) ? stage : '',
    label: String(raw?.label || type.replace(/_/g, ' ')).trim(),
    actorUid: String(raw?.actorUid || '').trim(),
    details:
      raw?.details && typeof raw.details === 'object' && !Array.isArray(raw.details)
        ? raw.details
        : {},
  };
}

function normalizeDecisionLog(entries = [], max = 180) {
  const source = Array.isArray(entries) ? entries : [];
  return source
    .map((entry) => normalizeDecisionLogEntry(entry || {}))
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-Math.max(10, Number(max || 180)));
}

function normalizeRoomShape(room) {
  const next = { ...(room || {}) };
  next.seats = normalizeSeats(next.seats);
  const inferredSeatUids = next.seats.map((s) => s.uid);
  const rawSeatUids = Array.isArray(next.seatUids)
    ? next.seatUids.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  next.seatUids = rawSeatUids.length ? Array.from(new Set(rawSeatUids)) : inferredSeatUids;
  if (typeof next.draftText !== 'string') next.draftText = '';
  if (!Number.isFinite(Number(next.draftVersion))) next.draftVersion = 0;
  if (!next.draftUpdatedAt) next.draftUpdatedAt = null;
  if (typeof next.finalAbstract !== 'string') next.finalAbstract = '';
  if (!next.closedReason) next.closedReason = null;
  if (!next.closedAt) next.closedAt = null;
  if (!Array.isArray(next.finalReadyUids)) next.finalReadyUids = [];
  if (!Number.isFinite(Number(next.finalReadyCount))) next.finalReadyCount = 0;
  if (!Array.isArray(next.voteReadyUids)) next.voteReadyUids = [];
  if (!Array.isArray(next.voteSubmittedUids)) next.voteSubmittedUids = [];
  if (!Number.isFinite(Number(next.voteReadyCount))) next.voteReadyCount = 0;
  if (!Number.isFinite(Number(next.voteSubmittedCount))) next.voteSubmittedCount = 0;
  if (!Number.isFinite(Number(next.voteTotal))) next.voteTotal = 0;
  if (!next.voteTallies || typeof next.voteTallies !== 'object') next.voteTallies = {};
  if (!next.voteByUid || typeof next.voteByUid !== 'object') next.voteByUid = {};
  if (!Array.isArray(next.topicOptions)) next.topicOptions = [];
  if (!Array.isArray(next.phasePlan)) next.phasePlan = [];
  if (typeof next.licenseId !== 'string') next.licenseId = '';
  if (typeof next.orgId !== 'string') {
    next.orgId = normalizedOrgId('', next.licenseId || '');
  }
  if (!Number.isFinite(Number(next.messageRetentionDays))) {
    next.messageRetentionDays = MESSAGE_RETENTION_DAYS;
  }
  if (!Number.isFinite(Number(next.draftRetentionDays))) {
    next.draftRetentionDays = DRAFT_RETENTION_DAYS;
  }
  if (!Number.isFinite(Number(next.auditRetentionDays))) {
    next.auditRetentionDays = DEFAULT_AUDIT_RETENTION_DAYS;
  }
  if (!next.retention || typeof next.retention !== 'object') {
    next.retention = {};
  }
  if (typeof next.workshopMode !== 'string') next.workshopMode = '';
  if (typeof next.aiBehavior !== 'string') next.aiBehavior = '';
  if (typeof next.assistantPersona !== 'string') next.assistantPersona = '';
  next.autopilot = normalizeAutopilotConfig(next.autopilot, AUTOPILOT_DEFAULT);
  if (!next.autopilotActions || typeof next.autopilotActions !== 'object') {
    next.autopilotActions = {};
  }
  if (!Number.isFinite(Number(next.lastParticipantMessageAt))) {
    next.lastParticipantMessageAt = 0;
  }
  next.shareLinks = normalizeShareLinksMap(next.shareLinks || {});
  if (!next.phaseCanvases || typeof next.phaseCanvases !== 'object') {
    next.phaseCanvases = {};
  }
  next.privateDrafts = normalizePrivateDraftMap(next.privateDrafts || {});
  next.decisionLog = normalizeDecisionLog(next.decisionLog || []);
  if (!Array.isArray(next.draftApprovedByUids)) next.draftApprovedByUids = [];
  if (!Number.isFinite(Number(next.draftApprovedVersion))) next.draftApprovedVersion = 0;
  if (!Number.isFinite(Number(next.draftApprovedAt))) next.draftApprovedAt = 0;
  if (!Number.isFinite(Number(next.lastAiFallbackAt))) next.lastAiFallbackAt = 0;
  if (typeof next.lastAiFallbackReason !== 'string') next.lastAiFallbackReason = '';
  if (typeof next.lastAiFallbackStage !== 'string') next.lastAiFallbackStage = '';
  return next;
}

async function syncRoomWorkshopConfig(roomId, workshop) {
  if (!roomId || !workshop) return ensureRoom(roomId);
  const room = await ensureRoom(roomId);
  const normalizedWorkshop = normalizeWorkshopPayload(workshop, workshop);
  const topicOptions = normalizedWorkshop.topicCatalog || [];
  const phasePlan = normalizedWorkshop.phases || [];

  const patch = {};
  const workshopLicenseId = normalizedLicenseId(
    workshop?.licenseId || normalizedWorkshop.licenseId || ''
  );
  const workshopOrgId = normalizedOrgId(
    workshop?.orgId || normalizedWorkshop.orgId || '',
    workshopLicenseId
  );
  if (String(room.licenseId || '') !== workshopLicenseId) {
    patch.licenseId = workshopLicenseId;
  }
  if (String(room.orgId || '') !== workshopOrgId) {
    patch.orgId = workshopOrgId;
  }
  if (String(room.workshopMode || '') !== String(normalizedWorkshop.mode || '')) {
    patch.workshopMode = normalizedWorkshop.mode || '';
  }
  if (String(room.aiBehavior || '') !== String(normalizedWorkshop.aiBehavior || '')) {
    patch.aiBehavior = normalizedWorkshop.aiBehavior || '';
  }
  if (
    String(room.assistantPersona || '') !==
    String(normalizedWorkshop.assistantPersona || '')
  ) {
    patch.assistantPersona = normalizedWorkshop.assistantPersona || '';
  }
  if (
    Number(room.messageRetentionDays || 0) !==
    Number(normalizedWorkshop.messageRetentionDays || MESSAGE_RETENTION_DAYS)
  ) {
    patch.messageRetentionDays = Number(
      normalizedWorkshop.messageRetentionDays || MESSAGE_RETENTION_DAYS
    );
  }
  if (
    Number(room.draftRetentionDays || 0) !==
    Number(normalizedWorkshop.draftRetentionDays || DRAFT_RETENTION_DAYS)
  ) {
    patch.draftRetentionDays = Number(
      normalizedWorkshop.draftRetentionDays || DRAFT_RETENTION_DAYS
    );
  }
  if (
    Number(room.auditRetentionDays || 0) !==
    Number(normalizedWorkshop.auditRetentionDays || DEFAULT_AUDIT_RETENTION_DAYS)
  ) {
    patch.auditRetentionDays = Number(
      normalizedWorkshop.auditRetentionDays || DEFAULT_AUDIT_RETENTION_DAYS
    );
  }
  if (Boolean(room.legalHold) !== Boolean(normalizedWorkshop.legalHold)) {
    patch.legalHold = !!normalizedWorkshop.legalHold;
  }
  if (!arraysEqual(room.topicOptions || [], topicOptions)) {
    patch.topicOptions = topicOptions;
  }
  if (!phasesEqual(room.phasePlan || [], phasePlan)) {
    patch.phasePlan = phasePlan;
  }

  if (!Object.keys(patch).length) {
    return room;
  }
  return updateRoom(roomId, patch);
}

async function putWithUniqueTimestamp(tableName, roomId, makeItem, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const createdAt = Date.now() + attempt;
    try {
      await ddbDoc.send(
        new PutCommand({
          TableName: tableName,
          Item: makeItem(createdAt),
          ConditionExpression: 'attribute_not_exists(createdAt)',
        })
      );
      return createdAt;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        continue;
      }
      if (shouldUseDemoFallback(err)) {
        logDemoFallback(`timestamp_put:${tableName}`, err);
        return putDemoTimestampedItem(tableName, roomId, makeItem, maxAttempts);
      }
      throw err;
    }
  }
  throw new Error(`Failed to write unique timestamped item for ${roomId}`);
}

async function getRoom(roomId) {
  try {
    const { Item } = await ddbDoc.send(
      new GetCommand({ TableName: TABLES.rooms, Key: { roomId } })
    );
    return Item || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('room_get', err);
    return getDemoRoomRecord(roomId);
  }
}

async function getWorkshopConfig(licenseIdRaw) {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (!licenseId) return null;
  try {
    const { Item } = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.workshops,
        Key: { licenseId },
      })
    );
    return Item || null;
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      console.warn('[workshops] table missing, falling back to defaults');
      return null;
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('workshop_get', err);
      return getDemoWorkshopRecord(licenseId);
    }
    throw err;
  }
}

async function ensureWorkshopConfig({
  licenseId,
  siteIds = [],
  mode = DEFAULT_WORKSHOP_MODE,
  orgId = '',
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId);
  if (!normalizedLicense) return null;

  const existing = await getWorkshopConfig(normalizedLicense);
  if (existing) {
    const normalized = {
      ...existing,
      orgId: normalizedOrgId(existing.orgId || orgId, normalizedLicense),
      licenseId: normalizedLicense,
      mode: normalizeMode(existing.mode),
      siteIds: sanitizeSiteIds(existing.siteIds, siteIds),
      seatLimitPerRoom: toPositiveInt(
        existing.seatLimitPerRoom,
        DEFAULT_SEAT_LIMIT_PER_ROOM,
        { min: 1, max: MAX_SEAT_LIMIT_PER_ROOM }
      ),
      expectedUsers: toPositiveInt(existing.expectedUsers, DEFAULT_EXPECTED_USERS, {
        min: 1,
        max: 20_000,
      }),
      activeUserCap: toPositiveInt(
        existing.activeUserCap,
        toPositiveInt(existing.expectedUsers, DEFAULT_EXPECTED_USERS, {
          min: 1,
          max: 20_000,
        }),
        { min: 1, max: 50_000 }
      ),
      aiBehavior: normalizeAiBehavior(existing.aiBehavior),
      licenseStatus: String(existing.licenseStatus || 'ACTIVE').trim().toUpperCase(),
      licenseExpiresAt: Number(existing.licenseExpiresAt || 0) || null,
      messageRetentionDays: toPositiveInt(
        existing.messageRetentionDays,
        MESSAGE_RETENTION_DAYS,
        { min: 1, max: 3650 }
      ),
      draftRetentionDays: toPositiveInt(existing.draftRetentionDays, DRAFT_RETENTION_DAYS, {
        min: 1,
        max: 3650,
      }),
      sessionRetentionHours: toPositiveInt(
        existing.sessionRetentionHours,
        SESSION_TTL_HOURS,
        { min: 1, max: 24 * 365 }
      ),
      auditRetentionDays: toPositiveInt(
        existing.auditRetentionDays,
        DEFAULT_AUDIT_RETENTION_DAYS,
        { min: 1, max: 3650 }
      ),
      legalHold: !!existing.legalHold,
      phases: applyPhaseCount(
        (Array.isArray(existing.phases) ? existing.phases : []).map((phase, idx) =>
          normalizePhase(phase, idx)
        ),
        existing.phaseCount
      ),
      topicCatalog: normalizeTopicCatalog(existing.topicCatalog || []),
      assistantPersona: String(existing.assistantPersona || '').trim() || DEFAULT_ASSISTANT_PERSONA,
    };
    normalized.phaseCount = normalized.phases.length;
    normalized.roomsPerSite = deriveRoomsPerSite(
      normalized.expectedUsers,
      normalized.seatLimitPerRoom
    );
    normalized.updatedAt = Date.now();

    // Backfill invalid/old records opportunistically.
    const needsBackfill =
      !Array.isArray(existing.siteIds) ||
      !Array.isArray(existing.phases) ||
      !Number.isFinite(Number(existing.roomsPerSite));
    if (needsBackfill) {
      try {
        await ddbDoc.send(
          new PutCommand({
            TableName: TABLES.workshops,
            Item: normalized,
          })
        );
      } catch (err) {
        if (!shouldUseDemoFallback(err)) throw err;
        logDemoFallback('workshop_backfill_put', err);
        putDemoWorkshopRecord(normalized);
      }
    }
    return normalized;
  }

  const created = createDefaultWorkshopConfig({
    licenseId: normalizedLicense,
    siteIds,
    mode,
    orgId,
  });
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.workshops,
        Item: created,
        ConditionExpression: 'attribute_not_exists(licenseId)',
      })
    );
    return created;
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('workshop_create_put', err);
      return putDemoWorkshopRecord(created) || created;
    }
    if (err?.name === 'ResourceNotFoundException') {
      console.warn('[workshops] table missing, using in-memory defaults only');
      return created;
    }
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    return getWorkshopConfig(normalizedLicense);
  }
}

function normalizeWorkshopPayload(input = {}, current = null) {
  const baseMode = normalizeMode(input.mode || current?.mode || DEFAULT_WORKSHOP_MODE);
  const template = WORKSHOP_MODE_TEMPLATES[baseMode];
  const basePhases = Array.isArray(current?.phases)
    ? current.phases.map((phase, idx) => normalizePhase(phase, idx))
    : cloneTemplatePhases(baseMode);

  const nextName =
    String(input.name ?? current?.name ?? template.label ?? '').trim() ||
    template.label;
  const nextDescription =
    String(input.description ?? current?.description ?? template.description ?? '').trim() ||
    template.description;

  const nextSiteIds = sanitizeSiteIds(
    input.siteIds,
    Array.isArray(current?.siteIds) ? current.siteIds : []
  );
  const expectedUsers = toPositiveInt(
    input.expectedUsers ?? current?.expectedUsers ?? DEFAULT_EXPECTED_USERS,
    DEFAULT_EXPECTED_USERS,
    { min: 1, max: 20_000 }
  );
  const activeUserCap = toPositiveInt(
    input.activeUserCap ?? current?.activeUserCap ?? expectedUsers,
    expectedUsers,
    { min: 1, max: 50_000 }
  );
  const seatLimitPerRoom = toPositiveInt(
    input.seatLimitPerRoom ?? current?.seatLimitPerRoom ?? DEFAULT_SEAT_LIMIT_PER_ROOM,
    DEFAULT_SEAT_LIMIT_PER_ROOM,
    { min: 1, max: MAX_SEAT_LIMIT_PER_ROOM }
  );
  const roomsPerSite = deriveRoomsPerSite(expectedUsers, seatLimitPerRoom);

  const providedPhases = Array.isArray(input.phases)
    ? input.phases.map((phase, idx) => normalizePhase(phase, idx))
    : basePhases;
  const phaseCount = toPositiveInt(
    input.phaseCount ?? providedPhases.length ?? current?.phaseCount ?? 1,
    providedPhases.length || 1,
    { min: 1, max: MAX_PHASE_COUNT }
  );
  const phases = applyPhaseCount(providedPhases, phaseCount);
  const assistantPersona = String(
    input.assistantPersona ?? current?.assistantPersona ?? DEFAULT_ASSISTANT_PERSONA
  ).trim();
  const nextLicenseId = normalizedLicenseId(
    input.licenseId ?? current?.licenseId ?? ''
  );
  const orgId = normalizedOrgId(
    input.orgId ?? current?.orgId ?? '',
    nextLicenseId
  );

  return {
    orgId,
    name: nextName,
    mode: baseMode,
    description: nextDescription,
    siteIds: nextSiteIds,
    expectedUsers,
    activeUserCap,
    seatLimitPerRoom,
    roomsPerSite,
    licenseStatus: ['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(
      String(input.licenseStatus ?? current?.licenseStatus ?? 'ACTIVE')
        .trim()
        .toUpperCase()
    )
      ? String(input.licenseStatus ?? current?.licenseStatus ?? 'ACTIVE')
          .trim()
          .toUpperCase()
      : 'ACTIVE',
    licenseExpiresAt:
      Number.isFinite(Number(input.licenseExpiresAt ?? current?.licenseExpiresAt))
        ? Number(input.licenseExpiresAt ?? current?.licenseExpiresAt ?? 0) || null
        : null,
    messageRetentionDays: toPositiveInt(
      input.messageRetentionDays ?? current?.messageRetentionDays ?? MESSAGE_RETENTION_DAYS,
      MESSAGE_RETENTION_DAYS,
      { min: 1, max: 3650 }
    ),
    draftRetentionDays: toPositiveInt(
      input.draftRetentionDays ?? current?.draftRetentionDays ?? DRAFT_RETENTION_DAYS,
      DRAFT_RETENTION_DAYS,
      { min: 1, max: 3650 }
    ),
    sessionRetentionHours: toPositiveInt(
      input.sessionRetentionHours ?? current?.sessionRetentionHours ?? SESSION_TTL_HOURS,
      SESSION_TTL_HOURS,
      { min: 1, max: 24 * 365 }
    ),
    auditRetentionDays: toPositiveInt(
      input.auditRetentionDays ?? current?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
      DEFAULT_AUDIT_RETENTION_DAYS,
      { min: 1, max: 3650 }
    ),
    legalHold:
      typeof input.legalHold === 'boolean'
        ? input.legalHold
        : !!current?.legalHold,
    aiBehavior: normalizeAiBehavior(input.aiBehavior ?? current?.aiBehavior),
    phaseCount: phases.length,
    phases,
    topicCatalog: normalizeTopicCatalog(
      input.topicCatalog ??
        current?.topicCatalog ??
        template.defaultTopics ??
        []
    ),
    enableTopicVoting:
      typeof input.enableTopicVoting === 'boolean'
        ? input.enableTopicVoting
        : !!current?.enableTopicVoting,
    assistantPersona: assistantPersona || DEFAULT_ASSISTANT_PERSONA,
  };
}

async function saveWorkshopConfig(licenseIdRaw, payload) {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (!licenseId) throw new Error('licenseId required');
  const current = await getWorkshopConfig(licenseId);
  const now = Date.now();
  const nextValues = normalizeWorkshopPayload(
    { ...(payload || {}), licenseId },
    current
  );
  const next = {
    licenseId,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    ...nextValues,
  };
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.workshops,
        Item: next,
      })
    );
    clearWorkshopTenantCache(licenseId);
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('workshop_save_put', err);
      putDemoWorkshopRecord(next);
      clearWorkshopTenantCache(licenseId);
      return next;
    }
    if (err?.name === 'ResourceNotFoundException') {
      throw new Error(
        `Workshop table '${TABLES.workshops}' is not provisioned. Configure DDB_TABLE_WORKSHOPS first.`
      );
    }
    throw err;
  }
  return next;
}

function normalizeSuperAdminEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashCodeValue(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return '';
  const hash = crypto.createHash('sha256');
  if (CODE_HASH_SECRET) {
    hash.update(`${CODE_HASH_SECRET}:${normalized}`);
  } else {
    hash.update(normalized);
  }
  return hash.digest('hex');
}

function codeExpiresAtMs(item = {}) {
  const directMs = Number(item.expiresAtMs || item.expiresAt || 0);
  if (Number.isFinite(directMs) && directMs > 0) return directMs;
  return 0;
}

function codeIsExpired(item = {}, now = Date.now()) {
  const expiresAt = codeExpiresAtMs(item);
  return !!expiresAt && now >= expiresAt;
}

function encodeCursor(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeCursor(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function queryByPartitionKey({
  tableName,
  indexName,
  partitionKey,
  partitionValue,
  limit = 100,
  scanForward = false,
  exclusiveStartKey = undefined,
}) {
  try {
    const query = new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#pk = :partition',
      ExpressionAttributeNames: {
        '#pk': partitionKey,
      },
      ExpressionAttributeValues: {
        ':partition': partitionValue,
      },
      ScanIndexForward: scanForward,
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    const out = await ddbDoc.send(query);
    return {
      items: Array.isArray(out.Items) ? out.Items : [],
      lastKey: out.LastEvaluatedKey || null,
    };
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback(`query:${tableName}:${partitionKey}`, err);
    return queryDemoByPartitionKey({
      tableName,
      indexName,
      partitionKey,
      partitionValue,
      limit,
      scanForward,
      exclusiveStartKey,
    });
  }
}

async function listActiveLicenseUserIds(licenseIdRaw, { windowMs = LICENSE_ACTIVE_USER_WINDOW_MS } = {}) {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (!licenseId) return new Set();
  const cutoff = Date.now() - Math.max(60_000, Number(windowMs || LICENSE_ACTIVE_USER_WINDOW_MS));
  const users = new Set();
  let lastKey = undefined;

  try {
    while (true) {
      const page = await queryByPartitionKey({
        tableName: TABLES.authSessions,
        indexName: 'byLicenseUpdatedAt',
        partitionKey: 'licenseId',
        partitionValue: licenseId,
        limit: 200,
        scanForward: false,
        exclusiveStartKey: lastKey,
      });
      const items = page.items || [];
      let reachedCutoff = false;
      for (const item of items) {
        const updatedAt = Number(item.updatedAt || item.lastSeenAt || 0);
        if (!updatedAt || updatedAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        if (!!item.revoked) continue;
        const uid = String(item.uid || '').trim();
        if (uid) users.add(uid);
      }
      if (reachedCutoff || !page.lastKey) break;
      lastKey = page.lastKey;
    }
    return users;
  } catch (err) {
    if (err?.name !== 'ResourceNotFoundException') throw err;
  }

  // Backward-compatible fallback when auth_sessions table/index is not provisioned yet.
  const roles = ['PARTICIPANT', 'PRESENTER', 'ADMIN', 'SUPER_ADMIN'];
  for (const role of roles) {
    let roleLastKey = undefined;
    while (true) {
      const page = await queryByPartitionKey({
        tableName: TABLES.sessions,
        indexName: 'byRoleLastSeen',
        partitionKey: 'role',
        partitionValue: role,
        limit: 200,
        scanForward: false,
        exclusiveStartKey: roleLastKey,
      });
      const items = page.items || [];
      let reachedCutoff = false;
      for (const item of items) {
        const lastSeenAt = Number(item.lastSeenAt || 0);
        if (!lastSeenAt || lastSeenAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        if (normalizedLicenseId(item.licenseId || '') !== licenseId) continue;
        const uid = String(item.uid || '').trim();
        if (uid) users.add(uid);
      }
      if (reachedCutoff || !page.lastKey) break;
      roleLastKey = page.lastKey;
    }
  }
  return users;
}

async function enforceLicenseActiveUserCap({
  licenseId,
  activeUserCap = 0,
  uid = '',
} = {}) {
  const cap = Number(activeUserCap || 0);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { ok: true, activeUsers: 0, cap: 0, alreadyActive: false };
  }
  try {
    const activeUserIds = await listActiveLicenseUserIds(licenseId);
    const userId = String(uid || '').trim();
    const alreadyActive = userId ? activeUserIds.has(userId) : false;
    if (!alreadyActive && activeUserIds.size >= cap) {
      return {
        ok: false,
        error: 'license_active_user_cap_reached',
        activeUsers: activeUserIds.size,
        cap,
        alreadyActive,
      };
    }
    return {
      ok: true,
      activeUsers: activeUserIds.size,
      cap,
      alreadyActive,
    };
  } catch (err) {
    console.warn('[license cap] active user count skipped:', err?.message || err);
    return { ok: true, activeUsers: 0, cap, alreadyActive: false };
  }
}

async function getItemByKey(tableName, key) {
  try {
    const { Item } = await ddbDoc.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      })
    );
    return Item || null;
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return null;
    if (shouldUseDemoFallback(err)) {
      logDemoFallback(`get_item:${tableName}`, err);
      return getDemoTableItem(tableName, key);
    }
    throw err;
  }
}

async function putItem(tableName, item) {
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback(`put_item:${tableName}`, err);
    putDemoTableItem(tableName, item);
  }
}

function normalizeOrgStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'SUSPENDED') return 'SUSPENDED';
  if (normalized === 'INACTIVE') return 'INACTIVE';
  return 'ACTIVE';
}

function normalizeSupportPlan(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'PREMIUM') return 'PREMIUM';
  if (normalized === 'ENTERPRISE') return 'ENTERPRISE';
  return 'STANDARD';
}

function normalizeOrgRecordPayload(input = {}, current = {}) {
  const name =
    String(input.name ?? current.name ?? '').trim() ||
    String(current.name || '').trim() ||
    'Unnamed Organization';
  const primaryDomain = String(
    input.primaryDomain ?? current.primaryDomain ?? ''
  )
    .trim()
    .toLowerCase();
  const siteIds = sanitizeSiteIds(input.siteIds, current.siteIds || []);
  return {
    name,
    primaryDomain,
    status: normalizeOrgStatus(input.status ?? current.status),
    tier: normalizeLicenseTier(input.tier ?? current.tier),
    supportPlan: normalizeSupportPlan(input.supportPlan ?? current.supportPlan),
    siteIds,
    ownerEmail: normalizeSuperAdminEmail(input.ownerEmail ?? current.ownerEmail),
    billingAccountId: String(
      input.billingAccountId ?? current.billingAccountId ?? ''
    ).trim(),
    notes: String(input.notes ?? current.notes ?? '').trim().slice(0, 2000),
  };
}

async function getOrgRecord(orgIdRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return null;
  return getItemByKey(TABLES.orgs, { orgId });
}

async function ensureOrgRecord({
  orgId,
  licenseId = '',
  siteIds = [],
  tier = 'STARTER',
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId);
  if (!normalizedOrg) return null;
  const existing = await getOrgRecord(normalizedOrg);
  if (existing) return existing;
  const now = Date.now();
  const created = {
    orgId: normalizedOrg,
    status: 'ACTIVE',
    tier: normalizeLicenseTier(tier),
    name: normalizedOrg,
    primaryDomain: '',
    siteIds: sanitizeSiteIds(siteIds, []),
    supportPlan: 'STANDARD',
    ownerEmail: '',
    billingAccountId: '',
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.orgs,
        Item: created,
        ConditionExpression: 'attribute_not_exists(orgId)',
      })
    );
    return created;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return (await getOrgRecord(normalizedOrg)) || created;
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('org_record_ensure', err);
      demoFallbackState.orgs.set(normalizedOrg, deepCloneDemo(created));
      return deepCloneDemo(created);
    }
    if (err?.name === 'ResourceNotFoundException') return created;
    throw err;
  }
}

async function saveOrgRecord(orgIdRaw, payload = {}, actor = {}) {
  const orgId = normalizedOrgId(orgIdRaw || '', payload.licenseId || actor.licenseId || '');
  if (!orgId) throw new Error('orgId_required');
  const current = await getOrgRecord(orgId);
  const now = Date.now();
  const next = {
    orgId,
    createdAt: Number(current?.createdAt || now),
    updatedAt: now,
    ...normalizeOrgRecordPayload(payload, current || {}),
  };
  await putItem(TABLES.orgs, next);
  return next;
}

async function listOrgsByStatus(status = 'ACTIVE', limit = 120, cursorKey = undefined) {
  const out = await queryByPartitionKey({
    tableName: TABLES.orgs,
    indexName: 'byStatusUpdatedAt',
    partitionKey: 'status',
    partitionValue: normalizeOrgStatus(status),
    limit,
    scanForward: false,
    exclusiveStartKey: cursorKey,
  });
  return out;
}

function normalizeLicenseRecordPayload(input = {}, current = {}) {
  const tier = normalizeLicenseTier(input.tier ?? current.tier);
  const seatCap = toPositiveInt(
    input.seatCap ?? current.seatCap ?? current.expectedUsers ?? DEFAULT_EXPECTED_USERS,
    DEFAULT_EXPECTED_USERS,
    { min: 1, max: 200_000 }
  );
  const activeUserCap = toPositiveInt(
    input.activeUserCap ?? current.activeUserCap ?? seatCap,
    seatCap,
    { min: 1, max: 200_000 }
  );
  return {
    orgId: normalizedOrgId(input.orgId ?? current.orgId ?? '', input.licenseId ?? current.licenseId ?? ''),
    status: normalizeLicenseState(input.status ?? current.status),
    tier,
    seatCap,
    activeUserCap,
    usageCap: toPositiveInt(input.usageCap ?? current.usageCap ?? seatCap * 8, seatCap * 8, {
      min: 1,
      max: 10_000_000,
    }),
    startsAt: Number(input.startsAt ?? current.startsAt ?? Date.now()) || Date.now(),
    expiresAt: Number(input.expiresAt ?? current.expiresAt ?? 0) || 0,
    renewalAt: Number(input.renewalAt ?? current.renewalAt ?? 0) || 0,
    overagePolicy: String(
      input.overagePolicy ?? current.overagePolicy ?? 'NOTIFY_ONLY'
    )
      .trim()
      .toUpperCase(),
    billingMode: String(input.billingMode ?? current.billingMode ?? 'INVOICE')
      .trim()
      .toUpperCase(),
    billingAccountId: String(
      input.billingAccountId ?? current.billingAccountId ?? ''
    ).trim(),
    notes: String(input.notes ?? current.notes ?? '').trim().slice(0, 2000),
  };
}

async function getLicenseRecord(licenseIdRaw) {
  const licenseId = normalizedLicenseId(licenseIdRaw);
  if (!licenseId) return null;
  return getItemByKey(TABLES.licenses, { licenseId });
}

async function saveLicenseRecord(licenseIdRaw, payload = {}, actor = {}) {
  const licenseId = normalizedLicenseId(licenseIdRaw || payload.licenseId || actor.licenseId || '');
  if (!licenseId) throw new Error('licenseId_required');
  const current = await getLicenseRecord(licenseId);
  const now = Date.now();
  const nextValues = normalizeLicenseRecordPayload(
    { ...(payload || {}), licenseId },
    current || {}
  );
  const next = {
    licenseId,
    createdAt: Number(current?.createdAt || now),
    updatedAt: now,
    ...nextValues,
  };
  await putItem(TABLES.licenses, next);
  return next;
}

async function ensureLicenseRecord({
  licenseId,
  orgId = '',
  seatCap = DEFAULT_EXPECTED_USERS,
  activeUserCap = DEFAULT_EXPECTED_USERS,
  tier = 'STARTER',
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId);
  if (!normalizedLicense) return null;
  const existing = await getLicenseRecord(normalizedLicense);
  if (existing) return existing;
  return saveLicenseRecord(normalizedLicense, {
    orgId: normalizedOrgId(orgId, normalizedLicense),
    status: 'ACTIVE',
    tier: normalizeLicenseTier(tier),
    seatCap,
    activeUserCap,
    startsAt: Date.now(),
  });
}

async function listLicensesByOrg(orgIdRaw, limit = 160, cursorKey = undefined) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return { items: [], lastKey: null };
  return queryByPartitionKey({
    tableName: TABLES.licenses,
    indexName: 'byOrgUpdatedAt',
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit,
    scanForward: false,
    exclusiveStartKey: cursorKey,
  });
}

async function listLicensesByStatus(status = 'ACTIVE', limit = 160, cursorKey = undefined) {
  return queryByPartitionKey({
    tableName: TABLES.licenses,
    indexName: 'byStatusUpdatedAt',
    partitionKey: 'status',
    partitionValue: normalizeLicenseState(status),
    limit,
    scanForward: false,
    exclusiveStartKey: cursorKey,
  });
}

function normalizeOrgUserRole(value) {
  const role = String(value || '').trim().toUpperCase();
  if (role === 'SUPER_ADMIN') return 'SUPER_ADMIN';
  if (role === 'ADMIN') return 'ADMIN';
  if (role === 'PRESENTER') return 'PRESENTER';
  return 'PARTICIPANT';
}

function normalizeOrgUserId(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw.toLowerCase().replace(/[^a-z0-9@._-]/g, '-').slice(0, 120);
}

function deriveOrgUserIdFromEmail(email) {
  const normalized = normalizeSuperAdminEmail(email);
  if (!normalized) return '';
  return `email:${normalizeOrgUserId(normalized)}`;
}

async function listOrgUsers(orgIdRaw, limit = 200, cursorKey = undefined) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return { items: [], lastKey: null };
  return queryByPartitionKey({
    tableName: TABLES.orgUsers,
    indexName: undefined,
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit: Math.min(500, limit),
    scanForward: true,
    exclusiveStartKey: cursorKey,
  });
}

async function getOrgUser(orgIdRaw, userIdRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  const userId = normalizeOrgUserId(userIdRaw);
  if (!orgId || !userId) return null;
  return getItemByKey(TABLES.orgUsers, { orgId, userId });
}

async function saveOrgUser(orgIdRaw, userIdRaw, payload = {}, actor = {}) {
  const orgId = normalizedOrgId(orgIdRaw || '', actor.licenseId || '');
  const userId = normalizeOrgUserId(userIdRaw || payload.userId || deriveOrgUserIdFromEmail(payload.email));
  if (!orgId || !userId) throw new Error('org_user_identity_required');
  const current = await getOrgUser(orgId, userId);
  const now = Date.now();
  const email = normalizeSuperAdminEmail(payload.email ?? current?.email ?? '');
  const next = {
    orgId,
    userId,
    createdAt: Number(current?.createdAt || now),
    updatedAt: now,
    email,
    name: String(payload.name ?? current?.name ?? '').trim(),
    role: normalizeOrgUserRole(payload.role ?? current?.role),
    siteIds: sanitizeSiteIds(payload.siteIds, current?.siteIds || []),
    active: payload.active !== false,
    groups: Array.isArray(payload.groups)
      ? payload.groups.map((g) => String(g || '').trim()).filter(Boolean)
      : Array.isArray(current?.groups)
      ? current.groups
      : [],
    invitedBy: String(payload.invitedBy ?? current?.invitedBy ?? actor.uid ?? '').trim(),
    notes: String(payload.notes ?? current?.notes ?? '').trim().slice(0, 1000),
  };
  await putItem(TABLES.orgUsers, next);
  return next;
}

async function deactivateOrgUser(orgIdRaw, userIdRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  const userId = normalizeOrgUserId(userIdRaw);
  if (!orgId || !userId) throw new Error('org_user_identity_required');
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.orgUsers,
        Key: { orgId, userId },
        UpdateExpression: 'SET active = :false, updatedAt = :now',
        ExpressionAttributeValues: {
          ':false': false,
          ':now': Date.now(),
        },
      })
    );
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('org_user_deactivate', err);
    const key = `${orgId}::${userId}`;
    const current = demoFallbackState.orgUsers.get(key);
    if (!current) return;
    demoFallbackState.orgUsers.set(key, {
      ...current,
      active: false,
      updatedAt: Date.now(),
    });
  }
}

function makeScopeId({ orgId = '', licenseId = '', tier = '' } = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || '');
  if (normalizedOrg) return `ORG#${normalizedOrg}`;
  const normalizedLicense = normalizedLicenseId(licenseId || '');
  if (normalizedLicense) return `LIC#${normalizedLicense}`;
  const normalizedTier = normalizeLicenseTier(tier || 'STARTER');
  return `TIER#${normalizedTier}`;
}

async function listFeatureFlags(scopeIdRaw) {
  const scopeId = String(scopeIdRaw || '').trim().toUpperCase();
  if (!scopeId) return [];
  const out = await queryByPartitionKey({
    tableName: TABLES.featureFlags,
    indexName: undefined,
    partitionKey: 'scopeId',
    partitionValue: scopeId,
    limit: 400,
    scanForward: true,
  });
  return Array.isArray(out.items) ? out.items : [];
}

async function saveFeatureFlags(scopeIdRaw, patch = {}, actor = {}) {
  const scopeId = String(scopeIdRaw || '').trim().toUpperCase();
  if (!scopeId) throw new Error('scopeId_required');
  const flags = normalizeFeatureFlagPatch(patch);
  const now = Date.now();
  const out = [];
  for (const [flagKeyRaw, enabled] of Object.entries(flags)) {
    const flagKey = String(flagKeyRaw || '').trim();
    if (!flagKey) continue;
    const item = {
      scopeId,
      flagKey,
      enabled: !!enabled,
      updatedAt: now,
      updatedBy: String(actor.uid || '').trim() || '(system)',
    };
    // eslint-disable-next-line no-await-in-loop
    await putItem(TABLES.featureFlags, item);
    out.push(item);
  }
  return out;
}

async function getEffectiveFeatureFlags({
  orgId = '',
  licenseId = '',
  tier = 'STARTER',
} = {}) {
  const normalizedTier = normalizeLicenseTier(tier || 'STARTER');
  const base = {
    ...(FEATURE_FLAG_DEFAULTS_BY_TIER[normalizedTier] || {}),
  };
  const tierScope = makeScopeId({ tier: normalizedTier });
  const orgScope = makeScopeId({ orgId, licenseId });
  const licenseScope = makeScopeId({ licenseId });

  const [tierFlags, orgFlags, licenseFlags] = await Promise.all([
    listFeatureFlags(tierScope).catch(() => []),
    listFeatureFlags(orgScope).catch(() => []),
    listFeatureFlags(licenseScope).catch(() => []),
  ]);
  for (const row of [...tierFlags, ...orgFlags, ...licenseFlags]) {
    const flagKey = String(row.flagKey || '').trim();
    if (!flagKey) continue;
    base[flagKey] = !!row.enabled;
  }
  return base;
}

async function getPolicy(scopeIdRaw, policyType = 'AI') {
  const scopeId = String(scopeIdRaw || '').trim().toUpperCase();
  const type = String(policyType || 'AI').trim().toUpperCase();
  if (!scopeId || !type) return null;
  return getItemByKey(TABLES.policies, { scopeId, policyType: type });
}

async function saveAiPolicy(scopeIdRaw, policyInput = {}, actor = {}) {
  const scopeId = String(scopeIdRaw || '').trim().toUpperCase();
  if (!scopeId) throw new Error('scopeId_required');
  const now = Date.now();
  const policy = normalizeAiPolicy(policyInput);
  const item = {
    scopeId,
    policyType: 'AI',
    policy: JSON.stringify(policy),
    updatedAt: now,
    updatedBy: String(actor.uid || '').trim() || '(system)',
  };
  await putItem(TABLES.policies, item);
  return { ...item, policy };
}

async function listTemplatesForOrg(orgIdRaw, limit = 300) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return [];
  const out = await queryByPartitionKey({
    tableName: TABLES.templates,
    indexName: undefined,
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit: Math.min(500, limit),
    scanForward: false,
  });
  return (out.items || []).map((item) => ({
    ...item,
    status: normalizeTemplateState(item.status),
    mode: normalizeMode(item.mode),
    phases: Array.isArray(item.phases) ? item.phases : [],
    topicCatalog: normalizeTopicCatalog(item.topicCatalog || []),
  }));
}

async function getTemplateByKey(orgIdRaw, templateKeyRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  const templateKey = String(templateKeyRaw || '').trim();
  if (!orgId || !templateKey) return null;
  const item = await getItemByKey(TABLES.templates, { orgId, templateKey });
  if (!item) return null;
  return {
    ...item,
    status: normalizeTemplateState(item.status),
    mode: normalizeMode(item.mode),
    phases: Array.isArray(item.phases) ? item.phases : [],
    topicCatalog: normalizeTopicCatalog(item.topicCatalog || []),
  };
}

function makeTemplateKey(templateId, version) {
  return `${String(templateId || '').trim()}#v${Number(version || 1)}`;
}

async function saveTemplateRecord(orgIdRaw, templateRecord = {}) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) throw new Error('orgId_required');
  const templateId =
    String(templateRecord.templateId || '').trim() || makePrefixedId('TPL');
  const version = toPositiveInt(templateRecord.version, 1, { min: 1, max: 999 });
  const templateKey = makeTemplateKey(templateId, version);
  const now = Date.now();
  const item = {
    orgId,
    templateKey,
    templateId,
    version,
    name: String(templateRecord.name || '').trim() || `${templateId} v${version}`,
    mode: normalizeMode(templateRecord.mode || DEFAULT_WORKSHOP_MODE),
    description: String(templateRecord.description || '').trim(),
    status: normalizeTemplateState(templateRecord.status || 'DRAFT'),
    phases: Array.isArray(templateRecord.phases)
      ? templateRecord.phases.map((phase, idx) => normalizePhase(phase, idx))
      : [],
    topicCatalog: normalizeTopicCatalog(templateRecord.topicCatalog || []),
    metadata: parseJsonObject(templateRecord.metadata, {}),
    createdAt: Number(templateRecord.createdAt || now),
    updatedAt: now,
    createdBy: String(templateRecord.createdBy || '').trim() || '(system)',
    updatedBy: String(templateRecord.updatedBy || '').trim() || '(system)',
    publishedAt: Number(templateRecord.publishedAt || 0) || 0,
    deprecatedAt: Number(templateRecord.deprecatedAt || 0) || 0,
  };
  await putItem(TABLES.templates, item);
  return item;
}

async function createApprovalRequest({
  orgId,
  licenseId = '',
  requestType = '',
  targetType = '',
  targetId = '',
  payload = {},
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || actor.licenseId || '');
  if (!normalizedOrg) throw new Error('orgId_required');
  const now = Date.now();
  const approvalId = `${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
  const item = {
    orgId: normalizedOrg,
    approvalId,
    status: 'PENDING',
    requestType: String(requestType || '').trim().toUpperCase(),
    targetType: String(targetType || '').trim().toUpperCase(),
    targetId: String(targetId || '').trim(),
    payload: JSON.stringify(payload || {}),
    requestedBy: String(actor.uid || '').trim() || '(system)',
    requestedRole: String(actor.role || '').trim().toUpperCase() || 'SYSTEM',
    licenseId: normalizedLicenseId(licenseId || actor.licenseId || ''),
    requestedAt: now,
    decidedAt: 0,
    decidedBy: '',
    decisionNote: '',
    consumedAt: 0,
  };
  await putItem(TABLES.approvals, item);
  return item;
}

async function getApprovalRequest(orgIdRaw, approvalIdRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  const approvalId = String(approvalIdRaw || '').trim();
  if (!orgId || !approvalId) return null;
  return getItemByKey(TABLES.approvals, { orgId, approvalId });
}

async function listApprovalsForOrg(orgIdRaw, limit = 200) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return [];
  const out = await queryByPartitionKey({
    tableName: TABLES.approvals,
    indexName: undefined,
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit: Math.min(500, limit),
    scanForward: false,
  });
  return Array.isArray(out.items) ? out.items : [];
}

async function listApprovalsByStatus(status = 'PENDING', limit = 200, cursorKey = undefined) {
  return queryByPartitionKey({
    tableName: TABLES.approvals,
    indexName: 'byStatusRequestedAt',
    partitionKey: 'status',
    partitionValue: normalizeApprovalState(status),
    limit,
    scanForward: false,
    exclusiveStartKey: cursorKey,
  });
}

async function decideApproval({
  orgId,
  approvalId,
  decision,
  note = '',
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '');
  const normalizedApprovalId = String(approvalId || '').trim();
  const finalDecision = normalizeApprovalState(decision || 'REJECTED');
  if (!normalizedOrg || !normalizedApprovalId) throw new Error('approval_identity_required');
  if (finalDecision === 'PENDING') throw new Error('decision_required');
  const now = Date.now();
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.approvals,
        Key: { orgId: normalizedOrg, approvalId: normalizedApprovalId },
        UpdateExpression:
          'SET #status = :status, decidedAt = :now, decidedBy = :uid, decisionNote = :note',
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': finalDecision,
          ':pending': 'PENDING',
          ':now': now,
          ':uid': String(actor.uid || '').trim() || '(system)',
          ':note': String(note || '').trim().slice(0, 2000),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return Attributes || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('approval_decide', err);
    const key = `${normalizedOrg}::${normalizedApprovalId}`;
    const current = demoFallbackState.approvals.get(key);
    if (!current || String(current.status || '').toUpperCase() !== 'PENDING') return null;
    const next = {
      ...current,
      status: finalDecision,
      decidedAt: now,
      decidedBy: String(actor.uid || '').trim() || '(system)',
      decisionNote: String(note || '').trim().slice(0, 2000),
    };
    demoFallbackState.approvals.set(key, next);
    return deepCloneDemo(next);
  }
}

async function markApprovalConsumed(orgIdRaw, approvalIdRaw) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  const approvalId = String(approvalIdRaw || '').trim();
  if (!orgId || !approvalId) return null;
  const now = Date.now();
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.approvals,
        Key: { orgId, approvalId },
        UpdateExpression: 'SET consumedAt = :now',
        ConditionExpression: 'attribute_not_exists(consumedAt) OR consumedAt = :zero',
        ExpressionAttributeValues: {
          ':now': now,
          ':zero': 0,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return Attributes || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('approval_consume', err);
    const key = `${orgId}::${approvalId}`;
    const current = demoFallbackState.approvals.get(key);
    if (!current || Number(current.consumedAt || 0) > 0) return null;
    const next = { ...current, consumedAt: now };
    demoFallbackState.approvals.set(key, next);
    return deepCloneDemo(next);
  }
}

async function resolveSensitiveChangeGate(req, {
  orgId = '',
  licenseId = '',
  requestType = '',
  targetType = '',
  targetId = '',
  payload = {},
} = {}) {
  if (isSuperAdminReq(req)) return { ok: true, bypass: true };
  const approvalId = String(req.body?.approvalId || '').trim();
  const submitForApproval =
    String(req.body?.submitForApproval || '').trim().toLowerCase() === 'true' ||
    req.body?.submitForApproval === true ||
    !approvalId;
  if (!approvalId && submitForApproval) {
    const approval = await createApprovalRequest({
      orgId,
      licenseId,
      requestType,
      targetType,
      targetId,
      payload,
      actor: req.user,
    });
    return {
      ok: false,
      approvalRequired: true,
      statusCode: 202,
      approval,
    };
  }

  const approval = await getApprovalRequest(orgId, approvalId);
  if (!approval) {
    return { ok: false, statusCode: 404, error: 'approval_not_found' };
  }
  if (normalizeApprovalState(approval.status) !== 'APPROVED') {
    return { ok: false, statusCode: 409, error: 'approval_not_approved' };
  }
  if (Number(approval.consumedAt || 0) > 0) {
    return { ok: false, statusCode: 409, error: 'approval_already_consumed' };
  }
  const expectedType = String(requestType || '').trim().toUpperCase();
  if (expectedType && String(approval.requestType || '').toUpperCase() !== expectedType) {
    return { ok: false, statusCode: 409, error: 'approval_type_mismatch' };
  }
  return { ok: true, approval };
}

async function recordBillingEvent({
  orgId = '',
  licenseId = '',
  eventType = 'INVOICE',
  amountCents = 0,
  currency = 'USD',
  status = 'CREATED',
  payload = {},
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || actor.licenseId || '');
  if (!normalizedOrg) throw new Error('orgId_required');
  const now = Date.now();
  const billingEventId = `${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
  const item = {
    orgId: normalizedOrg,
    billingEventId,
    licenseId: normalizedLicenseId(licenseId || actor.licenseId || ''),
    eventType: String(eventType || 'INVOICE').trim().toUpperCase(),
    amountCents: Math.max(0, Number(amountCents || 0)),
    currency: String(currency || 'USD').trim().toUpperCase() || 'USD',
    status: String(status || 'CREATED').trim().toUpperCase(),
    payload: JSON.stringify(payload || {}),
    actorUid: String(actor.uid || '').trim() || '(system)',
    createdAt: now,
    updatedAt: now,
  };
  await putItem(TABLES.billing, item);
  return item;
}

async function listBillingEventsByOrg(orgIdRaw, limit = 200) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return [];
  const out = await queryByPartitionKey({
    tableName: TABLES.billing,
    indexName: undefined,
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit: Math.min(500, limit),
    scanForward: false,
  });
  return Array.isArray(out.items) ? out.items : [];
}

async function sendInvoiceToProvider({
  invoiceId,
  orgId,
  licenseId,
  amountCents,
  currency,
  description,
  dueAt,
}) {
  const basePayload = {
    invoiceId,
    orgId,
    licenseId,
    amountCents,
    currency,
    description,
    dueAt,
  };
  if (BILLING_PROVIDER === 'stripe' && BILLING_API_KEY) {
    const form = new URLSearchParams();
    form.set('description', description || `Invoice ${invoiceId}`);
    form.set('metadata[invoiceId]', invoiceId);
    form.set('metadata[orgId]', orgId);
    form.set('metadata[licenseId]', licenseId || '');
    form.set('collection_method', 'send_invoice');
    form.set('days_until_due', '30');
    const res = await fetch(BILLING_STRIPE_INVOICE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BILLING_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, provider: 'stripe', error: body.slice(0, 2000) };
    }
    return { ok: true, provider: 'stripe', response: body.slice(0, 6000) };
  }

  if (BILLING_PROVIDER === 'enterprise' && BILLING_ENTERPRISE_INVOICE_ENDPOINT) {
    const res = await fetch(BILLING_ENTERPRISE_INVOICE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: BILLING_API_KEY ? `Bearer ${BILLING_API_KEY}` : '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(basePayload),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, provider: 'enterprise', error: body.slice(0, 2000) };
    }
    return { ok: true, provider: 'enterprise', response: body.slice(0, 6000) };
  }

  return { ok: true, provider: 'manual', response: JSON.stringify(basePayload) };
}

function billingPeriodKeyUtc(timestampMs = Date.now()) {
  const d = new Date(Number(timestampMs || Date.now()));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function billingPeriodWindowUtc(periodKeyRaw = '') {
  const now = new Date();
  const match = String(periodKeyRaw || '').trim().match(/^([0-9]{4})-([0-9]{2})$/);
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const monthZeroIndexed = match
    ? Math.max(0, Math.min(11, Number(match[2]) - 1))
    : now.getUTCMonth();
  const startMs = Date.UTC(year, monthZeroIndexed, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, monthZeroIndexed + 1, 1, 0, 0, 0, 0) - 1;
  return {
    periodKey: `${year}-${String(monthZeroIndexed + 1).padStart(2, '0')}`,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

function normalizeOveragePolicy(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'AUTO_INVOICE') return 'AUTO_INVOICE';
  if (normalized === 'AUTO_BILL') return 'AUTO_BILL';
  if (normalized === 'AUTO_CHARGE') return 'AUTO_CHARGE';
  if (normalized === 'HARD_CAP') return 'HARD_CAP';
  return 'NOTIFY_ONLY';
}

function isAutoInvoicePolicy(policyRaw) {
  const policy = normalizeOveragePolicy(policyRaw);
  return policy === 'AUTO_INVOICE' || policy === 'AUTO_BILL' || policy === 'AUTO_CHARGE';
}

function overageUnitPriceCentsForTier(tierRaw) {
  const tier = normalizeLicenseTier(tierRaw || 'STARTER');
  if (tier === 'ENTERPRISE') return BILLING_OVERAGE_UNIT_PRICE_ENTERPRISE_CENTS;
  if (tier === 'PRO') return BILLING_OVERAGE_UNIT_PRICE_PRO_CENTS;
  return BILLING_OVERAGE_UNIT_PRICE_STARTER_CENTS;
}

function computeMeteredUsageUnits(usage = {}) {
  const activeUsers = Math.max(0, Number(usage.activeUsers || 0));
  const assignedSeats = Math.max(0, Number(usage.assignedSeats || 0));
  const activeRooms = Math.max(0, Number(usage.activeRooms || 0));
  const aiUsageCostCents30d = Math.max(0, Number(usage.aiUsageCostCents30d || 0));
  const components = {
    activeUsersUnits: activeUsers * 2,
    assignedSeatUnits: assignedSeats,
    activeRoomUnits: activeRooms * 3,
    aiCostUnits: Math.ceil(aiUsageCostCents30d / 100),
  };
  return {
    totalUnits: Math.max(
      0,
      Number(
        components.activeUsersUnits +
          components.assignedSeatUnits +
          components.activeRoomUnits +
          components.aiCostUnits
      ) || 0
    ),
    components,
  };
}

function buildBillingSnapshotFromUsage({
  license = {},
  usage = {},
  periodKey = billingPeriodKeyUtc(),
} = {}) {
  const usageCap = Math.max(0, Number(license?.usageCap || 0));
  const seatCap = Math.max(0, Number(license?.seatCap || 0));
  const activeUserCap = Math.max(0, Number(license?.activeUserCap || 0));
  const overagePolicy = normalizeOveragePolicy(license?.overagePolicy || 'NOTIFY_ONLY');
  const billingMode = String(license?.billingMode || 'INVOICE').trim().toUpperCase() || 'INVOICE';
  const window = billingPeriodWindowUtc(periodKey);
  const metered = computeMeteredUsageUnits(usage);
  const overageUnits = usageCap > 0 ? Math.max(0, metered.totalUnits - usageCap) : 0;
  const unitPriceCents = overageUnitPriceCentsForTier(license?.tier || 'STARTER');
  const overageAmountCents = overageUnits * unitPriceCents;
  return {
    periodKey: window.periodKey,
    periodStartMs: window.startMs,
    periodEndMs: window.endMs,
    periodStartIso: window.startIso,
    periodEndIso: window.endIso,
    usageCap,
    seatCap,
    activeUserCap,
    overagePolicy,
    billingMode,
    meteredUnits: metered.totalUnits,
    meteredUnitComponents: metered.components,
    overageUnits,
    overageUnitPriceCents: unitPriceCents,
    overageAmountCents,
    projectedInvoiceAmountUsd: Number((overageAmountCents / 100).toFixed(2)),
  };
}

async function upsertBillingEventById({
  orgId = '',
  billingEventId = '',
  licenseId = '',
  eventType = '',
  amountCents = 0,
  currency = 'USD',
  status = 'CREATED',
  payload = {},
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || actor.licenseId || '');
  const normalizedLicense = normalizedLicenseId(licenseId || actor.licenseId || '');
  const eventId = String(billingEventId || '').trim();
  if (!normalizedOrg || !eventId) throw new Error('billing_identity_required');
  const now = Date.now();
  const existing = await getItemByKey(TABLES.billing, {
    orgId: normalizedOrg,
    billingEventId: eventId,
  });
  const item = {
    orgId: normalizedOrg,
    billingEventId: eventId,
    licenseId: normalizedLicense,
    eventType: String(eventType || '').trim().toUpperCase() || 'INVOICE',
    amountCents: Math.max(0, Number(amountCents || 0)),
    currency: String(currency || 'USD').trim().toUpperCase() || 'USD',
    status: String(status || 'CREATED').trim().toUpperCase(),
    payload: JSON.stringify(payload || {}),
    actorUid: String(actor.uid || '').trim() || '(system)',
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
  };
  await putItem(TABLES.billing, item);
  return item;
}

async function upsertBillingMeterEvent({
  orgId = '',
  licenseId = '',
  snapshot = {},
  usage = {},
  actor = {},
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId || actor.licenseId || '');
  const periodKey = String(snapshot.periodKey || billingPeriodKeyUtc()).trim();
  const billingEventId = `METER#${periodKey}#${normalizedLicense}`;
  const status = Number(snapshot.overageUnits || 0) > 0 ? 'OVER_CAP' : 'CAP_OK';
  return upsertBillingEventById({
    orgId,
    billingEventId,
    licenseId: normalizedLicense,
    eventType: 'USAGE_METER',
    amountCents: Number(snapshot.overageAmountCents || 0),
    status,
    payload: {
      periodKey,
      periodStartMs: Number(snapshot.periodStartMs || 0),
      periodEndMs: Number(snapshot.periodEndMs || 0),
      meteredUnits: Number(snapshot.meteredUnits || 0),
      unitComponents: snapshot.meteredUnitComponents || {},
      usageCap: Number(snapshot.usageCap || 0),
      overageUnits: Number(snapshot.overageUnits || 0),
      overageAmountCents: Number(snapshot.overageAmountCents || 0),
      usage: {
        activeUsers: Number(usage.activeUsers || 0),
        assignedSeats: Number(usage.assignedSeats || 0),
        activeRooms: Number(usage.activeRooms || 0),
        aiUsageCostCents30d: Number(usage.aiUsageCostCents30d || 0),
      },
    },
    actor,
  });
}

async function upsertBillingOverageAlertEvent({
  orgId = '',
  licenseId = '',
  snapshot = {},
  actor = {},
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId || actor.licenseId || '');
  const periodKey = String(snapshot.periodKey || billingPeriodKeyUtc()).trim();
  const billingEventId = `ALERT#${periodKey}#${normalizedLicense}`;
  return upsertBillingEventById({
    orgId,
    billingEventId,
    licenseId: normalizedLicense,
    eventType: 'OVERAGE_ALERT',
    amountCents: Number(snapshot.overageAmountCents || 0),
    status: 'NOTIFIED',
    payload: {
      periodKey,
      overageUnits: Number(snapshot.overageUnits || 0),
      overageAmountCents: Number(snapshot.overageAmountCents || 0),
      policy: normalizeOveragePolicy(snapshot.overagePolicy || 'NOTIFY_ONLY'),
    },
    actor,
  });
}

async function upsertBillingOverageInvoiceEvent({
  orgId = '',
  licenseId = '',
  snapshot = {},
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || actor.licenseId || '');
  const normalizedLicense = normalizedLicenseId(licenseId || actor.licenseId || '');
  const periodKey = String(snapshot.periodKey || billingPeriodKeyUtc()).trim();
  const invoiceEventId = `INVOICE#${periodKey}#${normalizedLicense}`;
  const existing = await getItemByKey(TABLES.billing, {
    orgId: normalizedOrg,
    billingEventId: invoiceEventId,
  }).catch(() => null);
  if (existing) {
    return {
      event: existing,
      providerResult: { ok: true, provider: 'cached', response: 'existing_invoice_event' },
    };
  }
  const invoiceId = `INV-${periodKey}-${normalizedLicense}`;
  const amountCents = Math.max(0, Number(snapshot.overageAmountCents || 0));
  const description = `${periodKey} overage (${Number(snapshot.overageUnits || 0)} units)`;
  const dueAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const providerResult = await sendInvoiceToProvider({
    invoiceId,
    orgId: normalizedOrg,
    licenseId: normalizedLicense,
    amountCents,
    currency: 'USD',
    description,
    dueAt,
  });
  const event = await upsertBillingEventById({
    orgId: normalizedOrg,
    billingEventId: invoiceEventId,
    licenseId: normalizedLicense,
    eventType: 'OVERAGE_INVOICE',
    amountCents,
    currency: 'USD',
    status: providerResult.ok ? 'SENT' : 'FAILED',
    payload: {
      periodKey,
      invoiceId,
      dueAt,
      overageUnits: Number(snapshot.overageUnits || 0),
      overageUnitPriceCents: Number(snapshot.overageUnitPriceCents || 0),
      provider: providerResult.provider || BILLING_PROVIDER,
      providerError: String(providerResult.error || '').slice(0, 1200),
      providerResponse: String(providerResult.response || '').slice(0, 1600),
    },
    actor,
  });
  return { event, providerResult };
}

async function buildBillingTransparencySummary({
  orgId = '',
  licenseId = '',
  workshop = null,
  license = null,
  usage = null,
  siteIds = [],
  billingRows = null,
  actor = {},
  periodKey = '',
  automate = false,
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId || actor.licenseId || '');
  const normalizedOrg = normalizedOrgId(orgId || '', normalizedLicense || actor.licenseId || '');
  if (!normalizedOrg || !normalizedLicense) {
    return {
      periodKey: billingPeriodKeyUtc(),
      usage: {},
      entitlements: {},
      overage: {},
      automation: { enabled: BILLING_AUTOMATION_ENABLED, ran: false },
      meterHistory: [],
      invoices: [],
      recentEvents: [],
    };
  }
  const resolvedLicense = license || (await getLicenseRecord(normalizedLicense)) || {};
  const resolvedWorkshop = workshop || (await getWorkshopByLicenseCached(normalizedLicense).catch(() => null));
  const resolvedSiteIds = sanitizeSiteIds(
    siteIds,
    resolvedWorkshop?.siteIds || []
  );
  const usageSnapshot =
    usage ||
    (await getLicenseUsageSnapshot({
      licenseId: normalizedLicense,
      orgId: normalizedOrg,
      siteIds: resolvedSiteIds,
    }));
  const snapshot = buildBillingSnapshotFromUsage({
    license: resolvedLicense,
    usage: usageSnapshot,
    periodKey: periodKey || billingPeriodKeyUtc(),
  });

  let meterEvent = null;
  let overageEvent = null;
  if (automate && BILLING_AUTOMATION_ENABLED) {
    meterEvent = await upsertBillingMeterEvent({
      orgId: normalizedOrg,
      licenseId: normalizedLicense,
      snapshot,
      usage: usageSnapshot,
      actor,
    }).catch(() => null);
    if (Number(snapshot.overageUnits || 0) > 0) {
      if (isAutoInvoicePolicy(snapshot.overagePolicy)) {
        const invoiceResult = await upsertBillingOverageInvoiceEvent({
          orgId: normalizedOrg,
          licenseId: normalizedLicense,
          snapshot,
          actor,
        }).catch(() => null);
        overageEvent = invoiceResult?.event || null;
      } else {
        overageEvent = await upsertBillingOverageAlertEvent({
          orgId: normalizedOrg,
          licenseId: normalizedLicense,
          snapshot,
          actor,
        }).catch(() => null);
      }
    }
  }

  const rows = Array.isArray(billingRows)
    ? billingRows
    : await listBillingEventsByOrg(normalizedOrg, 380).catch(() => []);
  const mappedRows = (Array.isArray(rows) ? rows : [])
    .map(mapBillingEventRow)
    .filter((row) => normalizedLicenseId(row.licenseId || '') === normalizedLicense)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const meterHistory = mappedRows
    .filter((row) => row.eventType === 'USAGE_METER')
    .slice(0, 12)
    .map((row) => {
      const payload = row.payload || {};
      return {
        periodKey: String(payload.periodKey || ''),
        meteredUnits: Number(payload.meteredUnits || 0),
        usageCap: Number(payload.usageCap || 0),
        overageUnits: Number(payload.overageUnits || 0),
        overageAmountCents: Number(payload.overageAmountCents || 0),
        createdAt: row.createdAt,
      };
    });
  const invoices = mappedRows
    .filter((row) => row.eventType.includes('INVOICE'))
    .slice(0, 24);

  return {
    periodKey: snapshot.periodKey,
    periodStartIso: snapshot.periodStartIso,
    periodEndIso: snapshot.periodEndIso,
    entitlements: {
      tier: normalizeLicenseTier(resolvedLicense?.tier || 'STARTER'),
      status: normalizeLicenseState(resolvedLicense?.status || 'ACTIVE'),
      seatCap: snapshot.seatCap,
      activeUserCap: snapshot.activeUserCap,
      usageCap: snapshot.usageCap,
      overagePolicy: snapshot.overagePolicy,
      billingMode: snapshot.billingMode,
      billingAccountId: String(resolvedLicense?.billingAccountId || ''),
    },
    usage: {
      activeUsers: Number(usageSnapshot.activeUsers || 0),
      assignedSeats: Number(usageSnapshot.assignedSeats || 0),
      activeRooms: Number(usageSnapshot.activeRooms || 0),
      aiUsageCostCents30d: Number(usageSnapshot.aiUsageCostCents30d || 0),
      meteredUnits: Number(snapshot.meteredUnits || 0),
      unitComponents: snapshot.meteredUnitComponents || {},
    },
    overage: {
      units: Number(snapshot.overageUnits || 0),
      unitPriceCents: Number(snapshot.overageUnitPriceCents || 0),
      projectedAmountCents: Number(snapshot.overageAmountCents || 0),
      projectedAmountUsd: Number(snapshot.projectedInvoiceAmountUsd || 0),
      requiresAction:
        Number(snapshot.overageUnits || 0) > 0 &&
        normalizeOveragePolicy(snapshot.overagePolicy) === 'HARD_CAP',
    },
    automation: {
      enabled: BILLING_AUTOMATION_ENABLED,
      ran: !!automate && BILLING_AUTOMATION_ENABLED,
      meterEventId: meterEvent?.billingEventId || '',
      overageEventId: overageEvent?.billingEventId || '',
    },
    meterHistory,
    invoices,
    recentEvents: mappedRows.slice(0, 60),
  };
}

function getCachedRuntimeEntitlements(cacheKey, now = Date.now()) {
  const cached = entitlementRuntimeCache.get(cacheKey);
  if (!cached) return null;
  if (now - Number(cached.at || 0) > ENTITLEMENT_CACHE_MS) {
    entitlementRuntimeCache.delete(cacheKey);
    return null;
  }
  return cached.value || null;
}

function setCachedRuntimeEntitlements(cacheKey, value, now = Date.now()) {
  entitlementRuntimeCache.set(cacheKey, {
    at: now,
    value,
  });
  if (entitlementRuntimeCache.size > 1200) {
    for (const [key, row] of entitlementRuntimeCache.entries()) {
      if (now - Number(row?.at || 0) > ENTITLEMENT_CACHE_MS * 4) {
        entitlementRuntimeCache.delete(key);
      }
    }
  }
}

function shouldRunBillingAutomationNow(licenseIdRaw, now = Date.now()) {
  const licenseId = normalizedLicenseId(licenseIdRaw || '');
  if (!licenseId) return false;
  const previous = Number(billingAutomationRunCache.get(licenseId) || 0);
  if (now - previous < BILLING_AUTOMATION_COOLDOWN_MS) return false;
  billingAutomationRunCache.set(licenseId, now);
  if (billingAutomationRunCache.size > 1500) {
    for (const [key, ts] of billingAutomationRunCache.entries()) {
      if (now - Number(ts || 0) > BILLING_AUTOMATION_COOLDOWN_MS * 6) {
        billingAutomationRunCache.delete(key);
      }
    }
  }
  return true;
}

async function enforceRuntimeLicenseEntitlements({
  role = 'PARTICIPANT',
  licenseId = '',
  orgId = '',
  siteId = '',
  workshop = null,
  automate = true,
  bypassAdmin = true,
} = {}) {
  const normalizedRoleValue = String(role || 'PARTICIPANT').trim().toUpperCase();
  if (normalizedRoleValue === 'SUPER_ADMIN') {
    return { ok: true, bypass: true };
  }
  if (bypassAdmin && normalizedRoleValue === 'ADMIN') {
    return { ok: true, bypass: true };
  }

  const normalizedLicense = normalizedLicenseId(licenseId || '');
  if (!normalizedLicense) return { ok: true };
  const normalizedOrg = normalizedOrgId(orgId || '', normalizedLicense);
  const normalizedSite = normalizedSiteId(siteId || '');
  const now = Date.now();
  const cacheKey = `${normalizedLicense}:${normalizedRoleValue}:${normalizedSite || '-'}`;
  const cached = getCachedRuntimeEntitlements(cacheKey, now);
  if (cached) return cached;

  const resolvedWorkshop =
    workshop ||
    (await getWorkshopByLicenseCached(normalizedLicense).catch(() => null)) ||
    {};
  const licenseState = evaluateWorkshopLicenseState(resolvedWorkshop);
  if (!licenseState.ok) {
    const denied = {
      ok: false,
      error: licenseState.error || 'license_forbidden',
      statusCode: Number(licenseState.statusCode || 403) || 403,
      source: 'workshop_state',
    };
    setCachedRuntimeEntitlements(cacheKey, denied, now);
    return denied;
  }

  const license = await ensureLicenseRecord({
    licenseId: normalizedLicense,
    orgId: normalizedOrg,
    seatCap: Number(resolvedWorkshop?.expectedUsers || DEFAULT_EXPECTED_USERS),
    activeUserCap: Number(
      resolvedWorkshop?.activeUserCap ||
        resolvedWorkshop?.expectedUsers ||
        DEFAULT_EXPECTED_USERS
    ),
    tier: resolvedWorkshop?.tier || 'STARTER',
  });
  const sites = sanitizeSiteIds(
    resolvedWorkshop?.siteIds,
    normalizedSite ? [normalizedSite] : []
  );
  const usage = await getLicenseUsageSnapshot({
    licenseId: normalizedLicense,
    orgId: normalizedOrg,
    siteIds: sites,
  }).catch(() => ({
    activeUsers: 0,
    assignedSeats: 0,
    activeRooms: 0,
    aiUsageCostCents30d: 0,
  }));
  const summary = await buildBillingTransparencySummary({
    orgId: normalizedOrg,
    licenseId: normalizedLicense,
    workshop: resolvedWorkshop,
    license,
    usage,
    siteIds: sites,
    actor: { uid: 'entitlements', role: 'SYSTEM', orgId: normalizedOrg, licenseId: normalizedLicense },
    automate: !!automate && shouldRunBillingAutomationNow(normalizedLicense, now),
  }).catch(() => null);

  const overage = summary?.overage || {};
  if (overage.requiresAction) {
    const denied = {
      ok: false,
      error: 'license_usage_hard_cap_reached',
      statusCode: 402,
      usageCap: Number(summary?.entitlements?.usageCap || 0),
      meteredUnits: Number(summary?.usage?.meteredUnits || 0),
      overageUnits: Number(overage.units || 0),
      source: 'billing_hard_cap',
    };
    setCachedRuntimeEntitlements(cacheKey, denied, now);
    return denied;
  }

  const allowed = {
    ok: true,
    source: 'license_entitlements',
    license,
    usage,
    summary,
  };
  setCachedRuntimeEntitlements(cacheKey, allowed, now);
  return allowed;
}

async function listReliabilityEvents(limit = 160) {
  const events = await listStatusEvents(RELIABILITY_SCOPE_ID, limit).catch(() => []);
  return events.map(mapStatusEventRow);
}

function buildReliabilityProgramSnapshot(events = []) {
  const rows = (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const backupEvents = rows.filter(
    (row) => String(row.payload?.eventType || '').toUpperCase() === 'BACKUP_RUN'
  );
  const drillEvents = rows.filter(
    (row) => String(row.payload?.eventType || '').toUpperCase() === 'RESTORE_DRILL'
  );
  const latestBackup = backupEvents[0] || null;
  const latestDrill = drillEvents[0] || null;
  const targetRto = RELIABILITY_RTO_TARGET_MINUTES;
  const targetRpo = RELIABILITY_RPO_TARGET_MINUTES;
  const observedRto = Number(latestDrill?.payload?.observedRtoMinutes || 0) || null;
  const observedRpo = Number(latestDrill?.payload?.observedRpoMinutes || 0) || null;
  const drillPassed =
    observedRto !== null &&
    observedRpo !== null &&
    observedRto <= targetRto &&
    observedRpo <= targetRpo;
  const nextDrillDueAt =
    Number(latestDrill?.createdAt || latestDrill?.updatedAt || 0) +
      RELIABILITY_DRILL_INTERVAL_DAYS * 24 * 60 * 60 * 1000 || 0;

  return {
    targets: {
      rtoMinutes: targetRto,
      rpoMinutes: targetRpo,
      drillIntervalDays: RELIABILITY_DRILL_INTERVAL_DAYS,
    },
    runbooks: reliabilityRunbookCatalog(),
    latestBackup,
    latestRestoreDrill: latestDrill,
    drillPassed,
    observed: {
      rtoMinutes: observedRto,
      rpoMinutes: observedRpo,
    },
    nextDrillDueAt: Number.isFinite(nextDrillDueAt) && nextDrillDueAt > 0 ? nextDrillDueAt : 0,
    recentEvents: rows.slice(0, 80),
  };
}

async function buildOperationalHealthAlerts({ maxAlerts = 30 } = {}) {
  const now = Date.now();
  const alerts = [];
  const totalRequests = Number(runtimeMetrics.requestsTotal || 0);
  const errors5xx = Number(runtimeMetrics.errors5xx || 0);
  const errorRate = totalRequests > 0 ? errors5xx / totalRequests : 0;
  if (totalRequests >= 40 && errorRate >= 0.03) {
    alerts.push({
      id: `health-5xx-${now}`,
      severity: errorRate >= 0.08 ? 'CRITICAL' : 'HIGH',
      category: 'platform',
      message: `5xx error rate is ${(errorRate * 100).toFixed(1)}% (${errors5xx}/${totalRequests}).`,
      action: 'Check recent deploys and logs before customer impact grows.',
      createdAt: now,
    });
  }

  const [pendingApprovals, openTickets, activeTickets, statusEvents, reliabilityEvents] =
    await Promise.all([
      listApprovalsByStatus('PENDING', 250).catch(() => ({ items: [] })),
      listSupportTicketsByStatus('OPEN', 250).catch(() => ({ items: [] })),
      listSupportTicketsByStatus('IN_PROGRESS', 250).catch(() => ({ items: [] })),
      listStatusEvents('GLOBAL', 160).catch(() => []),
      listReliabilityEvents(120).catch(() => []),
    ]);

  const pendingCount = (pendingApprovals.items || []).length;
  if (pendingCount > 0) {
    alerts.push({
      id: `health-approvals-${now}`,
      severity: pendingCount >= 15 ? 'HIGH' : 'WARN',
      category: 'governance',
      message: `${pendingCount} sensitive approval request(s) are pending.`,
      action: 'Review approval queue to unblock org admins.',
      createdAt: now,
    });
  }

  const supportRows = [...(openTickets.items || []), ...(activeTickets.items || [])].map(
    mapSupportTicketRow
  );
  const overdue = supportRows.filter(
    (ticket) => ticket.slaBreached && ticket.ticketStatus !== 'RESOLVED'
  );
  if (overdue.length > 0) {
    alerts.push({
      id: `health-sla-${now}`,
      severity: overdue.some((ticket) => ticket.priority === 'P1') ? 'CRITICAL' : 'HIGH',
      category: 'support',
      message: `${overdue.length} support ticket(s) are beyond SLA.`,
      action: 'Trigger overdue auto-escalation and assign ownership now.',
      createdAt: now,
    });
  }

  const incidentRows = statusEvents.map(mapStatusEventRow);
  const unresolvedIncidents = incidentRows.filter((event) => {
    const incidentState = normalizeIncidentState(
      event.payload?.incidentState || event.payload?.state || event.payload?.status
    );
    return incidentState === 'OPEN' || incidentState === 'MONITORING';
  });
  if (unresolvedIncidents.length > 0) {
    alerts.push({
      id: `health-incidents-${now}`,
      severity: unresolvedIncidents.some((event) =>
        ['CRITICAL', 'HIGH'].includes(
          String(event.payload?.severity || '').trim().toUpperCase()
        )
      )
        ? 'CRITICAL'
        : 'HIGH',
      category: 'incident',
      message: `${unresolvedIncidents.length} incident(s) currently unresolved.`,
      action: 'Update status page and assign responders until resolved.',
      createdAt: now,
    });
  }

  const reliability = buildReliabilityProgramSnapshot(reliabilityEvents);
  if (!reliability.latestBackup) {
    alerts.push({
      id: `health-backup-none-${now}`,
      severity: 'HIGH',
      category: 'reliability',
      message: 'No backup run has been logged.',
      action: 'Run an automated backup immediately and log evidence.',
      createdAt: now,
    });
  } else {
    const backupAgeMs = now - Number(reliability.latestBackup.updatedAt || reliability.latestBackup.createdAt || 0);
    if (backupAgeMs > 36 * 60 * 60 * 1000) {
      alerts.push({
        id: `health-backup-stale-${now}`,
        severity: 'WARN',
        category: 'reliability',
        message: `Latest backup is ${Math.floor(backupAgeMs / (60 * 60 * 1000))}h old.`,
        action: 'Run a fresh backup and validate artifact integrity.',
        createdAt: now,
      });
    }
  }
  if (!reliability.latestRestoreDrill || Number(reliability.nextDrillDueAt || 0) < now) {
    alerts.push({
      id: `health-drill-due-${now}`,
      severity: 'WARN',
      category: 'reliability',
      message: 'Restore drill is overdue.',
      action: 'Execute a restore drill and capture observed RTO/RPO.',
      createdAt: now,
    });
  }

  return alerts
    .sort((a, b) => {
      const rank = { CRITICAL: 4, HIGH: 3, WARN: 2, INFO: 1 };
      return (rank[b.severity] || 0) - (rank[a.severity] || 0);
    })
    .slice(0, Math.max(1, Number(maxAlerts || 30)));
}

function stageProgressRatio(stageRaw = '') {
  const stage = String(stageRaw || '').trim().toUpperCase();
  const idx = ROOM_ORDER.indexOf(stage);
  if (idx < 0) return 0;
  return Math.min(1, (idx + 1) / Math.max(1, ROOM_ORDER.length));
}

function containsLikelyPii(textRaw = '') {
  const text = String(textRaw || '');
  if (!text) return false;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return true;
  if (/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text)) return true;
  return false;
}

const SCHOOL_SAFETY_PATTERNS_STANDARD = Object.freeze([
  { code: 'hate_or_harassment', regex: /\b(?:racial slur|hate speech|kill (?:them|him|her))\b/i },
  { code: 'self_harm', regex: /\b(?:self-harm|suicide plan|cut myself)\b/i },
  { code: 'explicit_violence', regex: /\b(?:shoot up|bomb making|how to stab)\b/i },
]);
const SCHOOL_SAFETY_PATTERNS_STRICT = Object.freeze(
  SCHOOL_SAFETY_PATTERNS_STANDARD.concat([
    { code: 'explicit_sexual', regex: /\b(?:porn|explicit sex|sexual act)\b/i },
    { code: 'substance_abuse', regex: /\b(?:how to get high|drug dealer|sell drugs)\b/i },
    { code: 'profanity', regex: /\b(?:f\*?ck|s\*?it|b\*?tch)\b/i },
  ])
);
const SCHOOL_SAFETY_AGE_SAFE_PATTERNS = Object.freeze([
  { code: 'age_inappropriate_content', regex: /\b(?:graphic sex|graphic violence|adult-only)\b/i },
]);

function evaluateSchoolSafetyText(textRaw = '', policy = {}) {
  const text = String(textRaw || '');
  const normalized = text.toLowerCase();
  const ageSafeMode = String(policy?.ageSafeMode || AI_POLICY_DEFAULT.ageSafeMode).toUpperCase();
  const moderationLevel = String(
    policy?.moderationLevel || AI_POLICY_DEFAULT.moderationLevel
  ).toUpperCase();
  const blockedTerms = normalizeBlockedTerms(policy?.blockedTerms || []);

  const flags = [];
  if (ageSafeMode !== 'OFF' && ageSafeMode !== 'ADULT') {
    for (const pattern of SCHOOL_SAFETY_AGE_SAFE_PATTERNS) {
      if (pattern.regex.test(text)) flags.push(pattern.code);
    }
  }

  if (moderationLevel !== 'OFF') {
    const patterns =
      moderationLevel === 'STRICT'
        ? SCHOOL_SAFETY_PATTERNS_STRICT
        : SCHOOL_SAFETY_PATTERNS_STANDARD;
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) flags.push(pattern.code);
    }
  }

  if (blockedTerms.length) {
    for (const term of blockedTerms) {
      if (term && normalized.includes(term)) {
        flags.push(`blocked_term:${term}`);
      }
    }
  }

  if (ageSafeMode !== 'ADULT' && policy?.piiRedaction !== false && containsLikelyPii(text)) {
    flags.push('pii_detected');
  }

  const uniqueFlags = Array.from(new Set(flags));
  return {
    blocked: uniqueFlags.length > 0,
    flags: uniqueFlags,
    ageSafeMode,
    moderationLevel,
  };
}

function schoolSafetyErrorPayload(result = {}) {
  return {
    error: 'content_blocked_by_policy',
    legacyError: 'content_blocked_by_school_policy',
    reason:
      'This content conflicts with your organization safety policy. Revise and retry with policy-safe language and no personal identifiers.',
    flags: Array.isArray(result.flags) ? result.flags : [],
    ageSafeMode: String(result.ageSafeMode || AI_POLICY_DEFAULT.ageSafeMode),
    moderationLevel: String(result.moderationLevel || AI_POLICY_DEFAULT.moderationLevel),
  };
}

function roomOutcomeMetrics(room = {}) {
  const seats = Math.max(0, Number(getSeatCount(room) || 0));
  const voteSubmitted = Math.max(0, Number(room.voteSubmittedCount || 0));
  const finalReady = Math.max(0, Number(room.finalReadyCount || 0));
  const stageProgress = stageProgressRatio(room.stage || '');
  const seatCoverageDenominator = seats > 0 ? seats : Math.max(voteSubmitted, finalReady, 1);
  const voteCoverage = Math.min(1, voteSubmitted / seatCoverageDenominator);
  const finalCoverage = Math.min(1, finalReady / seatCoverageDenominator);
  const draftSignal = Math.min(1, Math.max(0, Number(room.draftVersion || 0)) / 3);
  const finalText = String(room.finalAbstract || '').trim();
  const finalWords = finalText
    ? finalText
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean).length
    : 0;
  const completed = String(room.stage || '').toUpperCase() === 'CLOSED' || finalText.length >= 120;
  const policyAdherent = completed && finalText.length >= 120 && !containsLikelyPii(finalText);
  const qualityScore = Math.round(
    (voteCoverage * 0.35 + finalCoverage * 0.3 + stageProgress * 0.2 + draftSignal * 0.15) * 100
  );
  const exportQualityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (finalText.length >= 120 ? 35 : finalText.length / 4) +
          (finalText.length >= 280 ? 15 : 0) +
          (finalWords >= 80 ? 15 : Math.min(15, Math.round(finalWords / 8))) +
          (/\n/.test(finalText) ? 10 : 0) +
          (/[.!?]/.test(finalText) ? 10 : 0) +
          (/(call to action|next step|we will|commit|ownership)/i.test(finalText)
            ? 15
            : 0)
      )
    )
  );
  const sessionScore = Math.round(
    qualityScore * 0.35 +
      exportQualityScore * 0.2 +
      (completed ? 25 : 0) +
      (policyAdherent ? 20 : 0)
  );
  return {
    roomId: String(room.roomId || ''),
    siteId: normalizedSiteId(room.siteId || parseRoomId(room.roomId).siteId || ''),
    stage: String(room.stage || '').toUpperCase() || DEFAULT_STAGE,
    seats,
    voteCoverage,
    finalCoverage,
    stageProgress,
    draftVersion: Number(room.draftVersion || 0),
    completed,
    policyAdherent,
    qualityScore,
    exportQualityScore,
    sessionScore,
    finalAbstractLength: finalText.length,
    updatedAt: Number(room.updatedAt || 0) || null,
  };
}

async function listRecentRoomsForSites(siteIds = [], cutoffMs = 0) {
  const rows = [];
  for (const siteId of sanitizeSiteIds(siteIds, [])) {
    let lastKey = undefined;
    let remaining = 260;
    while (remaining > 0) {
      // eslint-disable-next-line no-await-in-loop
      const page = await queryByPartitionKey({
        tableName: TABLES.rooms,
        indexName: 'bySiteUpdatedAt',
        partitionKey: 'siteId',
        partitionValue: siteId,
        limit: Math.min(80, remaining),
        scanForward: false,
        exclusiveStartKey: lastKey,
      }).catch((err) => {
        if (err?.name === 'ResourceNotFoundException') {
          return { items: [], lastKey: null };
        }
        throw err;
      });
      const items = page.items || [];
      if (!items.length) break;

      let reachedCutoff = false;
      for (const item of items) {
        const updatedAt = Number(item.updatedAt || 0);
        if (cutoffMs > 0 && updatedAt > 0 && updatedAt < cutoffMs) {
          reachedCutoff = true;
          break;
        }
        rows.push(normalizeRoomShape(item));
      }

      remaining -= items.length;
      if (reachedCutoff || !page.lastKey) break;
      lastKey = page.lastKey || undefined;
    }
  }
  const deduped = new Map();
  for (const room of rows) {
    const key = String(room.roomId || '');
    if (!key) continue;
    const existing = deduped.get(key);
    if (!existing || Number(room.updatedAt || 0) > Number(existing.updatedAt || 0)) {
      deduped.set(key, room);
    }
  }
  return Array.from(deduped.values());
}

function summarizeOutcomeRows(rows = [], usage = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const totalRooms = list.length;
  const completedRooms = list.filter((row) => row.completed).length;
  const policyAdherentRooms = list.filter((row) => row.policyAdherent).length;
  const avgQuality = totalRooms
    ? Math.round(
        list.reduce((sum, row) => sum + Number(row.qualityScore || 0), 0) / totalRooms
      )
    : 0;
  const avgExportQuality = totalRooms
    ? Math.round(
        list.reduce((sum, row) => sum + Number(row.exportQualityScore || 0), 0) /
          totalRooms
      )
    : 0;
  const avgSessionScore = totalRooms
    ? Math.round(
        list.reduce((sum, row) => sum + Number(row.sessionScore || 0), 0) / totalRooms
      )
    : 0;
  const completionRate = totalRooms ? completedRooms / totalRooms : 0;
  const policyAdherenceRate = completedRooms ? policyAdherentRooms / completedRooms : 0;
  const aiCostCents = Math.max(0, Number(usage.aiUsageCostCents30d || 0));
  const costPerCompletedRoomCents = completedRooms
    ? Math.round(aiCostCents / completedRooms)
    : 0;
  const valueIndex = Math.round(
    (completionRate * 0.35 +
      (avgQuality / 100) * 0.25 +
      policyAdherenceRate * 0.2 +
      (avgExportQuality / 100) * 0.2) *
      100
  );
  const aiCostUsd = Number((aiCostCents / 100).toFixed(2));
  const costPerCompletedRoomUsd = Number((costPerCompletedRoomCents / 100).toFixed(2));
  const roomsPerDollar = aiCostUsd > 0 ? Number((completedRooms / aiCostUsd).toFixed(2)) : completedRooms;
  return {
    totalRooms,
    completedRooms,
    completionRate: Number((completionRate * 100).toFixed(1)),
    participationQualityScore: avgQuality,
    exportQualityScore: avgExportQuality,
    policyAdherenceRate: Number((policyAdherenceRate * 100).toFixed(1)),
    sessionScore: avgSessionScore,
    aiCostCents30d: aiCostCents,
    aiCostUsd30d: aiCostUsd,
    costPerCompletedRoomCents,
    costPerCompletedRoomUsd,
    roomsPerDollar,
    valueIndex,
  };
}

function buildOutcomeTrendline(rows = [], windowDays = OUTCOMES_WINDOW_DAYS) {
  const dayCount = Math.max(7, Math.min(90, Number(windowDays || OUTCOMES_WINDOW_DAYS)));
  const buckets = [];
  const byDate = new Map();
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const ts = Date.now() - i * 24 * 60 * 60 * 1000;
    const date = new Date(ts).toISOString().slice(0, 10);
    const bucket = {
      date,
      rooms: 0,
      completed: 0,
      policyAdherent: 0,
      qualitySum: 0,
      exportQualitySum: 0,
      sessionScoreSum: 0,
    };
    buckets.push(bucket);
    byDate.set(date, bucket);
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = Number(row?.updatedAt || 0);
    if (!ts) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    const bucket = byDate.get(date);
    if (!bucket) continue;
    bucket.rooms += 1;
    if (row.completed) bucket.completed += 1;
    if (row.policyAdherent) bucket.policyAdherent += 1;
    bucket.qualitySum += Number(row.qualityScore || 0);
    bucket.exportQualitySum += Number(row.exportQualityScore || 0);
    bucket.sessionScoreSum += Number(row.sessionScore || 0);
  }

  return buckets.map((bucket) => {
    const rooms = Math.max(0, Number(bucket.rooms || 0));
    const completed = Math.max(0, Number(bucket.completed || 0));
    const completionRate = rooms ? (completed / rooms) * 100 : 0;
    const policyRate = completed
      ? (Number(bucket.policyAdherent || 0) / completed) * 100
      : 0;
    return {
      date: bucket.date,
      rooms,
      completionRate: Number(completionRate.toFixed(1)),
      participationQualityScore: rooms
        ? Number((bucket.qualitySum / rooms).toFixed(1))
        : 0,
      exportQualityScore: rooms
        ? Number((bucket.exportQualitySum / rooms).toFixed(1))
        : 0,
      policyAdherenceRate: Number(policyRate.toFixed(1)),
      sessionScore: rooms
        ? Number((bucket.sessionScoreSum / rooms).toFixed(1))
        : 0,
    };
  });
}

async function buildOutcomesAnalytics({
  orgId = '',
  licenseId = '',
  siteIds = [],
  usage = null,
  windowDays = OUTCOMES_WINDOW_DAYS,
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId || '');
  const normalizedOrg = normalizedOrgId(orgId || '', normalizedLicense);
  if (!normalizedLicense || !normalizedOrg) {
    return {
      generatedAt: nowIso(),
      windowDays: Number(windowDays || OUTCOMES_WINDOW_DAYS),
      org: summarizeOutcomeRows([], usage || {}),
      bySite: [],
      methodology: 'heuristic_v1',
    };
  }
  const resolvedSiteIds = sanitizeSiteIds(siteIds, []);
  const cutoffMs = Date.now() - Math.max(1, Number(windowDays || OUTCOMES_WINDOW_DAYS)) * 24 * 60 * 60 * 1000;
  const rooms = await listRecentRoomsForSites(resolvedSiteIds, cutoffMs).catch(() => []);
  const outcomeRows = rooms
    .filter((room) => normalizedLicenseId(room.licenseId || '') === normalizedLicense)
    .filter(
      (room) => normalizedOrgId(room.orgId || '', room.licenseId || '') === normalizedOrg
    )
    .map(roomOutcomeMetrics);
  const usageSnapshot =
    usage ||
    (await getLicenseUsageSnapshot({
      licenseId: normalizedLicense,
      orgId: normalizedOrg,
      siteIds: resolvedSiteIds,
    }).catch(() => ({
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    })));
  const bySite = [];
  const bySiteMap = new Map();
  for (const row of outcomeRows) {
    const key = normalizedSiteId(row.siteId || '');
    if (!key) continue;
    const bucket = bySiteMap.get(key) || [];
    bucket.push(row);
    bySiteMap.set(key, bucket);
  }
  for (const [siteId, siteRows] of bySiteMap.entries()) {
    bySite.push({
      siteId,
      metrics: summarizeOutcomeRows(siteRows, usageSnapshot),
    });
  }
  bySite.sort((a, b) => a.siteId.localeCompare(b.siteId));
  return {
    generatedAt: nowIso(),
    windowDays: Math.max(1, Number(windowDays || OUTCOMES_WINDOW_DAYS)),
    org: summarizeOutcomeRows(outcomeRows, usageSnapshot),
    bySite,
    trendline: buildOutcomeTrendline(outcomeRows, windowDays),
    sampleRooms: outcomeRows.slice(0, 60),
    methodology: 'heuristic_v1',
    notes: [
      'Participation quality blends vote coverage, final readiness coverage, stage progression, and draft revision depth.',
      'Export quality scores structure, clarity, and readiness of stakeholder-facing output.',
      'Policy adherence is estimated from completed outputs and basic PII pattern detection.',
      'Cost/value uses AI usage cost over the same window.',
    ],
  };
}

function buildStatusSnapshot(events = []) {
  const mapped = (Array.isArray(events) ? events : []).map(mapStatusEventRow);
  const unresolved = mapped.filter((event) => {
    const payload = event.payload || {};
    const incidentState = normalizeIncidentState(
      payload.incidentState || payload.state || payload.status
    );
    return incidentState === 'OPEN' || incidentState === 'MONITORING';
  });
  const severe = unresolved.some((event) =>
    ['SEV1', 'CRITICAL', 'HIGH'].includes(
      String(event.payload?.severity || '').trim().toUpperCase()
    )
  );
  return {
    status: severe ? 'DEGRADED' : unresolved.length ? 'PARTIAL_OUTAGE' : 'OPERATIONAL',
    unresolvedIncidents: unresolved.length,
    incidents: unresolved.slice(0, 20),
    recentEvents: mapped.slice(0, 120),
    mapped,
  };
}

function buildUptimeHistoryFromEvents(events = [], days = 30) {
  const dayCount = Math.max(7, Math.min(90, Number(days || 30)));
  const rows = [];
  const byDay = new Map();
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const ts = Date.now() - i * 24 * 60 * 60 * 1000;
    const key = new Date(ts).toISOString().slice(0, 10);
    const row = { date: key, status: 'OPERATIONAL', incidents: 0 };
    rows.push(row);
    byDay.set(key, row);
  }
  for (const event of events) {
    const ts = Number(event.updatedAt || event.createdAt || 0);
    if (!ts) continue;
    const key = new Date(ts).toISOString().slice(0, 10);
    const target = byDay.get(key);
    if (!target) continue;
    target.incidents += 1;
    const payload = event.payload || {};
    const incidentState = normalizeIncidentState(
      payload.incidentState || payload.state || payload.status
    );
    if (incidentState !== 'OPEN' && incidentState !== 'MONITORING') continue;
    const severity = String(payload.severity || '').trim().toUpperCase();
    if (['SEV1', 'CRITICAL', 'HIGH'].includes(severity)) {
      target.status = 'DEGRADED';
    } else if (target.status !== 'DEGRADED') {
      target.status = 'PARTIAL_OUTAGE';
    }
  }
  const operationalDays = rows.filter((row) => row.status === 'OPERATIONAL').length;
  const availabilityPercent = Number(((operationalDays / rows.length) * 100).toFixed(2));
  return { days: rows, availabilityPercent };
}

function trustCenterSecurityDocs() {
  const docs = [
    { id: 'status', label: 'Public Status', url: '/status' },
    { id: 'privacy', label: 'Privacy Policy', url: TRUST_CENTER_PRIVACY_URL },
    { id: 'terms', label: 'Terms of Service', url: TRUST_CENTER_TERMS_URL },
    { id: 'dpa', label: 'Data Processing Addendum', url: TRUST_CENTER_DPA_URL },
    { id: 'whitepaper', label: 'Security Whitepaper', url: TRUST_CENTER_SECURITY_WHITEPAPER_URL },
    { id: 'soc2', label: 'SOC 2 Report', url: TRUST_CENTER_SOC2_URL },
    { id: 'pentest', label: 'Penetration Test Summary', url: TRUST_CENTER_PENTEST_SUMMARY_URL },
    {
      id: 'subprocessors',
      label: 'Subprocessors List',
      url: TRUST_CENTER_SUBPROCESSOR_LIST_URL,
    },
  ]
    .filter((doc) => String(doc.url || '').trim())
    .map((doc) => ({
      id: doc.id,
      label: doc.label,
      url: doc.url,
    }));
  return docs;
}

function buildTrustCenterSnapshot(statusSnapshot = {}) {
  const mapped = Array.isArray(statusSnapshot.mapped) ? statusSnapshot.mapped : [];
  const uptime = buildUptimeHistoryFromEvents(mapped, 30);
  const postmortems = mapped
    .filter((event) => {
      const payload = event.payload || {};
      return (
        !!payload.postmortemUrl ||
        normalizeIncidentState(payload.incidentState || payload.state || payload.status) ===
          'RESOLVED'
      );
    })
    .slice(0, 30)
    .map((event) => ({
      scopeId: event.scopeId,
      statusKey: event.statusKey,
      message: String(event.payload?.message || event.statusKey || ''),
      severity: String(event.payload?.severity || 'INFO'),
      resolvedAt: Number(event.updatedAt || event.createdAt || 0) || null,
      postmortemUrl: String(event.payload?.postmortemUrl || ''),
    }));
  return {
    brand: TRUST_CENTER_BRAND_NAME,
    generatedAt: nowIso(),
    status: statusSnapshot.status || 'OPERATIONAL',
    unresolvedIncidents: Number(statusSnapshot.unresolvedIncidents || 0),
    incidents: Array.isArray(statusSnapshot.incidents) ? statusSnapshot.incidents : [],
    recentEvents: Array.isArray(statusSnapshot.recentEvents)
      ? statusSnapshot.recentEvents
      : [],
    securityDocuments: trustCenterSecurityDocs(),
    subprocessors: TRUST_CENTER_DEFAULT_SUBPROCESSORS,
    uptime30d: {
      availabilityPercent: uptime.availabilityPercent,
      daily: uptime.days,
    },
    incidentPostmortems: postmortems,
    supportEscalationEmail: SUPPORT_ESCALATION_EMAIL,
    statusPageUrl: STATUS_PAGE_URL,
  };
}

function normalizeTicketStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (status === 'ESCALATED') return 'ESCALATED';
  if (status === 'RESOLVED') return 'RESOLVED';
  if (status === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'OPEN';
}

function normalizeTicketPriority(value) {
  const severity = String(value || '').trim().toUpperCase();
  if (severity === 'P1') return 'P1';
  if (severity === 'P2') return 'P2';
  if (severity === 'P3') return 'P3';
  return 'P4';
}

function supportSlaTargets(priority = 'P3') {
  const normalized = normalizeTicketPriority(priority);
  return {
    responseMinutes:
      Number(SUPPORT_SLA_RESPONSE_MINUTES_BY_PRIORITY[normalized]) ||
      Number(SUPPORT_SLA_RESPONSE_MINUTES_BY_PRIORITY.P3),
    resolutionMinutes:
      Number(SUPPORT_SLA_RESOLUTION_MINUTES_BY_PRIORITY[normalized]) ||
      Number(SUPPORT_SLA_RESOLUTION_MINUTES_BY_PRIORITY.P3),
  };
}

function resolveSupportTicketDeadlines(ticket = {}, now = Date.now()) {
  const createdAt = Number(ticket.createdAt || now) || now;
  const priority = normalizeTicketPriority(ticket.priority);
  const sla = supportSlaTargets(priority);
  const responseDueAt =
    Number(ticket.responseDueAt || ticket.firstResponseDueAt || 0) ||
    createdAt + sla.responseMinutes * 60 * 1000;
  const resolutionDueAt =
    Number(ticket.resolutionDueAt || 0) ||
    createdAt + sla.resolutionMinutes * 60 * 1000;
  const escalateAfterAt =
    Number(ticket.escalateAfterAt || 0) ||
    responseDueAt +
      Math.max(0, Number(SUPPORT_SLA_ESCALATE_AFTER_RESPONSE_MISSES || 1)) *
        sla.responseMinutes *
        60 *
        1000;
  return { responseDueAt, resolutionDueAt, escalateAfterAt, sla };
}

function computeSupportSlaState(ticket = {}, now = Date.now()) {
  const status = normalizeTicketStatus(ticket.ticketStatus);
  const firstResponseAt = Number(ticket.firstResponseAt || 0) || 0;
  const resolvedAt = Number(ticket.resolvedAt || 0) || 0;
  const deadlines = resolveSupportTicketDeadlines(ticket, now);
  const responseBreached =
    firstResponseAt <= 0 && now > Number(deadlines.responseDueAt || 0);
  const resolutionBreached =
    status !== 'RESOLVED' && now > Number(deadlines.resolutionDueAt || 0);

  if (status === 'RESOLVED') {
    return {
      slaState: 'RESOLVED',
      slaBreached:
        Number(deadlines.responseDueAt || 0) > 0 &&
        firstResponseAt > Number(deadlines.responseDueAt || 0)
          ? true
          : Number(deadlines.resolutionDueAt || 0) > 0 &&
            resolvedAt > Number(deadlines.resolutionDueAt || 0),
      responseBreached:
        Number(deadlines.responseDueAt || 0) > 0 &&
        firstResponseAt > Number(deadlines.responseDueAt || 0),
      resolutionBreached:
        Number(deadlines.resolutionDueAt || 0) > 0 &&
        resolvedAt > Number(deadlines.resolutionDueAt || 0),
      deadlines,
    };
  }

  if (responseBreached || resolutionBreached) {
    return {
      slaState: 'AT_RISK',
      slaBreached: true,
      responseBreached,
      resolutionBreached,
      deadlines,
    };
  }

  return {
    slaState: 'ON_TRACK',
    slaBreached: false,
    responseBreached: false,
    resolutionBreached: false,
    deadlines,
  };
}

function reliabilityRunbookCatalog() {
  return [
    {
      id: 'backup-and-restore',
      title: 'Backup and Restore',
      path: 'scripts/backupDynamo.mjs',
      owner: 'Platform Engineering',
    },
    {
      id: 'restore-drill',
      title: 'Restore Drill',
      path: 'scripts/restoreDynamo.mjs',
      owner: 'Site Reliability',
    },
    {
      id: 'incident-response',
      title: 'Incident Response',
      path: 'docs/runbooks/incident-response.md',
      owner: 'Operations',
    },
    {
      id: 'billing-overage',
      title: 'Billing Overage Response',
      path: 'docs/runbooks/billing-overage.md',
      owner: 'Revenue Operations',
    },
  ];
}

function normalizeReliabilityEventType(value = '') {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (normalized === 'RESTORE_DRILL') return 'RESTORE_DRILL';
  if (normalized === 'INCIDENT_REVIEW') return 'INCIDENT_REVIEW';
  return 'BACKUP_RUN';
}

function normalizeReliabilityEventStatus(value = '') {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (normalized === 'FAILED') return 'FAILED';
  if (normalized === 'PARTIAL') return 'PARTIAL';
  return 'SUCCESS';
}

function reliabilityAutoBackupStatusKey(timestampMs = Date.now()) {
  const bucket = Math.floor(Number(timestampMs || Date.now()) / RELIABILITY_AUTO_BACKUP_INTERVAL_MS);
  return `BACKUP_RUN#AUTO#${bucket}`;
}

async function createDynamoBackupArtifacts({
  tables = [],
  label = 'auto',
} = {}) {
  const backups = [];
  const errors = [];
  for (const tableNameRaw of Array.isArray(tables) ? tables : []) {
    const tableName = String(tableNameRaw || '').trim();
    if (!tableName) continue;
    const backupName = `${tableName}-${String(label || 'auto').replace(/[^a-zA-Z0-9-]/g, '')}-${Date.now()}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await ddb.send(
        new CreateBackupCommand({
          TableName: tableName,
          BackupName: backupName,
        })
      );
      backups.push({
        tableName,
        backupName,
        backupArn: String(out?.BackupDetails?.BackupArn || ''),
      });
    } catch (err) {
      errors.push({
        tableName,
        error: err?.name || err?.message || String(err),
      });
    }
  }
  return { backups, errors };
}

async function recordReliabilityEvent({
  eventType = 'BACKUP_RUN',
  status = 'SUCCESS',
  summary = '',
  notes = '',
  observedRtoMinutes = 0,
  observedRpoMinutes = 0,
  automated = false,
  source = 'manual',
  runbook = '',
  statusKey = '',
  metadata = {},
  actor = {},
  audit = true,
} = {}) {
  const now = Date.now();
  const normalizedType = normalizeReliabilityEventType(eventType);
  const normalizedStatus = normalizeReliabilityEventStatus(status);
  const key =
    String(statusKey || '').trim() ||
    `${normalizedType}#${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
  const payload = {
    eventType: normalizedType,
    status: normalizedStatus,
    summary: String(summary || '').trim().slice(0, 2000),
    notes: String(notes || '').trim().slice(0, 3000),
    observedRtoMinutes:
      Number.isFinite(Number(observedRtoMinutes)) && Number(observedRtoMinutes) >= 0
        ? Number(observedRtoMinutes)
        : 0,
    observedRpoMinutes:
      Number.isFinite(Number(observedRpoMinutes)) && Number(observedRpoMinutes) >= 0
        ? Number(observedRpoMinutes)
        : 0,
    automated: !!automated,
    source: String(source || '').trim() || (automated ? 'scheduler' : 'manual'),
    runbook: String(runbook || '').trim(),
    metadata: parseJsonObject(metadata, {}),
    createdBy: String(actor?.uid || '').trim() || 'reliability-bot',
    createdAt: now,
  };
  const event = await saveStatusEvent(RELIABILITY_SCOPE_ID, key, payload);
  const mapped = mapStatusEventRow(event);
  if (audit) {
    await writeAuditEvent({
      action: `SUPER_ADMIN_RELIABILITY_${normalizedType}`,
      actor: actor?.uid
        ? actor
        : { uid: 'reliability-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
      target: {
        resourceType: 'RELIABILITY_EVENT',
        resourceId: `${RELIABILITY_SCOPE_ID}:${key}`,
      },
      details: {
        eventType: normalizedType,
        status: normalizedStatus,
        automated: !!automated,
      },
    });
  }
  return mapped;
}

async function runAutomatedReliabilityBackup({
  actor = { uid: 'reliability-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
  force = false,
  source = 'scheduler',
} = {}) {
  if (!RELIABILITY_AUTO_BACKUP_ENABLED && !force) {
    return { ok: true, skipped: true, reason: 'disabled', event: null };
  }
  if (reliabilityBackupLoopInFlight && !force) {
    return { ok: true, skipped: true, reason: 'in_flight', event: null };
  }
  reliabilityBackupLoopInFlight = true;
  try {
    const now = Date.now();
    const statusKey = reliabilityAutoBackupStatusKey(now);
    const existing = await getItemByKey(TABLES.status, {
      scopeId: RELIABILITY_SCOPE_ID,
      statusKey,
    }).catch(() => null);
    if (existing && !force) {
      return { ok: true, skipped: true, reason: 'already_recorded', event: mapStatusEventRow(existing) };
    }
    const tableNames = Object.values(TABLES);
    const executionMode = RELIABILITY_BACKUP_EXECUTION_MODE === 'dynamodb' ? 'dynamodb' : 'checkpoint';
    let backupArtifacts = { backups: [], errors: [] };
    if (executionMode === 'dynamodb') {
      backupArtifacts = await createDynamoBackupArtifacts({
        tables: tableNames,
        label: source === 'scheduler' ? 'auto' : source,
      });
    }
    const failedCount = Array.isArray(backupArtifacts.errors)
      ? backupArtifacts.errors.length
      : 0;
    const successCount = Array.isArray(backupArtifacts.backups)
      ? backupArtifacts.backups.length
      : 0;
    const backupStatus =
      failedCount <= 0
        ? 'SUCCESS'
        : successCount > 0
          ? 'PARTIAL'
          : 'FAILED';
    const summary =
      executionMode === 'checkpoint'
        ? 'Automated DynamoDB backup checkpoint completed.'
        : `Automated backup execution finished with ${successCount} success and ${failedCount} failure(s).`;
    const event = await recordReliabilityEvent({
      eventType: 'BACKUP_RUN',
      status: backupStatus,
      summary,
      automated: true,
      source,
      runbook: 'scripts/backupDynamo.mjs',
      statusKey,
      metadata: {
        intervalMs: RELIABILITY_AUTO_BACKUP_INTERVAL_MS,
        executionMode,
        tableCount: tableNames.length,
        tables: tableNames,
        backups: backupArtifacts.backups,
        errors: backupArtifacts.errors,
      },
      actor,
      audit: !!force,
    });
    return { ok: true, skipped: false, reason: '', event };
  } catch (err) {
    console.error('[reliability backup] error:', err);
    return { ok: false, skipped: false, reason: 'backup_failed', event: null };
  } finally {
    reliabilityBackupLoopInFlight = false;
  }
}

async function createSupportTicket({
  orgId = '',
  licenseId = '',
  subject = '',
  description = '',
  priority = 'P3',
  requesterEmail = '',
  actor = {},
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '', licenseId || actor.licenseId || '');
  if (!normalizedOrg) throw new Error('orgId_required');
  const now = Date.now();
  const ticketId = `${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
  const item = {
    orgId: normalizedOrg,
    ticketId,
    licenseId: normalizedLicenseId(licenseId || actor.licenseId || ''),
    subject: String(subject || '').trim().slice(0, 240),
    description: String(description || '').trim().slice(0, 8000),
    priority: normalizeTicketPriority(priority),
    ticketStatus: 'OPEN',
    requesterEmail: normalizeSuperAdminEmail(requesterEmail || actor.email || ''),
    owner: '',
    escalationTarget: SUPPORT_ESCALATION_EMAIL,
    escalationLevel: 0,
    firstResponseAt: 0,
    resolvedAt: 0,
    createdAt: now,
    updatedAt: now,
  };
  const deadlines = resolveSupportTicketDeadlines(item, now);
  const sla = computeSupportSlaState(
    {
      ...item,
      responseDueAt: deadlines.responseDueAt,
      resolutionDueAt: deadlines.resolutionDueAt,
      escalateAfterAt: deadlines.escalateAfterAt,
    },
    now
  );
  item.responseDueAt = Number(deadlines.responseDueAt || 0) || 0;
  item.resolutionDueAt = Number(deadlines.resolutionDueAt || 0) || 0;
  item.escalateAfterAt = Number(deadlines.escalateAfterAt || 0) || 0;
  item.slaState = String(sla.slaState || 'ON_TRACK');
  item.slaBreached = !!sla.slaBreached;
  item.slaResponseMinutes = Number(deadlines.sla?.responseMinutes || 0) || 0;
  item.slaResolutionMinutes = Number(deadlines.sla?.resolutionMinutes || 0) || 0;
  await putItem(TABLES.support, item);
  return item;
}

async function listSupportTicketsByOrg(orgIdRaw, limit = 200) {
  const orgId = normalizedOrgId(orgIdRaw || '');
  if (!orgId) return [];
  const out = await queryByPartitionKey({
    tableName: TABLES.support,
    indexName: undefined,
    partitionKey: 'orgId',
    partitionValue: orgId,
    limit: Math.min(500, limit),
    scanForward: false,
  });
  return Array.isArray(out.items) ? out.items : [];
}

async function listSupportTicketsByStatus(status = 'OPEN', limit = 200, cursorKey = undefined) {
  return queryByPartitionKey({
    tableName: TABLES.support,
    indexName: 'byTicketStatusUpdatedAt',
    partitionKey: 'ticketStatus',
    partitionValue: normalizeTicketStatus(status),
    limit,
    scanForward: false,
    exclusiveStartKey: cursorKey,
  });
}

async function updateSupportTicket({
  orgId,
  ticketId,
  ticketStatus,
  owner = '',
  actor = {},
  note = '',
  autoEscalated = false,
} = {}) {
  const normalizedOrg = normalizedOrgId(orgId || '');
  const normalizedTicketId = String(ticketId || '').trim();
  if (!normalizedOrg || !normalizedTicketId) throw new Error('ticket_identity_required');
  const status = normalizeTicketStatus(ticketStatus);
  const now = Date.now();
  const current =
    (await getItemByKey(TABLES.support, {
      orgId: normalizedOrg,
      ticketId: normalizedTicketId,
    })) || {};
  const prevStatus = normalizeTicketStatus(current.ticketStatus);
  const firstResponseAtExisting = Number(current.firstResponseAt || 0) || 0;
  const shouldMarkFirstResponse =
    firstResponseAtExisting <= 0 &&
    (status === 'IN_PROGRESS' || status === 'ESCALATED' || status === 'RESOLVED');
  const firstResponseAt = shouldMarkFirstResponse ? now : firstResponseAtExisting;
  const resolvedAt =
    status === 'RESOLVED'
      ? Number(current.resolvedAt || 0) || now
      : Number(current.resolvedAt || 0) || 0;
  const escalationLevel =
    Number(current.escalationLevel || 0) +
    (status === 'ESCALATED' && prevStatus !== 'ESCALATED' ? 1 : 0);
  const deadlines = resolveSupportTicketDeadlines(current, now);
  const sla = computeSupportSlaState(
    {
      ...current,
      ticketStatus: status,
      firstResponseAt,
      resolvedAt,
      responseDueAt: deadlines.responseDueAt,
      resolutionDueAt: deadlines.resolutionDueAt,
      escalateAfterAt: deadlines.escalateAfterAt,
    },
    now
  );
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.support,
        Key: { orgId: normalizedOrg, ticketId: normalizedTicketId },
        UpdateExpression:
          [
            'SET ticketStatus = :status',
            'owner = :owner',
            'updatedAt = :now',
            'lastNote = :note',
            'updatedBy = :uid',
            'firstResponseAt = :firstResponseAt',
            'resolvedAt = :resolvedAt',
            'escalationLevel = :escalationLevel',
            'responseDueAt = :responseDueAt',
            'resolutionDueAt = :resolutionDueAt',
            'escalateAfterAt = :escalateAfterAt',
            'slaState = :slaState',
            'slaBreached = :slaBreached',
            'autoEscalated = :autoEscalated',
          ].join(', '),
        ExpressionAttributeValues: {
          ':status': status,
          ':owner': String(owner || '').trim(),
          ':now': now,
          ':note': String(note || '').trim().slice(0, 2000),
          ':uid': String(actor.uid || '').trim() || '(system)',
          ':firstResponseAt': firstResponseAt,
          ':resolvedAt': resolvedAt,
          ':escalationLevel': escalationLevel,
          ':responseDueAt': Number(deadlines.responseDueAt || 0) || 0,
          ':resolutionDueAt': Number(deadlines.resolutionDueAt || 0) || 0,
          ':escalateAfterAt': Number(deadlines.escalateAfterAt || 0) || 0,
          ':slaState': String(sla.slaState || 'ON_TRACK'),
          ':slaBreached': !!sla.slaBreached,
          ':autoEscalated': !!autoEscalated,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return Attributes || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('support_ticket_update', err);
    const key = `${normalizedOrg}::${normalizedTicketId}`;
    const currentFallback = demoFallbackState.support.get(key) || {
      orgId: normalizedOrg,
      ticketId: normalizedTicketId,
      createdAt: now,
    };
    const next = {
      ...currentFallback,
      ticketStatus: status,
      owner: String(owner || '').trim(),
      updatedAt: now,
      lastNote: String(note || '').trim().slice(0, 2000),
      updatedBy: String(actor.uid || '').trim() || '(system)',
      firstResponseAt,
      resolvedAt,
      escalationLevel,
      responseDueAt: Number(deadlines.responseDueAt || 0) || 0,
      resolutionDueAt: Number(deadlines.resolutionDueAt || 0) || 0,
      escalateAfterAt: Number(deadlines.escalateAfterAt || 0) || 0,
      slaState: String(sla.slaState || 'ON_TRACK'),
      slaBreached: !!sla.slaBreached,
      autoEscalated: !!autoEscalated,
    };
    demoFallbackState.support.set(key, next);
    return deepCloneDemo(next);
  }
}

async function autoEscalateOverdueSupportTickets({
  actor = {},
  maxPerStatus = 200,
} = {}) {
  if (!SUPPORT_AUTO_ESCALATE_ENABLED) {
    return { ok: true, escalated: [], skipped: true, reason: 'disabled' };
  }
  const now = Date.now();
  const escalated = [];
  const statuses = ['OPEN', 'IN_PROGRESS'];
  for (const status of statuses) {
    // eslint-disable-next-line no-await-in-loop
    const page = await listSupportTicketsByStatus(status, maxPerStatus).catch(() => ({
      items: [],
    }));
    for (const ticket of page.items || []) {
      const normalized = mapSupportTicketRow(ticket);
      if (normalized.ticketStatus === 'ESCALATED' || normalized.ticketStatus === 'RESOLVED') {
        continue;
      }
      const dueAt = Number(
        ticket.escalateAfterAt || ticket.responseDueAt || ticket.resolutionDueAt || 0
      );
      if (!Number.isFinite(dueAt) || dueAt <= 0 || now < dueAt) continue;
      // eslint-disable-next-line no-await-in-loop
      const updated = await updateSupportTicket({
        orgId: normalized.orgId,
        ticketId: normalized.ticketId,
        ticketStatus: 'ESCALATED',
        owner: String(ticket.owner || '').trim() || 'support-oncall',
        note: `Auto escalated at ${new Date(now).toISOString()} after SLA threshold.`,
        actor: actor?.uid ? actor : { uid: 'support-bot', role: 'SYSTEM' },
        autoEscalated: true,
      }).catch(() => null);
      if (updated) {
        escalated.push(mapSupportTicketRow(updated));
      }
    }
  }
  return { ok: true, escalated, skipped: false, reason: '' };
}

async function runSupportEscalationCycle({
  actor = { uid: 'support-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
  maxPerStatus = 200,
  force = false,
} = {}) {
  if (!SUPPORT_AUTO_ESCALATE_ENABLED && !force) {
    return { ok: true, skipped: true, reason: 'disabled', escalated: [] };
  }
  if (supportEscalationLoopInFlight && !force) {
    return { ok: true, skipped: true, reason: 'in_flight', escalated: [] };
  }
  supportEscalationLoopInFlight = true;
  try {
    const result = await autoEscalateOverdueSupportTickets({
      actor,
      maxPerStatus,
    });
    return {
      ok: true,
      skipped: !!result?.skipped,
      reason: result?.reason || '',
      escalated: Array.isArray(result?.escalated) ? result.escalated : [],
    };
  } catch (err) {
    console.error('[support escalation] error:', err);
    return { ok: false, skipped: false, reason: 'support_escalation_failed', escalated: [] };
  } finally {
    supportEscalationLoopInFlight = false;
  }
}

async function listStatusEvents(scopeId = 'GLOBAL', limit = 200) {
  try {
    const out = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.status,
        KeyConditionExpression: 'scopeId = :scopeId',
        ExpressionAttributeValues: { ':scopeId': String(scopeId || 'GLOBAL').trim().toUpperCase() },
        ScanIndexForward: false,
        Limit: Math.min(500, limit),
      })
    );
    return Array.isArray(out.Items) ? out.Items : [];
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('status_list', err);
    const normalizedScope = String(scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
    const bucket = Array.isArray(demoFallbackState.statusEvents.get(normalizedScope))
      ? demoFallbackState.statusEvents.get(normalizedScope)
      : [];
    return bucket.slice(0, Math.min(500, limit)).map((row) => deepCloneDemo(row));
  }
}

async function saveStatusEvent(scopeId = 'GLOBAL', statusKeyRaw = '', payload = {}) {
  const normalizedScope = String(scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
  const statusKey = String(statusKeyRaw || '').trim();
  if (!statusKey) throw new Error('statusKey_required');
  const now = Date.now();
  const item = {
    scopeId: normalizedScope,
    statusKey,
    payload: JSON.stringify(payload || {}),
    updatedAt: now,
    createdAt: Number(payload.createdAt || now),
  };
  await putItem(TABLES.status, item);
  publishStatusStreamEvent({
    scopeId: normalizedScope,
    statusKey,
    severity: String(payload?.severity || '').trim().toUpperCase(),
    incidentState: normalizeIncidentState(payload?.incidentState || payload?.state || 'OPEN'),
  });
  return item;
}

async function getLicenseUsageSnapshot({
  licenseId = '',
  orgId = '',
  siteIds = [],
} = {}) {
  const normalizedLicense = normalizedLicenseId(licenseId || '');
  if (!normalizedLicense) {
    return {
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    };
  }
  const activeUserIds = await listActiveLicenseUserIds(normalizedLicense).catch(() => new Set());
  let assignedSeats = 0;
  let activeRooms = 0;
  const sites = sanitizeSiteIds(siteIds, []);
  for (const siteId of sites) {
    // eslint-disable-next-line no-await-in-loop
    const page = await queryByPartitionKey({
      tableName: TABLES.rooms,
      indexName: 'bySiteIndex',
      partitionKey: 'siteId',
      partitionValue: siteId,
      limit: 100,
      scanForward: true,
    }).catch(() => ({ items: [] }));
    for (const room of page.items || []) {
      const normalized = normalizeRoomShape(room);
      assignedSeats += getSeatCount(normalized);
      if (String(normalized.stage || '') !== 'CLOSED') activeRooms += 1;
    }
  }

  const billingEvents = await listBillingEventsByOrg(orgId || normalizedOrgId('', normalizedLicense), 400).catch(
    () => []
  );
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const aiUsageCostCents30d = billingEvents
    .filter((event) => Number(event.createdAt || 0) >= cutoff)
    .filter((event) => String(event.eventType || '').toUpperCase() === 'AI_USAGE')
    .reduce((sum, event) => sum + Number(event.amountCents || 0), 0);

  return {
    activeUsers: activeUserIds.size,
    assignedSeats,
    activeRooms,
    aiUsageCostCents30d,
  };
}

function mapCodeRow(code) {
  const expiresAt = codeExpiresAtMs(code);
  return {
    code: code.code,
    codeHash: code.codeHash || '',
    role: String(code.role || '').toUpperCase(),
    siteId: normalizedSiteId(code.siteId || ''),
    siteIds: sanitizeSiteIds(code.siteIds || []),
    licenseId: normalizedLicenseId(code.licenseId || ''),
    orgId: normalizedOrgId(code.orgId || '', code.licenseId || ''),
    consumed: !!code.consumed,
    revoked: !!code.revoked,
    usedBy: code.usedBy || '',
    createdBy: code.createdBy || '',
    createdAt: Number(code.createdAt || 0) || null,
    consumedAt: Number(code.consumedAt || 0) || null,
    revokedAt: Number(code.revokedAt || 0) || null,
    revokedBy: code.revokedBy || '',
    defaultMode: code.defaultMode || '',
    expiresAt: expiresAt || null,
    expired: codeIsExpired(code),
  };
}

async function queryRecentCodesByRole({
  role,
  limit = 100,
  lastKey = null,
}) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  if (!normalizedRole) return { items: [], nextKey: null };
  const out = await queryByPartitionKey({
    tableName: TABLES.codes,
    indexName: 'byRoleCreatedAt',
    partitionKey: 'role',
    partitionValue: normalizedRole,
    limit,
    scanForward: false,
    exclusiveStartKey: lastKey || undefined,
  });
  return { items: out.items, nextKey: out.lastKey };
}

async function writeAuditEvent({
  action,
  actor = {},
  target = {},
  details = {},
} = {}) {
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction) return;

  const now = Date.now();
  const orgId = normalizedOrgId(
    target.orgId || actor.orgId || '',
    target.licenseId || actor.licenseId || ''
  );
  const siteId = normalizedSiteId(target.siteId || actor.siteId || '');
  const licenseId = normalizedLicenseId(target.licenseId || actor.licenseId || '');
  const scopeId = orgId || licenseId || siteId || 'GLOBAL';
  const createdAtAudit = `${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
  const auditRetentionDays = toPositiveInt(
    details?.auditRetentionDays,
    DEFAULT_AUDIT_RETENTION_DAYS,
    { min: 1, max: 3650 }
  );

  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.audit,
        Item: {
          scopeId,
          createdAtAudit,
          createdAt: now,
          action: normalizedAction,
          actorUid: String(actor.uid || '').trim() || '(system)',
          actorRole: String(actor.role || '').toUpperCase() || 'SYSTEM',
          actorEmail: normalizeSuperAdminEmail(actor.email || ''),
          orgId: orgId || '',
          licenseId: licenseId || '',
          siteId: siteId || '',
          roomId: String(target.roomId || '').trim(),
          resourceType: String(target.resourceType || '').trim() || '',
          resourceId: String(target.resourceId || '').trim() || '',
          details:
            details && typeof details === 'object'
              ? JSON.stringify(details).slice(0, 6000)
              : '',
          expiresAt: computeRetentionTtlSeconds(auditRetentionDays),
        },
      })
    );
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      if (!auditTableMissingWarned) {
        console.warn(
          `[audit] table '${TABLES.audit}' missing; audit writes disabled`
        );
        auditTableMissingWarned = true;
      }
      return;
    }
    console.warn('[audit] write failed:', err?.message || err);
  }
}

function userIdsFromRoom(room) {
  const fromSeatUids = Array.isArray(room?.seatUids)
    ? room.seatUids.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  if (fromSeatUids.length) return fromSeatUids;

  const fromSeats = Array.isArray(room?.seats)
    ? room.seats.map((s) => String(s?.uid || '').trim()).filter(Boolean)
    : [];
  return Array.from(new Set(fromSeats));
}

function formatCodePrefixForRole(role) {
  const normalized = String(role || '').trim().toUpperCase();
  if (normalized === 'SUPER_ADMIN') return 'SA';
  if (normalized === 'ADMIN') return 'A';
  if (normalized === 'PRESENTER') return 'P';
  return 'U';
}

function makeAccessCode(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function createCodeRecord({
  role,
  siteId = '',
  siteIds = [],
  licenseId = '',
  orgId = '',
  defaultMode = '',
  createdBy = '',
  expiresAtMs = 0,
} = {}) {
  const normalizedRole = String(role || 'PARTICIPANT').trim().toUpperCase();
  const normalizedSiteIdValue = normalizedSiteId(siteId);
  const normalizedSiteIds = sanitizeSiteIds(siteIds, normalizedSiteIdValue ? [normalizedSiteIdValue] : []);
  const normalizedLicense = normalizedLicenseId(
    licenseId || normalizedSiteIds[0] || normalizedSiteIdValue
  );
  const normalizedOrg = normalizedOrgId(orgId, normalizedLicense);
  const normalizedModeValue = normalizeMode(defaultMode || DEFAULT_WORKSHOP_MODE);
  const prefix = formatCodePrefixForRole(normalizedRole);
  const now = Date.now();
  const computedExpiresAt =
    Number.isFinite(Number(expiresAtMs)) && Number(expiresAtMs) > now
      ? Number(expiresAtMs)
      : now + CODE_TTL_DAYS * 24 * 60 * 60 * 1000;

  for (let attempt = 0; attempt < 20; attempt++) {
    const code = makeAccessCode(prefix);
    const codeHash = hashCodeValue(code);
    try {
      await ddbDoc.send(
        new PutCommand({
          TableName: TABLES.codes,
          Item: {
            code,
            codeHash,
            role: normalizedRole,
            siteId: normalizedSiteIdValue || normalizedSiteIds[0] || '',
            siteIds: normalizedSiteIds,
            licenseId: normalizedLicense || '',
            orgId: normalizedOrg || '',
            defaultMode: normalizedModeValue,
            consumed: false,
            revoked: false,
            expiresAt: computedExpiresAt,
            createdAt: now,
            createdBy: String(createdBy || '').trim().toLowerCase() || null,
          },
          ConditionExpression: 'attribute_not_exists(code)',
        })
      );
      return {
        code,
        codeHash,
        role: normalizedRole,
        siteId: normalizedSiteIdValue || normalizedSiteIds[0] || '',
        siteIds: normalizedSiteIds,
        licenseId: normalizedLicense || '',
        orgId: normalizedOrg || '',
        defaultMode: normalizedModeValue,
        createdAt: now,
        consumed: false,
        revoked: false,
        expiresAt: computedExpiresAt,
      };
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        continue;
      }
      if (shouldUseDemoFallback(err)) {
        logDemoFallback('code_create_put', err);
        const record = {
          code,
          codeHash,
          role: normalizedRole,
          siteId: normalizedSiteIdValue || normalizedSiteIds[0] || DEMO_DEFAULT_SITE_ID,
          siteIds: normalizedSiteIds.length ? normalizedSiteIds : [DEMO_DEFAULT_SITE_ID],
          licenseId: normalizedLicense || DEMO_DEFAULT_LICENSE_ID,
          orgId: normalizedOrg || DEMO_DEFAULT_ORG_ID,
          defaultMode: normalizedModeValue,
          createdAt: now,
          consumed: false,
          revoked: false,
          expiresAt: computedExpiresAt,
          createdBy: String(createdBy || '').trim().toLowerCase() || null,
        };
        demoFallbackState.codes.set(code, deepCloneDemo(record));
        return record;
      }
      throw err;
    }
  }

  throw new Error(`could_not_generate_unique_code_for_${normalizedRole}`);
}

async function ensureRoom(roomId) {
  let r = await getRoom(roomId);
  if (r) {
    const normalized = normalizeRoomShape(r);
    const patch = {};
    const rawSeatUids = Array.isArray(r.seats)
      ? r.seats.map((s) => String(s?.uid || '').trim()).filter(Boolean)
      : [];
    const normalizedSeatUids = normalized.seats.map((s) => s.uid);

    if (!arraysEqual(r.seatUids || [], normalized.seatUids)) {
      patch.seatUids = normalized.seatUids;
    }
    if (!arraysEqual(rawSeatUids, normalizedSeatUids)) {
      patch.seats = normalized.seats;
    }
    if (typeof r.draftText !== 'string') patch.draftText = normalized.draftText;
    if (!Number.isFinite(Number(r.draftVersion))) patch.draftVersion = normalized.draftVersion;
    if (!r.draftUpdatedAt) patch.draftUpdatedAt = normalized.draftUpdatedAt;
    if (typeof r.finalAbstract !== 'string') patch.finalAbstract = normalized.finalAbstract;
    if (!r.closedReason) patch.closedReason = normalized.closedReason;
    if (!r.closedAt) patch.closedAt = normalized.closedAt;
    if (!Array.isArray(r.finalReadyUids)) patch.finalReadyUids = normalized.finalReadyUids;
    if (!Number.isFinite(Number(r.finalReadyCount))) {
      patch.finalReadyCount = normalized.finalReadyCount;
    }
    if (!Array.isArray(r.voteReadyUids)) patch.voteReadyUids = normalized.voteReadyUids;
    if (!Array.isArray(r.voteSubmittedUids)) {
      patch.voteSubmittedUids = normalized.voteSubmittedUids;
    }
    if (!Number.isFinite(Number(r.voteReadyCount))) patch.voteReadyCount = normalized.voteReadyCount;
    if (!Number.isFinite(Number(r.voteSubmittedCount))) {
      patch.voteSubmittedCount = normalized.voteSubmittedCount;
    }
    if (!Number.isFinite(Number(r.voteTotal))) patch.voteTotal = normalized.voteTotal;
    if (!r.voteTallies || typeof r.voteTallies !== 'object') {
      patch.voteTallies = normalized.voteTallies;
    }
    if (!r.voteByUid || typeof r.voteByUid !== 'object') {
      patch.voteByUid = normalized.voteByUid;
    }
    if (!Array.isArray(r.topicOptions)) patch.topicOptions = normalized.topicOptions;
    if (!Array.isArray(r.phasePlan)) patch.phasePlan = normalized.phasePlan;
    if (typeof r.licenseId !== 'string') patch.licenseId = normalized.licenseId;
    if (typeof r.orgId !== 'string') patch.orgId = normalized.orgId;
    if (!Number.isFinite(Number(r.messageRetentionDays))) {
      patch.messageRetentionDays = normalized.messageRetentionDays;
    }
    if (!Number.isFinite(Number(r.draftRetentionDays))) {
      patch.draftRetentionDays = normalized.draftRetentionDays;
    }
    if (!Number.isFinite(Number(r.auditRetentionDays))) {
      patch.auditRetentionDays = normalized.auditRetentionDays;
    }
    if (typeof r.legalHold !== 'boolean') {
      patch.legalHold = !!normalized.legalHold;
    }
    if (typeof r.workshopMode !== 'string') patch.workshopMode = normalized.workshopMode;
    if (typeof r.aiBehavior !== 'string') patch.aiBehavior = normalized.aiBehavior;
    if (typeof r.assistantPersona !== 'string') {
      patch.assistantPersona = normalized.assistantPersona;
    }
    if (!r.autopilot || typeof r.autopilot !== 'object') {
      patch.autopilot = normalized.autopilot;
    }
    if (!r.autopilotActions || typeof r.autopilotActions !== 'object') {
      patch.autopilotActions = normalized.autopilotActions;
    }
    if (!Number.isFinite(Number(r.lastParticipantMessageAt))) {
      patch.lastParticipantMessageAt = normalized.lastParticipantMessageAt;
    }
    if (!r.shareLinks || typeof r.shareLinks !== 'object') {
      patch.shareLinks = normalized.shareLinks;
    }
    if (!r.phaseCanvases || typeof r.phaseCanvases !== 'object') {
      patch.phaseCanvases = normalized.phaseCanvases;
    }
    if (!r.privateDrafts || typeof r.privateDrafts !== 'object') {
      patch.privateDrafts = normalized.privateDrafts;
    }
    if (!Array.isArray(r.decisionLog)) {
      patch.decisionLog = normalized.decisionLog;
    }
    if (!Array.isArray(r.draftApprovedByUids)) {
      patch.draftApprovedByUids = normalized.draftApprovedByUids;
    }
    if (!Number.isFinite(Number(r.draftApprovedVersion))) {
      patch.draftApprovedVersion = normalized.draftApprovedVersion;
    }
    if (!Number.isFinite(Number(r.draftApprovedAt))) {
      patch.draftApprovedAt = normalized.draftApprovedAt;
    }
    if (!Number.isFinite(Number(r.lastAiFallbackAt))) {
      patch.lastAiFallbackAt = normalized.lastAiFallbackAt;
    }
    if (typeof r.lastAiFallbackReason !== 'string') {
      patch.lastAiFallbackReason = normalized.lastAiFallbackReason;
    }
    if (typeof r.lastAiFallbackStage !== 'string') {
      patch.lastAiFallbackStage = normalized.lastAiFallbackStage;
    }

    if (Object.keys(patch).length > 0) {
      r = await updateRoom(roomId, patch);
      return normalizeRoomShape(r);
    }

    return normalized;
  }

  const { siteId, index } = parseRoomId(roomId);
  r = {
    roomId,
    siteId,
    index,
    stage: DEFAULT_STAGE,
    stageEndsAt: Date.now() + getStageDuration('LOBBY'),
    inputLocked: false,
    topic: '',
    ideaSummary: '',
    licenseId: '',
    orgId: '',
    messageRetentionDays: MESSAGE_RETENTION_DAYS,
    draftRetentionDays: DRAFT_RETENTION_DAYS,
    auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    legalHold: false,
    voteOpen: false,
    voteTotal: 0,
    voteTallies: {},
    voteByUid: {},
    topicOptions: [],
    phasePlan: [],
    workshopMode: '',
    aiBehavior: '',
    assistantPersona: '',
    autopilot: { ...AUTOPILOT_DEFAULT },
    autopilotActions: {},
    lastParticipantMessageAt: 0,
    shareLinks: {},
    phaseCanvases: {},
    privateDrafts: {},
    decisionLog: [],
    draftApprovedByUids: [],
    draftApprovedVersion: 0,
    draftApprovedAt: 0,
    lastAiFallbackAt: 0,
    lastAiFallbackReason: '',
    lastAiFallbackStage: '',
    greetedForStage: {},
    seats: [],
    seatUids: [],

    // voting readiness + submitted tracking
    voteReadyUids: [],
    voteReadyCount: 0,
    voteSubmittedUids: [],
    voteSubmittedCount: 0,

    // final-stage tracking
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,

    // NEW: living draft (single source of truth)
    draftText: '',
    draftVersion: 0,
    draftUpdatedAt: null,

    // NEW: closure/gallery
    finalAbstract: '',
    closedReason: null,
    closedAt: null,

    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Dynamo secondary-index keys cannot be empty strings.
  if (!r.licenseId) delete r.licenseId;
  if (!r.orgId) delete r.orgId;
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.rooms,
        Item: r,
        ConditionExpression: 'attribute_not_exists(roomId)',
      })
    );
    return normalizeRoomShape(r);
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('room_create_put', err);
      return setDemoRoomRecord(r);
    }
    if (err?.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
    const existing = await getRoom(roomId);
    if (!existing) {
      throw new Error(`Room create race for ${roomId}, but room not found after retry`);
    }
    return normalizeRoomShape(existing);
  }
}

async function updateRoom(roomId, patch) {
  const writePatch = {
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: Date.now(),
  };
  if (Object.prototype.hasOwnProperty.call(writePatch, 'siteId')) {
    const nextSite = normalizedSiteId(writePatch.siteId || '');
    if (nextSite) writePatch.siteId = nextSite;
    else delete writePatch.siteId;
  }
  if (Object.prototype.hasOwnProperty.call(writePatch, 'licenseId')) {
    const nextLicense = normalizedLicenseId(writePatch.licenseId || '');
    if (nextLicense) writePatch.licenseId = nextLicense;
    else delete writePatch.licenseId;
  }
  if (Object.prototype.hasOwnProperty.call(writePatch, 'orgId')) {
    const nextOrg = normalizedOrgId(
      writePatch.orgId || '',
      writePatch.licenseId || ''
    );
    if (nextOrg) writePatch.orgId = nextOrg;
    else delete writePatch.orgId;
  }
  const entries = Object.entries(writePatch);
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};
  const sets = [];
  let idx = 0;
  for (const [key, value] of entries) {
    idx += 1;
    const nk = `#k${idx}`;
    const vk = `:v${idx}`;
    ExpressionAttributeNames[nk] = key;
    ExpressionAttributeValues[vk] = value;
    sets.push(`${nk} = ${vk}`);
  }

  let next = null;
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );
    next = normalizeRoomShape(Attributes || { roomId, ...writePatch });
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('room_update', err);
    const current = getDemoRoomRecord(roomId) || createDemoRoomRecord(roomId);
    next = setDemoRoomRecord({
      ...current,
      ...writePatch,
      roomId,
      updatedAt: Date.now(),
    });
  }
  if (stageEngine?.touch) stageEngine.touch(roomId);
  publishRoomEvent(roomId, 'room_state', {
    siteId: next.siteId || parseRoomId(roomId).siteId,
    stage: next.stage || DEFAULT_STAGE,
  });
  return next;
}

async function addMessage(
  roomId,
  {
    text,
    phase,
    authorType = 'user',
    personaIndex = 0,
    uid = null,
    emoji = null,
    aiReceipt = null,
  }
) {
  const room = await ensureRoom(roomId);
  const messageRetentionDays = toPositiveInt(
    room?.messageRetentionDays,
    MESSAGE_RETENTION_DAYS,
    { min: 1, max: 3650 }
  );
  const createdAt = await putWithUniqueTimestamp(
    TABLES.messages,
    roomId,
    (ts) => ({
      roomId,
      createdAt: ts,
      expiresAt: computeRetentionTtlSeconds(messageRetentionDays),
      uid: uid || '(system)',
      personaIndex,
      emoji: emoji || null,
      authorType,
      phase: phase || 'LOBBY',
      text,
      aiReceipt:
        aiReceipt && typeof aiReceipt === 'object' ? aiReceipt : undefined,
    })
  );
  if (stageEngine?.touch) stageEngine.touch(roomId);
  publishRoomEvent(roomId, 'message', {
    phase: phase || 'LOBBY',
    authorType,
  });
  return { createdAt };
}

async function touchRoomParticipantActivity(roomId, atMs = Date.now()) {
  if (!roomId) return;
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression:
          'SET lastParticipantMessageAt = :at, updatedAt = :now',
        ExpressionAttributeValues: {
          ':at': Number(atMs || Date.now()),
          ':now': Date.now(),
        },
      })
    );
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('room_touch_participant', err);
      const room = getDemoRoomRecord(roomId) || createDemoRoomRecord(roomId);
      setDemoRoomRecord({
        ...room,
        lastParticipantMessageAt: Number(atMs || Date.now()),
        updatedAt: Date.now(),
      });
      return;
    }
    console.warn('[activity] touch failed:', err?.message || err);
  }
}

async function getMessagesForRoom(roomId, limit = 200) {
  try {
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.messages,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: { ':r': roomId },
        ScanIndexForward: true,
        Limit: Math.min(800, limit),
      })
    );
    return Items || [];
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('messages_query', err);
    return getDemoMessages(roomId).slice(-Math.min(800, limit));
  }
}

function normalizeCanvasPhase(phaseRaw = '') {
  const stage = String(phaseRaw || '').trim().toUpperCase();
  if (STAGE_SET.has(stage)) return stage;
  return 'DISCOVERY';
}

function normalizeCanvasText(value, maxLen = 8000) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}

function normalizeCanvasPayload(payload = {}, fallback = {}) {
  const stickyNotes = normalizeCanvasText(
    payload?.stickyNotes ?? payload?.ideas ?? fallback?.stickyNotes ?? fallback?.ideas ?? '',
    10_000
  );
  const outlineMap = normalizeCanvasText(
    payload?.outlineMap ??
      payload?.structure ??
      fallback?.outlineMap ??
      fallback?.structure ??
      '',
    10_000
  );
  const evidenceBoard = normalizeCanvasText(
    payload?.evidenceBoard ?? fallback?.evidenceBoard ?? '',
    12_000
  );
  const narrativeMap = normalizeCanvasText(
    payload?.narrativeMap ?? payload?.map ?? fallback?.narrativeMap ?? fallback?.map ?? '',
    12_000
  );
  return {
    stickyNotes,
    outlineMap,
    evidenceBoard,
    narrativeMap,
    // Backward-compatible aliases consumed by older clients.
    ideas: stickyNotes,
    structure: outlineMap,
    map: narrativeMap,
    updatedAt: Number(payload?.updatedAt || fallback?.updatedAt || 0) || 0,
    updatedBy: String(payload?.updatedBy || fallback?.updatedBy || '').trim(),
  };
}

function getPhaseCanvas(room = {}, phaseRaw = '') {
  const phase = normalizeCanvasPhase(phaseRaw);
  const all = room?.phaseCanvases && typeof room.phaseCanvases === 'object'
    ? room.phaseCanvases
    : {};
  return normalizeCanvasPayload(all[phase] || {}, {});
}

async function savePhaseCanvas(roomId, phaseRaw, partial = {}, actor = {}) {
  const room = await ensureRoom(roomId);
  const phase = normalizeCanvasPhase(phaseRaw || room.stage || 'DISCOVERY');
  const current = getPhaseCanvas(room, phase);
  const next = normalizeCanvasPayload(
    {
      ...current,
      ...(partial && typeof partial === 'object' ? partial : {}),
      updatedAt: Date.now(),
      updatedBy: String(actor?.uid || '').trim() || '(system)',
    },
    current
  );
  const phaseCanvases = {
    ...(room.phaseCanvases && typeof room.phaseCanvases === 'object'
      ? room.phaseCanvases
      : {}),
    [phase]: next,
  };
  const updated = await updateRoom(roomId, { phaseCanvases });
  return {
    phase,
    canvas: getPhaseCanvas(updated, phase),
  };
}

function extractCerSection(textRaw = '', headingPattern = 'claim(?:s)?') {
  const text = String(textRaw || '');
  if (!text) return '';
  const regex = new RegExp(
    `(?:^|\\n)\\s*${headingPattern}\\s*[:\\-]\\s*([\\s\\S]*?)(?=\\n\\s*(?:claim(?:s)?|evidence|reason(?:ing)?)\\s*[:\\-]|$)`,
    'i'
  );
  const match = regex.exec(text);
  return String(match?.[1] || '').trim();
}

function countEvidenceCitations(textRaw = '') {
  const text = String(textRaw || '');
  if (!text) return 0;
  const matches = text.match(
    /https?:\/\/\S+|\[[0-9]{1,3}\]|\((?:[^()]{2,80},\s*(?:19|20)\d{2})\)/gi
  );
  return Array.isArray(matches) ? matches.length : 0;
}

function resolveEvidenceBoardSnapshot(room = {}) {
  const phases = ['FINAL', 'EDITING', 'PLANNING', 'IDEA_DUMP', 'DISCOVERY', 'ROUGH_DRAFT'];
  for (const phase of phases) {
    const board = String(getPhaseCanvas(room, phase)?.evidenceBoard || '').trim();
    if (board) {
      return { phase, text: board };
    }
  }
  return { phase: '', text: '' };
}

function evaluateEvidenceBoardCerGate(room = {}) {
  const snapshot = resolveEvidenceBoardSnapshot(room);
  const text = String(snapshot.text || '').trim();
  const claim = extractCerSection(text, 'claim(?:s)?');
  const evidence = extractCerSection(text, 'evidence');
  const reasoning = extractCerSection(text, 'reason(?:ing)?');
  const citations = countEvidenceCitations(text);
  const missing = [];
  if (!claim || claim.length < 12) missing.push('claim');
  if (!evidence || evidence.length < 12) missing.push('evidence');
  if (!reasoning || reasoning.length < 12) missing.push('reasoning');
  if (citations < 1) missing.push('citation');
  return {
    ok: missing.length === 0,
    phase: snapshot.phase || '',
    citations,
    missing,
  };
}

function describeCerGateMissing(missing = []) {
  const map = {
    claim: 'Claim section',
    evidence: 'Evidence section',
    reasoning: 'Reasoning section',
    citation: 'At least one citation/source',
  };
  return (Array.isArray(missing) ? missing : [])
    .map((key) => map[key] || key)
    .join(', ');
}

function makeCerGateError(gate = {}) {
  const err = new Error('cer_required');
  err.code = 'cer_required';
  err.statusCode = 409;
  err.cerGate = {
    ok: false,
    phase: String(gate.phase || ''),
    citations: Number(gate.citations || 0),
    missing: Array.isArray(gate.missing) ? gate.missing : [],
  };
  return err;
}

function makePhaseExitGateError(gate = {}) {
  const err = new Error('phase_exit_incomplete');
  err.code = 'phase_exit_incomplete';
  err.statusCode = 409;
  err.phaseGate = {
    ok: false,
    stage: String(gate.stage || '').trim().toUpperCase(),
    requirements: Array.isArray(gate.requirements) ? gate.requirements : [],
    missing: Array.isArray(gate.missing) ? gate.missing : [],
  };
  return err;
}

async function maybePostCerGateReminder(room = {}, gate = {}, { force = false } = {}) {
  const roomId = String(room.roomId || '').trim();
  if (!roomId) return;
  const now = Date.now();
  const last = Number(cerReminderCache.get(roomId) || 0);
  if (!force && now - last < CER_REMINDER_INTERVAL_MS) return;
  cerReminderCache.set(roomId, now);
  const missing = describeCerGateMissing(gate.missing || []);
  await addMessage(roomId, {
    text: [
      '🧾 Before final close, complete your Evidence Board in CER format.',
      'Required: Claim, Evidence, Reasoning, plus at least one citation.',
      missing ? `Missing now: ${missing}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    phase: 'FINAL',
    authorType: 'asema',
    personaIndex: 0,
  });
}

function roomSeatUids(room = {}) {
  const fromSeatUids = Array.isArray(room?.seatUids)
    ? room.seatUids.map((uid) => String(uid || '').trim()).filter(Boolean)
    : [];
  if (fromSeatUids.length) return Array.from(new Set(fromSeatUids));
  const fromSeats = Array.isArray(room?.seats)
    ? room.seats.map((seat) => String(seat?.uid || '').trim()).filter(Boolean)
    : [];
  return Array.from(new Set(fromSeats));
}

function buildRoleRotationState(room = {}, stageRaw = '', forUid = '') {
  const stage = String(stageRaw || room.stage || DEFAULT_STAGE).trim().toUpperCase() || DEFAULT_STAGE;
  const cycleIndex = Math.max(0, ROOM_ORDER.indexOf(stage));
  const uids = roomSeatUids(room);
  const assignments = uids.map((uid, index) => {
    const role = ROLE_ROTATION_ROLES[(index + cycleIndex) % ROLE_ROTATION_ROLES.length];
    return {
      uid,
      seat: index + 1,
      role,
    };
  });
  const myAssignment = assignments.find((entry) => entry.uid === String(forUid || '').trim()) || null;
  return {
    enabled: true,
    stage,
    cycleIndex,
    roles: ROLE_ROTATION_ROLES.slice(),
    assignments,
    myRole: myAssignment?.role || '',
  };
}

function cleanTextLen(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().length;
}

function evaluatePhaseExitGate(room = {}, stageRaw = '') {
  const stage = String(stageRaw || room.stage || DEFAULT_STAGE).trim().toUpperCase() || DEFAULT_STAGE;
  const requirements = [];
  const cerGate = evaluateEvidenceBoardCerGate(room);
  const planningCanvas = getPhaseCanvas(room, 'PLANNING');
  const ideaCanvas = getPhaseCanvas(room, 'IDEA_DUMP');
  const draftText = String(room.draftText || '').trim();
  const draftWords = draftText
    ? draftText
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean).length
    : 0;
  const approvalUids = Array.isArray(room.draftApprovedByUids)
    ? Array.from(new Set(room.draftApprovedByUids.map((uid) => String(uid || '').trim()).filter(Boolean)))
    : [];
  const requiredApprovals = getSeatCount(room) >= 4 ? 2 : 1;
  const draftApproved =
    Number(room.draftVersion || 0) > 0 &&
    Number(room.draftApprovedVersion || 0) === Number(room.draftVersion || 0) &&
    approvalUids.length >= requiredApprovals;

  if (stage === 'DISCOVERY') {
    const topicChosen = cleanTextLen(room.topic || '') >= 3;
    requirements.push({
      id: 'topic_chosen',
      label: 'Topic selected',
      met: topicChosen,
      detail: topicChosen ? String(room.topic || '').trim() : '',
    });
  } else if (stage === 'IDEA_DUMP') {
    const ideationFilled =
      cleanTextLen(room.ideaSummary || '') >= 24 ||
      cleanTextLen(ideaCanvas.stickyNotes || ideaCanvas.ideas || '') >= 24;
    requirements.push({
      id: 'idea_board_filled',
      label: 'Idea board has content',
      met: ideationFilled,
      detail: ideationFilled ? 'Ideas captured' : '',
    });
  } else if (stage === 'PLANNING') {
    const hasStructure = cleanTextLen(planningCanvas.outlineMap || planningCanvas.structure || '') >= 18;
    requirements.push({
      id: 'plan_outlined',
      label: 'Outline map completed',
      met: hasStructure,
      detail: hasStructure ? 'Structure captured' : '',
    });
  } else if (stage === 'ROUGH_DRAFT') {
    const hasDraft = draftWords >= 80;
    requirements.push({
      id: 'rough_draft_ready',
      label: 'Rough draft generated',
      met: hasDraft,
      detail: hasDraft ? `${draftWords} words` : '',
    });
  } else if (stage === 'EDITING') {
    requirements.push({
      id: 'evidence_board_complete',
      label: 'Evidence board complete (CER + citation)',
      met: !!cerGate.ok,
      detail: cerGate.ok ? `Citations: ${Number(cerGate.citations || 0)}` : '',
    });
    requirements.push({
      id: 'draft_approved',
      label: 'Final draft approved by room',
      met: draftApproved,
      detail: `${approvalUids.length}/${requiredApprovals} approvals`,
    });
  } else if (stage === 'FINAL') {
    requirements.push({
      id: 'evidence_board_complete',
      label: 'Evidence board complete (CER + citation)',
      met: !!cerGate.ok,
      detail: cerGate.ok ? `Citations: ${Number(cerGate.citations || 0)}` : '',
    });
  }

  const missing = requirements.filter((req) => !req.met).map((req) => req.id);
  const ok = missing.length === 0;
  return {
    ok,
    stage,
    requirements,
    missing,
    blocked: !ok,
  };
}

function describePhaseGateMissing(missing = []) {
  const labels = {
    topic_chosen: 'Topic selected',
    idea_board_filled: 'Idea board content',
    plan_outlined: 'Planning outline',
    rough_draft_ready: 'Rough draft',
    evidence_board_complete: 'Evidence board (CER + citation)',
    draft_approved: 'Draft approval',
  };
  return (Array.isArray(missing) ? missing : [])
    .map((id) => labels[id] || id)
    .join(', ');
}

async function maybePostPhaseGateReminder(room = {}, gate = {}, { force = false } = {}) {
  const roomId = String(room.roomId || '').trim();
  if (!roomId) return;
  const now = Date.now();
  const last = Number(phaseGateReminderCache.get(roomId) || 0);
  if (!force && now - last < PHASE_GATE_REMINDER_INTERVAL_MS) return;
  phaseGateReminderCache.set(roomId, now);
  const missing = describePhaseGateMissing(gate.missing || []);
  await addMessage(roomId, {
    text: [
      '🚧 Phase exit gate is active.',
      missing ? `Complete before advancing: ${missing}.` : 'Complete required outputs before advancing.',
    ]
      .filter(Boolean)
      .join('\n'),
    phase: String(room.stage || DEFAULT_STAGE).toUpperCase(),
    authorType: 'asema',
    personaIndex: 0,
  });
}

function listFallbackTemplatesForStage(stageRaw = '') {
  const stage = String(stageRaw || '').trim().toUpperCase() || DEFAULT_STAGE;
  const templates = {
    LOBBY: [
      {
        id: 'lobby_checkin',
        label: 'Quick Team Check-In',
        prompt:
          'In one sentence each, share your working perspective on this topic and one real-world impact you have seen.',
      },
    ],
    DISCOVERY: [
      {
        id: 'discovery_truth',
        label: 'Truth Prompt',
        prompt:
          'Name one concrete moment that reveals the problem, who is affected, and why it matters.',
      },
      {
        id: 'discovery_evidence',
        label: 'Evidence Prompt',
        prompt:
          'List two observations and one source your team can verify before moving on.',
      },
    ],
    IDEA_DUMP: [
      {
        id: 'idea_cluster',
        label: 'Idea Cluster Prompt',
        prompt:
          'Generate five possible angles, then circle the one with highest urgency and impact.',
      },
    ],
    PLANNING: [
      {
        id: 'planning_outline',
        label: 'Planning Outline Prompt',
        prompt:
          'Fill this structure: Opening context, core conflict, turning point, and specific call to action.',
      },
    ],
    ROUGH_DRAFT: [
      {
        id: 'draft_structure',
        label: 'Manual Draft Prompt',
        prompt:
          'Draft 200-300 words with: hook, lived context, evidence, impact, and a clear call to action.',
      },
    ],
    EDITING: [
      {
        id: 'edit_pass',
        label: 'Editing Pass Prompt',
        prompt:
          'Run an edit pass for clarity, remove vague statements, and tighten each paragraph to one core point.',
      },
    ],
    FINAL: [
      {
        id: 'final_gate',
        label: 'Final Checklist Prompt',
        prompt:
          'Verify Claim, Evidence, Reasoning, and at least one citation. Confirm all team members approve final draft.',
      },
    ],
  };
  const common = [
    {
      id: 'common_claim_evidence',
      label: 'Claim-Evidence-Reasoning Prompt',
      prompt:
        'State one claim, add one evidence point with source, then explain your reasoning in two sentences.',
    },
  ];
  return (templates[stage] || []).concat(common);
}

function serializeAiFallbackState(room = {}, stageRaw = '') {
  const stage = String(stageRaw || room.stage || DEFAULT_STAGE).trim().toUpperCase() || DEFAULT_STAGE;
  const lastAt = Number(room.lastAiFallbackAt || 0) || 0;
  const active = lastAt > 0 && Date.now() - lastAt <= AI_FALLBACK_ACTIVE_WINDOW_MS;
  return {
    active,
    stage,
    lastFallbackAt: lastAt,
    lastFallbackReason: String(room.lastAiFallbackReason || '').trim(),
    lastFallbackStage: String(room.lastAiFallbackStage || '').trim().toUpperCase(),
    templates: listFallbackTemplatesForStage(stage),
  };
}

function buildRoomQualityScorecard(room = {}, { participationBalance = null } = {}) {
  const metrics = roomOutcomeMetrics(room);
  const cerGate = evaluateEvidenceBoardCerGate(room);
  const completion = Math.round(
    Math.min(
      100,
      stageProgressRatio(room.stage || DEFAULT_STAGE) * 55 +
        Math.min(45, Number(room.draftVersion || 0) * 15)
    )
  );
  const evidenceQuality = cerGate.ok
    ? Math.min(100, 70 + Math.min(30, Number(cerGate.citations || 0) * 10))
    : Math.max(0, 100 - Number((cerGate.missing || []).length || 0) * 25);
  const seats = Math.max(1, Number(getSeatCount(room) || 1));
  const participationFallback = Math.round(
    Math.min(
      100,
      ((Math.min(seats, Number(room.voteSubmittedCount || 0)) +
        Math.min(seats, Number(room.finalReadyCount || 0))) /
        (seats * 2)) *
        100
    )
  );
  const participation = Number.isFinite(Number(participationBalance))
    ? Math.max(0, Math.min(100, Number(participationBalance)))
    : participationFallback;
  const policyAdherence = metrics.policyAdherent ? 100 : 68;
  const total = Math.round(
    completion * 0.3 + evidenceQuality * 0.3 + participation * 0.2 + policyAdherence * 0.2
  );
  return {
    total,
    completion,
    evidenceQuality,
    participationBalance: participation,
    policyAdherence,
    draftVersion: Number(room.draftVersion || 0),
    finalReadyCount: Number(room.finalReadyCount || 0),
    seats: Number(getSeatCount(room) || 0),
  };
}

function serializePrivateDraftState(room = {}, uidRaw = '') {
  const uid = String(uidRaw || '').trim();
  const map = normalizePrivateDraftMap(room.privateDrafts || {});
  const mineRaw = map[uid] || normalizePrivateDraftEntry({});
  const mine = {
    text: String(mineRaw.text || ''),
    updatedAt: Number(mineRaw.updatedAt || 0) || 0,
    submittedAt: Number(mineRaw.submittedAt || 0) || 0,
    submitted: Number(mineRaw.submittedAt || 0) > 0,
  };
  const submissions = Object.entries(map)
    .filter(([, value]) => Number(value?.submittedAt || 0) > 0 && cleanTextLen(value?.text || '') > 0)
    .map(([draftUid, value]) => ({
      uid: String(draftUid || ''),
      text: String(value?.text || ''),
      preview: clipText(String(value?.text || ''), 240),
      submittedAt: Number(value?.submittedAt || 0) || 0,
      updatedAt: Number(value?.updatedAt || 0) || 0,
      mergedAt: Number(value?.mergedAt || 0) || 0,
      mergedBy: String(value?.mergedBy || '').trim(),
      mine: uid ? uid === String(draftUid || '') : false,
    }))
    .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
  return { mine, submissions };
}

function serializeDecisionLog(room = {}, { limit = 40 } = {}) {
  const rows = normalizeDecisionLog(room.decisionLog || []);
  const capped = rows.slice(-Math.max(1, Number(limit || 40)));
  return capped
    .slice()
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .map((row) => ({
      id: row.id,
      at: Number(row.at || 0) || 0,
      type: String(row.type || ''),
      stage: String(row.stage || ''),
      label: String(row.label || ''),
      actorUid: String(row.actorUid || ''),
      details: row.details || {},
    }));
}

async function appendDecisionLog(roomIdRaw, entry = {}) {
  const roomId = String(roomIdRaw || '').trim();
  if (!roomId) return null;
  const row = normalizeDecisionLogEntry(entry || {});
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression:
          'SET decisionLog = list_append(if_not_exists(decisionLog, :empty), :entry), updatedAt = :now',
        ExpressionAttributeValues: {
          ':empty': [],
          ':entry': [row],
          ':now': Date.now(),
        },
      })
    );
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('decision_log_append', err);
      const room = getDemoRoomRecord(roomId) || createDemoRoomRecord(roomId);
      const decisionLog = normalizeDecisionLog((room.decisionLog || []).concat([row]));
      setDemoRoomRecord({
        ...room,
        decisionLog,
        updatedAt: Date.now(),
      });
    } else {
      console.warn('[decision_log] append skipped:', err?.message || err);
      return null;
    }
  }
  publishRoomEvent(roomId, 'room_state', {
    siteId: parseRoomId(roomId).siteId,
    stage: String(row.stage || DEFAULT_STAGE).trim().toUpperCase() || DEFAULT_STAGE,
  });
  return row;
}

async function markRoomAiFallback(
  roomIdRaw,
  { stage = DEFAULT_STAGE, reason = 'ai_unavailable', actorUid = '(system)' } = {}
) {
  const roomId = String(roomIdRaw || '').trim();
  if (!roomId) return;
  const at = Date.now();
  const normalizedStage = String(stage || DEFAULT_STAGE).trim().toUpperCase() || DEFAULT_STAGE;
  await updateRoom(roomId, {
    lastAiFallbackAt: at,
    lastAiFallbackReason: String(reason || 'ai_unavailable').trim(),
    lastAiFallbackStage: normalizedStage,
  }).catch(() => null);
  await appendDecisionLog(roomId, {
    at,
    type: 'AI_FALLBACK',
    stage: normalizedStage,
    label: 'AI fallback mode activated',
    actorUid,
    details: {
      reason: String(reason || 'ai_unavailable').trim(),
    },
  }).catch(() => null);
}

function parseAuditDetailsJson(detailsRaw) {
  if (!detailsRaw) return {};
  if (detailsRaw && typeof detailsRaw === 'object' && !Array.isArray(detailsRaw)) {
    return detailsRaw;
  }
  try {
    const parsed = JSON.parse(String(detailsRaw || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function replayActionLabel(actionRaw, detailsRaw = {}) {
  const action = String(actionRaw || '').trim().toUpperCase();
  const details = parseAuditDetailsJson(detailsRaw);
  const fromStage = String(details.fromStage || '').replace(/_/g, ' ');
  const toStage = String(details.toStage || details.stage || '').replace(/_/g, ' ');
  const bySeconds = Number(details.bySeconds || 0);
  const topic = String(details.topic || '').trim();

  if (action === 'PRESENTER_STAGE_NEXT') {
    return fromStage && toStage
      ? `Facilitator advanced stage: ${fromStage} -> ${toStage}`
      : 'Facilitator advanced to the next stage.';
  }
  if (action === 'PRESENTER_STAGE_EXTEND') {
    return bySeconds > 0
      ? `Facilitator extended timer by ${bySeconds}s.`
      : 'Facilitator extended the room timer.';
  }
  if (action === 'PRESENTER_STAGE_REDO') {
    return toStage
      ? `Facilitator reset room back to ${toStage}.`
      : 'Facilitator restarted the drafting stage.';
  }
  if (action === 'PRESENTER_INPUT_LOCK') return 'Facilitator locked participant input.';
  if (action === 'PRESENTER_INPUT_UNLOCK') return 'Facilitator unlocked participant input.';
  if (action === 'PRESENTER_VOTE_START') return 'Facilitator opened voting.';
  if (action === 'PRESENTER_VOTE_CLOSE') {
    return topic ? `Facilitator closed voting and locked topic: ${topic}` : 'Facilitator closed voting.';
  }
  if (action === 'ROOM_VOTE_READY') return 'Participant marked ready for vote.';
  if (action === 'ROOM_VOTE_SUBMIT') {
    const choice = Number(details.choice || 0);
    return choice > 0 ? `Participant submitted vote: option ${choice}.` : 'Participant submitted a vote.';
  }
  if (action === 'ROOM_TOPIC_LOCKED') {
    return topic ? `Room topic locked: ${topic}.` : 'Room topic locked.';
  }
  if (action === 'ROOM_DRAFT_EDIT') {
    const version = Number(details.version || 0);
    return version > 0 ? `Draft edited to version ${version}.` : 'Draft edited.';
  }
  if (action === 'AUTOPILOT_STUCK_INTERVENTION') {
    return 'Autopilot detected a stuck group and triggered intervention.';
  }
  if (action === 'AUTOPILOT_PHASE_NUDGE') {
    return 'Autopilot sent a final-minute nudge.';
  }
  if (action === 'PRESENTER_FINAL_CLOSE') return 'Facilitator closed the room from FINAL.';
  if (action === 'ROOM_CLOSED') {
    const reason = String(details.reason || '').trim();
    return reason ? `Room closed (${reason}).` : 'Room closed.';
  }
  return action
    .split('_')
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ');
}

function mapAuditRowToReplayEntry(item = {}) {
  const action = String(item.action || '').trim().toUpperCase();
  if (!action) return null;
  const details = parseAuditDetailsJson(item.details);
  const phaseRaw = String(details.toStage || details.stage || '').trim().toUpperCase();
  const phase = STAGE_SET.has(phaseRaw) ? phaseRaw : '';
  return {
    type: 'action',
    at: Number(item.createdAt || 0) || Date.now(),
    phase,
    action,
    actorUid: String(item.actorUid || ''),
    actorRole: String(item.actorRole || ''),
    text: replayActionLabel(action, details),
    details,
  };
}

async function listRoomReplayAuditEntries(room = {}, roomId = '', limit = 220) {
  const normalizedRoomId = String(roomId || '').trim();
  if (!normalizedRoomId) return [];
  const orgId = normalizedOrgId(room?.orgId || '', room?.licenseId || '');
  if (!orgId) return [];
  try {
    const page = await queryByPartitionKey({
      tableName: TABLES.audit,
      indexName: 'byOrgCreatedAt',
      partitionKey: 'orgId',
      partitionValue: orgId,
      limit: Math.min(700, Math.max(80, Number(limit || 220))),
      scanForward: false,
    });
    const rows = Array.isArray(page.items) ? page.items : [];
    const out = [];
    for (const row of rows) {
      const rowRoomId = String(row.roomId || '');
      const rowResourceId = String(row.resourceId || '');
      if (rowRoomId !== normalizedRoomId && rowResourceId !== normalizedRoomId) continue;
      const mapped = mapAuditRowToReplayEntry(row);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return [];
    console.warn('[replay] audit lookup skipped:', err?.message || err);
    return [];
  }
}

function buildReplayEntries(messages = [], auditEntries = []) {
  const sorted = (Array.isArray(messages) ? messages : [])
    .slice()
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const entries = [];
  let lastPhase = '';
  for (const msg of sorted) {
    const phase = String(msg.phase || 'LOBBY').toUpperCase();
    if (phase && phase !== lastPhase) {
      entries.push({
        type: 'stage',
        phase,
        at: Number(msg.createdAt || 0) || Date.now(),
      });
      lastPhase = phase;
    }
    entries.push({
      type: 'message',
      at: Number(msg.createdAt || 0) || Date.now(),
      phase,
      authorType: String(msg.authorType || 'user'),
      text: String(msg.text || ''),
      emoji: String(msg.emoji || ''),
      personaIndex: Number(msg.personaIndex || 0),
      aiReceipt:
        msg.aiReceipt && typeof msg.aiReceipt === 'object' ? msg.aiReceipt : null,
    });
  }

  const merged = entries
    .concat(Array.isArray(auditEntries) ? auditEntries : [])
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));

  return merged;
}

// ---------- Stage Instructions ----------
function stageInstructionText(stage) {
  switch (stage) {
    case 'LOBBY':
      return [
        '👋 **LOBBY (Orientation)**',
        '• Pick your emoji persona (top-right).',
        '• Send one test message: “Hello + one sentence about your day.”',
        '• To ask me for help, start with: **Asema, ...**',
      ].join('\n');

    case 'DISCOVERY':
      return [
        '🧭 **DISCOVERY**',
        '• Share a short story, memory, or observation about the issue.',
        '• When you feel ready, click **I’m ready to vote**.',
        '• Ask me: “Asema, ask us 3 deeper questions.”',
      ].join('\n');

    case 'IDEA_DUMP':
      return [
        '⚡ **IDEA DUMP**',
        '• Drop fast bullets: characters, setting, conflict, turning point, what changes.',
        '• Volume > perfection. No debating yet.',
      ].join('\n');

    case 'PLANNING':
      return [
        '🧩 **PLANNING**',
        '• Use the Planning Board to choose 1 focus + 1 structure + 3 key beats.',
        '• Click **Share plan with room** when it’s solid.',
      ].join('\n');

    case 'ROUGH_DRAFT':
      return [
        '📝 **ROUGH DRAFT**',
        '• Click **Generate Rough Draft** (or say: “Asema, generate rough draft”).',
        '• This becomes your living draft we will edit — not a one-off.',
      ].join('\n');

    case 'EDITING':
      return [
        '✂️ **EDITING**',
        '• Give edit instructions like: “Replace the first sentence with…”',
        '• Say “show what we have so far” anytime to see the latest version.',
        '• I will apply edits to the SAME draft (versioned).',
      ].join('\n');

    case 'FINAL':
      return [
        '🏁 **FINAL**',
        '• I’ll paste the latest draft. Make final tiny changes (clarity, punch, ending).',
        '• When YOU are finished, type **done** (or **submit**).',
        '• When time runs out, I’ll close automatically and post the final abstract.',
      ].join('\n');

    case 'CLOSED':
      return [
        '🔒 **CLOSED**',
        '• Session is read-only now. Copy/screenshot the final abstract above.',
      ].join('\n');

    default:
      return `⏱️ Moving into **${stage}**.`;
  }
}

// ---------- Draft helpers (legacy drafts table kept as audit trail) ----------
async function getLatestDraft(roomId) {
  try {
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.drafts,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: { ':r': roomId },
        ScanIndexForward: false,
        Limit: 1,
      })
    );
    return (Items && Items[0]) || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('draft_latest', err);
    const rows = Array.isArray(demoFallbackState.drafts.get(roomId))
      ? demoFallbackState.drafts.get(roomId)
      : [];
    return rows.length ? deepCloneDemo(rows[rows.length - 1]) : null;
  }
}

async function saveDraftSnapshot(roomId, content, version) {
  const room = await ensureRoom(roomId);
  const draftRetentionDays = toPositiveInt(room?.draftRetentionDays, DRAFT_RETENTION_DAYS, {
    min: 1,
    max: 3650,
  });
  const createdAt = await putWithUniqueTimestamp(
    TABLES.drafts,
    roomId,
    (ts) => ({
      roomId,
      createdAt: ts,
      expiresAt: computeRetentionTtlSeconds(draftRetentionDays),
      content: (content || '').trim(),
      version: Number(version || 1),
    })
  );
  return { createdAt };
}

async function resolveAiPolicyForRoom(room = {}) {
  const licenseId = normalizedLicenseId(room.licenseId || '');
  const orgId = normalizedOrgId(room.orgId || '', licenseId);
  const orgScope = makeScopeId({ orgId, licenseId });
  const licenseScope = makeScopeId({ licenseId });

  const [orgPolicyRow, licensePolicyRow] = await Promise.all([
    getPolicy(orgScope, 'AI').catch(() => null),
    getPolicy(licenseScope, 'AI').catch(() => null),
  ]);

  const merged = parseJsonObject(
    orgPolicyRow?.policy || licensePolicyRow?.policy,
    AI_POLICY_DEFAULT
  );
  return normalizeAiPolicy(merged);
}

function buildAsemaOptions(room = {}, policy = {}) {
  return {
    aiBehavior: room.aiBehavior,
    assistantPersona: room.assistantPersona,
    tone: policy.tone,
    strictness: policy.strictness,
    dataUsage: policy.dataUsage,
    modelChoice: policy.modelChoice,
    piiRedaction: policy.piiRedaction,
    citationMode: policy.citationMode,
    ageSafeMode: policy.ageSafeMode,
    moderationLevel: policy.moderationLevel,
    blockedTerms: normalizeBlockedTerms(policy.blockedTerms || []),
  };
}

function buildAiReceipt({
  stage = '',
  policy = {},
  source = 'openai',
  prompt = '',
  fallback = false,
  blockedFlags = [],
} = {}) {
  const strictness = String(policy?.strictness || 'MEDIUM').trim().toUpperCase();
  const confidenceBase = strictness === 'HIGH' ? 0.82 : strictness === 'LOW' ? 0.72 : 0.77;
  const normalizedPrompt = String(prompt || '').trim();
  const intent = normalizedPrompt
    ? normalizedPrompt.split(/\s+/).slice(0, 8).join(' ')
    : '';
  const flags = Array.isArray(blockedFlags)
    ? blockedFlags.map((flag) => String(flag || '').trim()).filter(Boolean)
    : [];
  return {
    source: fallback ? 'fallback' : source,
    stage: String(stage || '').toUpperCase() || DEFAULT_STAGE,
    reason: fallback
      ? 'Fallback guidance used because model response was unavailable.'
      : `Suggested based on current phase context and your request${intent ? `: "${intent}"` : ''}.`,
    confidence: Number((fallback ? 0.61 : confidenceBase).toFixed(2)),
    policyChecks: {
      tone: String(policy?.tone || 'BALANCED').toUpperCase(),
      strictness,
      piiRedaction: policy?.piiRedaction !== false,
      citationMode: !!policy?.citationMode,
      dataUsage: String(policy?.dataUsage || 'NO_TRAINING').toUpperCase(),
      ageSafeMode: String(policy?.ageSafeMode || AI_POLICY_DEFAULT.ageSafeMode).toUpperCase(),
      moderationLevel: String(
        policy?.moderationLevel || AI_POLICY_DEFAULT.moderationLevel
      ).toUpperCase(),
      passed: flags.length === 0,
      flags,
    },
    generatedAt: Date.now(),
  };
}

async function generateRoughDraftForRoom(room, { force = false } = {}) {
  // NEW: generate into living draft (draftText); regen overwrites with new version
  if (!force && room.draftText && room.draftText.trim()) {
    return {
      roomId: room.roomId,
      createdAt: room.draftUpdatedAt || Date.now(),
      content: room.draftText,
      version: Number(room.draftVersion || 0),
      reused: true,
      fallback: false,
    };
  }

  try {
    const aiPolicy = await resolveAiPolicyForRoom(room);
    const text = await Asema.generateRoughDraft(
      room.topic || '',
      room.ideaSummary || '',
      room.roomId,
      buildAsemaOptions(room, aiPolicy)
    );
    let draft = (text || '').trim();
    const outputSafety = evaluateSchoolSafetyText(draft, aiPolicy);
    if (outputSafety.blocked) {
      draft =
        'Safety checkpoint: the generated draft needs moderation review. Rebuild with policy-safe language, no personal identifiers, and evidence-based framing.';
    }

    const nextVersion = Number(room.draftVersion || 0) + 1;
    const updated = await updateRoom(room.roomId, {
      draftText: draft,
      draftVersion: nextVersion,
      draftUpdatedAt: Date.now(),
      draftApprovedByUids: [],
      draftApprovedVersion: 0,
      draftApprovedAt: 0,
    });

    await saveDraftSnapshot(room.roomId, draft, nextVersion);

    await addMessage(room.roomId, {
      text: `📝 **Rough Draft (v${nextVersion})**\n\n${draft}`,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
      aiReceipt: buildAiReceipt({
        stage: 'ROUGH_DRAFT',
        policy: aiPolicy,
        source: outputSafety.blocked ? 'policy_guard' : 'openai_draft',
        prompt: room.topic || '',
        blockedFlags: outputSafety.blocked ? outputSafety.flags : [],
      }),
    });
    await appendDecisionLog(room.roomId, {
      type: 'DRAFT_GENERATED',
      stage: 'ROUGH_DRAFT',
      label: `Draft generated (v${nextVersion})`,
      details: {
        version: nextVersion,
        fallback: false,
      },
    }).catch(() => null);

    console.log(
      `[rough] generated for ${room.roomId}, ~${draft.split(/\s+/).length} words`
    );

    return {
      roomId: room.roomId,
      createdAt: updated.draftUpdatedAt,
      content: draft,
      version: nextVersion,
      fallback: false,
    };
  } catch (e) {
    console.error('[rough] generation failed:', e?.message || e);
    const fallback =
      'Draft unavailable due to an AI error. Continue discussing your 250-word abstract together.';

    const nextVersion = Number(room.draftVersion || 0) + 1;
    const updated = await updateRoom(room.roomId, {
      draftText: fallback,
      draftVersion: nextVersion,
      draftUpdatedAt: Date.now(),
      draftApprovedByUids: [],
      draftApprovedVersion: 0,
      draftApprovedAt: 0,
    });

    await saveDraftSnapshot(room.roomId, fallback, nextVersion);

    await addMessage(room.roomId, {
      text: `📝 **Rough Draft (v${nextVersion})**\n\n${fallback}`,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
      aiReceipt: buildAiReceipt({
        stage: 'ROUGH_DRAFT',
        policy: AI_POLICY_DEFAULT,
        source: 'fallback',
        prompt: room.topic || '',
        fallback: true,
      }),
    });
    await markRoomAiFallback(room.roomId, {
      stage: 'ROUGH_DRAFT',
      reason: 'rough_draft_generation_failed',
    }).catch(() => null);
    await appendDecisionLog(room.roomId, {
      type: 'DRAFT_GENERATED',
      stage: 'ROUGH_DRAFT',
      label: `Draft fallback generated (v${nextVersion})`,
      details: {
        version: nextVersion,
        fallback: true,
      },
    }).catch(() => null);

    return {
      roomId: room.roomId,
      createdAt: updated.draftUpdatedAt,
      content: fallback,
      version: nextVersion,
      fallback: true,
    };
  }
}

// ---------- Editing: apply edits to the SAME living draft ----------
function clipText(s, max = 9000) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n[...clipped...]';
}

function temperatureFromPolicy(policy = {}) {
  const strictness = String(policy.strictness || 'MEDIUM').trim().toUpperCase();
  if (strictness === 'HIGH') return 0.2;
  if (strictness === 'LOW') return 0.55;
  return 0.35;
}

async function callOpenAIForEdit({ topic, stage, baseDraft, instructions, policy = {} }) {
  const client = getOpenAI();
  const normalizedPolicy = normalizeAiPolicy(policy || {});
  const model = String(normalizedPolicy.modelChoice || OPENAI_MODEL).trim() || OPENAI_MODEL;
  const policyGuidance = `
AI policy controls:
- Tone: ${normalizedPolicy.tone}
- Strictness: ${normalizedPolicy.strictness}
- Data usage: ${normalizedPolicy.dataUsage}
- PII redaction: ${normalizedPolicy.piiRedaction ? 'ENABLED' : 'DISABLED'}
- Citation mode: ${normalizedPolicy.citationMode ? 'ENABLED' : 'DISABLED'}
- Age-safe mode: ${normalizedPolicy.ageSafeMode}
- Moderation level: ${normalizedPolicy.moderationLevel}
- Blocked terms: ${(normalizedPolicy.blockedTerms || []).join(', ') || 'none'}
`.trim();
  const sys = `
You are Asema — a warm, witty, clear workshop host helping a small group craft a ~250-word story abstract.

IMPORTANT:
- You are editing ONE existing draft.
- Preserve the same protagonist/setting/plot unless the user explicitly asks to change them.
- Do NOT generate a totally new draft.
- Keep length close to ~250 words.
- Output ONLY the updated abstract text (no headings, no bullets, no commentary).
${policyGuidance}
`.trim();

  const user = `
Stage: ${stage}
Topic: ${topic || '(not locked)'}
User edit request:
${instructions}

Current draft:
${baseDraft}

Return the updated draft now.
`.trim();

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: temperatureFromPolicy(normalizedPolicy),
    max_tokens: 700,
  });

  return (res.choices?.[0]?.message?.content || '').trim();
}

async function applyDraftEdits(room, instructions) {
  const baseDraft = (room.draftText || '').trim();
  const aiPolicy = await resolveAiPolicyForRoom(room);

  let updatedText = '';
  try {
    updatedText = await callOpenAIForEdit({
      topic: room.topic || '',
      stage: room.stage || 'EDITING',
      baseDraft: clipText(baseDraft || '(empty draft)', 9000),
      instructions: String(instructions || ''),
      policy: aiPolicy,
    });
  } catch (err) {
    if (!DEMO_MODE_FALLBACK) throw err;
    logDemoFallback('draft_edit_openai', err);
    const safeInstruction = String(instructions || '').trim();
    updatedText = `${baseDraft || ''}\n\n[Demo edit note] ${safeInstruction || 'Refine clarity and tighten the narrative.'}`.trim();
  }

  const next = (updatedText || '').trim();
  const nextVersion = Number(room.draftVersion || 0) + 1;

  const updatedRoom = await updateRoom(room.roomId, {
    draftText: next,
    draftVersion: nextVersion,
    draftUpdatedAt: Date.now(),
    draftApprovedByUids: [],
    draftApprovedVersion: 0,
    draftApprovedAt: 0,
  });

  await saveDraftSnapshot(room.roomId, next, nextVersion);

  return { updatedRoom, draftText: next, version: nextVersion };
}

// ---------- Intent helpers ----------
function wantsShowDraft(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('show what we have') ||
    t.includes('show the draft') ||
    t.includes('show latest') ||
    t.includes('paste the draft') ||
    t.includes('what do we have so far') ||
    t.includes('latest version') ||
    t.includes('current version')
  );
}

function looksLikeEditInstruction(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const patterns = [
    'replace',
    'change',
    'rewrite',
    'revise',
    'tighten',
    'shorten',
    'expand',
    'remove',
    'cut',
    'fix',
    'edit',
    'swap',
    'update',
    'clarify',
    'make it',
    'make this',
  ];
  return patterns.some((p) => t.includes(p));
}

function isDoneWord(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === 'done' || t === 'submit';
}

// ---------- Close room + post final abstract + save to room + optional gallery ----------
async function closeRoomWithFinal(
  room,
  { reason = 'manual', closedBy = '(system)' } = {}
) {
  const roomId = room.roomId;
  const cerGate = evaluateEvidenceBoardCerGate(room);
  if (!cerGate.ok) {
    await maybePostCerGateReminder(room, cerGate);
    throw makeCerGateError(cerGate);
  }

  // Final abstract should be the latest living draft
  const finalAbstract = (room.draftText || '').trim();

  // Closing line
  await addMessage(roomId, {
    text:
      reason === 'timeout'
        ? '⏰ **Time’s up — closing the room now.**'
        : reason === 'presenter'
        ? '🧑‍🏫 **Presenter closed the room — great work.**'
        : reason === 'all_done'
        ? '✅ **Everyone is done — locking the final abstract.**'
        : '🏁 **Room closed — beautiful work.**',
    phase: 'FINAL',
    authorType: 'asema',
    personaIndex: 0,
  });

  // Paste final abstract
  if (finalAbstract) {
    await addMessage(roomId, {
      text: `**Final Abstract**\n\n${finalAbstract}`,
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });
  } else {
    await addMessage(roomId, {
      text:
        'I don’t see a saved draft yet — copy the strongest lines from your chat and keep building offline.',
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });
  }

  const closedAt = Date.now();

  const updated = await updateRoom(roomId, {
    stage: 'CLOSED',
    inputLocked: true,
    finalCompletedAt: closedAt,
    finalAbstract: finalAbstract || '',
    closedReason: reason,
    closedAt,
  });
  await appendDecisionLog(roomId, {
    type: 'ROOM_CLOSED',
    stage: 'CLOSED',
    label: `Room closed (${reason})`,
    actorUid: closedBy || '(system)',
    details: {
      reason,
      closedAt,
    },
  }).catch(() => null);

  // Optional gallery write (if table exists)
  try {
    const closedAtRoom = `${String(closedAt).padStart(13, '0')}#${updated.roomId}`;
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.gallery,
        Item: {
          siteId: updated.siteId,
          closedAtRoom,
          licenseId: normalizedLicenseId(updated.licenseId || updated.siteId || ''),
          orgId: normalizedOrgId(updated.orgId || '', updated.licenseId || ''),
          roomId: updated.roomId,
          closedAt,
          index: updated.index,
          topic: updated.topic || '',
          abstract: updated.finalAbstract || '',
          closedBy,
        },
      })
    );
  } catch (e) {
    console.warn('[gallery] put skipped (table may not exist):', e?.message || e);
  }

  await writeAuditEvent({
    action: 'ROOM_CLOSED',
    actor: {
      uid: closedBy || '(system)',
      role: reason === 'presenter' ? 'PRESENTER' : 'SYSTEM',
      licenseId: updated.licenseId || '',
      orgId: updated.orgId || '',
      siteId: updated.siteId || '',
    },
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || '',
      licenseId: updated.licenseId || '',
      orgId: updated.orgId || '',
    },
    details: {
      reason,
      closedAt,
    },
  });

  return updated;
}

// ---------- FINAL: readiness + auto-close (supports typing "done" in normal chat) ----------
async function markFinalReady(roomId, uid) {
  const r = await ensureRoom(roomId);
  if ((r.stage || 'LOBBY') !== 'FINAL') {
    return { ok: false, stage: r.stage || 'LOBBY' };
  }

  let readyUids = Array.isArray(r.finalReadyUids) ? r.finalReadyUids.slice() : [];
  const alreadyReady = readyUids.includes(uid);
  if (!alreadyReady) readyUids.push(uid);

  const updated = alreadyReady
    ? r
    : await updateRoom(roomId, {
        finalReadyUids: readyUids,
        finalReadyCount: readyUids.length,
      });

  if (!alreadyReady) {
    await appendDecisionLog(roomId, {
      type: 'FINAL_SUBMIT',
      stage: 'FINAL',
      label: 'Participant marked final ready',
      actorUid: uid,
      details: {
        readyCount: Number(readyUids.length || 0),
      },
    }).catch(() => null);
  }

  const seats = getSeatCount(updated);
  const readyCount = Number(updated.finalReadyCount || 0);

  let autoClosed = false;
  if (seats > 0 && readyCount >= seats) {
    const latestRoom = await ensureRoom(roomId);
    const cerGate = evaluateEvidenceBoardCerGate(latestRoom);
    if (!cerGate.ok) {
      await maybePostCerGateReminder(latestRoom, cerGate);
      return { ok: true, readyCount, seats, autoClosed: false, blocked: 'cer_required', cerGate };
    }
    try {
      await closeRoomWithFinal(latestRoom, { reason: 'all_done', closedBy: '(all_done)' });
      autoClosed = true;
    } catch (e) {
      console.error('[final ready] auto-close error', e);
      if (e?.code === 'cer_required') {
        return {
          ok: true,
          readyCount,
          seats,
          autoClosed: false,
          blocked: 'cer_required',
          cerGate: e.cerGate || null,
        };
      }
    }
  }

  return { ok: true, readyCount, seats, autoClosed, alreadyReady };
}

// ---------- Stage timeline progression (multi-instance safe) ----------
function toStageMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function makeAutopilotActionKey(room, stage, action) {
  const safeStage = String(stage || '').trim().toUpperCase() || 'UNKNOWN';
  const safeAction = String(action || '').trim().toLowerCase() || 'action';
  const stageEndsAt = toStageMs(room?.stageEndsAt) || 0;
  return `${safeStage}__${stageEndsAt}__${safeAction}`.replace(
    /[^A-Za-z0-9_]/g,
    '_'
  );
}

async function claimAutopilotAction(room, stage, action, now = Date.now()) {
  const roomId = String(room?.roomId || '').trim();
  if (!roomId) return false;
  const key = makeAutopilotActionKey(room, stage, action);
  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET autopilotActions.#key = :now, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(autopilotActions.#key)',
        ExpressionAttributeNames: {
          '#key': key,
        },
        ExpressionAttributeValues: {
          ':now': now,
        },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('autopilot_claim_action', err);
      const latest = getDemoRoomRecord(roomId) || room || createDemoRoomRecord(roomId);
      const existingActions =
        latest.autopilotActions && typeof latest.autopilotActions === 'object'
          ? { ...latest.autopilotActions }
          : {};
      if (Object.prototype.hasOwnProperty.call(existingActions, key)) return false;
      existingActions[key] = now;
      setDemoRoomRecord({
        ...latest,
        autopilotActions: existingActions,
        updatedAt: now,
      });
      return true;
    }
    throw err;
  }
}

async function tryAutoExtendRoomStage(room, bySec, now = Date.now()) {
  const roomId = String(room?.roomId || '').trim();
  const stage = String(room?.stage || DEFAULT_STAGE);
  const currentEndsAt = toStageMs(room?.stageEndsAt);
  const byMs = Math.max(1, Number(bySec || 0)) * 1000;
  if (!roomId || !currentEndsAt || stage === 'CLOSED') {
    return { updated: room, conflict: false };
  }
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET stageEndsAt = :nextEndsAt, updatedAt = :now',
        ConditionExpression: '#stage = :stage AND stageEndsAt = :currentEndsAt',
        ExpressionAttributeNames: {
          '#stage': 'stage',
        },
        ExpressionAttributeValues: {
          ':nextEndsAt': currentEndsAt + byMs,
          ':now': now,
          ':stage': stage,
          ':currentEndsAt': currentEndsAt,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'room_state', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      stage: updated.stage || stage,
    });
    return { updated, conflict: false };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { updated: null, conflict: true };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('autopilot_extend_stage', err);
      const updated = await updateRoom(roomId, {
        stageEndsAt: currentEndsAt + byMs,
      });
      return { updated, conflict: false };
    }
    throw err;
  }
}

async function tryAutoOpenVote(room, now = Date.now()) {
  const roomId = String(room?.roomId || '').trim();
  if (!roomId) return { updated: room, conflict: false };
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: [
          'SET voteOpen = :true',
          'voteTotal = :zero',
          'voteTallies = :emptyMap',
          'voteByUid = :emptyMap',
          'voteReadyUids = :emptyList',
          'voteReadyCount = :zero',
          'voteSubmittedUids = :emptyList',
          'voteSubmittedCount = :zero',
          'updatedAt = :now',
        ].join(', '),
        ConditionExpression: '#stage = :discovery AND (attribute_not_exists(voteOpen) OR voteOpen = :false)',
        ExpressionAttributeNames: {
          '#stage': 'stage',
        },
        ExpressionAttributeValues: {
          ':true': true,
          ':false': false,
          ':zero': 0,
          ':emptyMap': {},
          ':emptyList': [],
          ':now': now,
          ':discovery': 'DISCOVERY',
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'vote_update', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
    });
    await addMessage(roomId, {
      text: '🤖 Autopilot opened voting so each group can lock a topic before stage close.',
      phase: 'DISCOVERY',
      authorType: 'asema',
      personaIndex: 0,
    });
    return { updated, conflict: false };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { updated: null, conflict: true };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('autopilot_open_vote', err);
      const updated = await updateRoom(roomId, {
        voteOpen: true,
        voteTotal: 0,
        voteTallies: {},
        voteByUid: {},
        voteReadyUids: [],
        voteReadyCount: 0,
        voteSubmittedUids: [],
        voteSubmittedCount: 0,
      });
      await addMessage(roomId, {
        text: '🤖 Autopilot opened voting so each group can lock a topic before stage close.',
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
      return { updated, conflict: false };
    }
    throw err;
  }
}

async function tryAutoCloseVote(room, now = Date.now()) {
  const roomId = String(room?.roomId || '').trim();
  if (!roomId) return { updated: room, conflict: false };
  const topic = computeWinningTopic(
    room.voteTallies,
    room.topic || '',
    toVoteOptionMap(getVoteOptionsForRoom(room))
  );
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET voteOpen = :false, topic = :topic, updatedAt = :now',
        ConditionExpression: '#stage = :discovery AND voteOpen = :true',
        ExpressionAttributeNames: {
          '#stage': 'stage',
        },
        ExpressionAttributeValues: {
          ':false': false,
          ':true': true,
          ':topic': topic,
          ':now': now,
          ':discovery': 'DISCOVERY',
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'vote_update', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
    });
    await addMessage(roomId, {
      text: `🤖 Autopilot closed voting. Topic selected: **${updated.topic || topic || 'N/A'}**`,
      phase: 'DISCOVERY',
      authorType: 'asema',
      personaIndex: 0,
    });
    return { updated, conflict: false };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { updated: null, conflict: true };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('autopilot_close_vote', err);
      const updated = await updateRoom(roomId, {
        voteOpen: false,
        topic,
      });
      await addMessage(roomId, {
        text: `🤖 Autopilot closed voting. Topic selected: **${updated.topic || topic || 'N/A'}**`,
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
      return { updated, conflict: false };
    }
    throw err;
  }
}

async function runAutopilotForRoom(room, now = Date.now()) {
  const currentRoom = normalizeRoomShape(room || {});
  const roomId = String(currentRoom.roomId || '').trim();
  if (!roomId) return currentRoom;

  const config = normalizeAutopilotConfig(
    currentRoom.autopilot,
    AUTOPILOT_DEFAULT
  );
  if (!config.enabled) return currentRoom;

  let current = currentRoom;
  const stage = String(current.stage || DEFAULT_STAGE).toUpperCase();
  if (stage === 'CLOSED') return current;
  const endsAt = toStageMs(current.stageEndsAt);
  const msRemaining = endsAt > 0 ? endsAt - now : Number.MAX_SAFE_INTEGER;
  const participantAt = Number(current.lastParticipantMessageAt || 0);
  const inactivityMs =
    participantAt > 0 ? now - participantAt : Number.MAX_SAFE_INTEGER;
  const liveStage = !['LOBBY', 'CLOSED'].includes(stage);

  if (
    config.autoNudgeOnStuck &&
    liveStage &&
    inactivityMs >= config.stuckInactivitySec * 1000
  ) {
    const claimed = await claimAutopilotAction(
      current,
      stage,
      'stuck_intervention',
      now
    );
    if (claimed) {
      await addMessage(roomId, {
        text:
          '🤖 Autopilot intervention: pause for a 45-second reset. Each person shares one concrete sentence before moving forward.',
        phase: stage,
        authorType: 'asema',
        personaIndex: 0,
      });
      if (stage !== 'FINAL' && stage !== 'CLOSED') {
        const extendRes = await tryAutoExtendRoomStage(
          current,
          config.interventionExtendSec,
          now
        );
        if (extendRes.conflict) {
          current = await ensureRoom(roomId);
        } else if (extendRes.updated) {
          current = extendRes.updated;
        }
      }
      await writeAuditEvent({
        action: 'AUTOPILOT_STUCK_INTERVENTION',
        actor: {
          uid: 'autopilot',
          role: 'SYSTEM',
          siteId: current.siteId || parseRoomId(roomId).siteId,
          licenseId: current.licenseId || '',
          orgId: current.orgId || '',
        },
        target: {
          resourceType: 'ROOM',
          resourceId: roomId,
          roomId,
          siteId: current.siteId || parseRoomId(roomId).siteId,
          licenseId: current.licenseId || '',
          orgId: current.orgId || '',
        },
        details: {
          stage,
          inactivitySec: Math.floor(inactivityMs / 1000),
          extendSec: config.interventionExtendSec,
        },
      });
    }
  }

  if (
    config.autoNudgeOnStuck &&
    liveStage &&
    Number.isFinite(msRemaining) &&
    msRemaining > 0 &&
    msRemaining <= config.nudgeBeforeEndSec * 1000
  ) {
    const claimed = await claimAutopilotAction(current, stage, 'phase_nudge', now);
    if (claimed) {
      await addMessage(roomId, {
        text:
          '🤖 Autopilot reminder: you are entering the final minute of this phase. Pick one clear next action now.',
        phase: stage,
        authorType: 'asema',
        personaIndex: 0,
      });
      await writeAuditEvent({
        action: 'AUTOPILOT_PHASE_NUDGE',
        actor: {
          uid: 'autopilot',
          role: 'SYSTEM',
          siteId: current.siteId || parseRoomId(roomId).siteId,
          licenseId: current.licenseId || '',
          orgId: current.orgId || '',
        },
        target: {
          resourceType: 'ROOM',
          resourceId: roomId,
          roomId,
          siteId: current.siteId || parseRoomId(roomId).siteId,
          licenseId: current.licenseId || '',
          orgId: current.orgId || '',
        },
        details: {
          stage,
          nudgeBeforeEndSec: config.nudgeBeforeEndSec,
        },
      });
    }
  }

  if (config.autoVote && stage === 'DISCOVERY') {
    const shouldOpenVote =
      !current.voteOpen &&
      Number.isFinite(msRemaining) &&
      msRemaining > 0 &&
      msRemaining <= config.nudgeBeforeEndSec * 1000;
    if (shouldOpenVote) {
      const claimed = await claimAutopilotAction(
        current,
        stage,
        'vote_open',
        now
      );
      if (claimed) {
        const openRes = await tryAutoOpenVote(current, now);
        if (openRes.conflict) current = await ensureRoom(roomId);
        else if (openRes.updated) current = openRes.updated;
      }
    }

    const seats = getSeatCount(current);
    const voteSubmittedCount = Number(current.voteSubmittedCount || 0);
    const shouldCloseVote =
      !!current.voteOpen &&
      ((seats > 0 && voteSubmittedCount >= seats) ||
        (Number.isFinite(msRemaining) && msRemaining <= 5_000));
    if (shouldCloseVote) {
      const claimed = await claimAutopilotAction(
        current,
        stage,
        'vote_close',
        now
      );
      if (claimed) {
        const closeRes = await tryAutoCloseVote(current, now);
        if (closeRes.conflict) current = await ensureRoom(roomId);
        else if (closeRes.updated) current = closeRes.updated;
      }
    }
  }

  return current;
}

async function claimStageSideEffects(roomId, stage) {
  const normalizedStage = String(stage || '').trim().toUpperCase();
  if (!normalizedStage) return false;

  try {
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET greetedForStage.#stage = :now, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(greetedForStage.#stage)',
        ExpressionAttributeNames: {
          '#stage': normalizedStage,
        },
        ExpressionAttributeValues: {
          ':now': Date.now(),
        },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('stage_side_effects_claim', err);
      const room = getDemoRoomRecord(roomId) || createDemoRoomRecord(roomId);
      const greetedForStage =
        room.greetedForStage && typeof room.greetedForStage === 'object'
          ? { ...room.greetedForStage }
          : {};
      if (Object.prototype.hasOwnProperty.call(greetedForStage, normalizedStage)) {
        return false;
      }
      greetedForStage[normalizedStage] = Date.now();
      setDemoRoomRecord({
        ...room,
        greetedForStage,
        updatedAt: Date.now(),
      });
      return true;
    }
    throw err;
  }
}

async function emitStageSideEffectsOnce(room) {
  try {
    const stage = room?.stage || DEFAULT_STAGE;
    const roomId = room?.roomId;
    if (!roomId || stage === 'CLOSED') return;

    const claimed = await claimStageSideEffects(roomId, stage);
    if (!claimed) return;

    await addMessage(roomId, {
      text: stageInstructionText(stage),
      phase: stage,
      authorType: 'asema',
      personaIndex: 0,
    });

    if (stage === 'DISCOVERY') {
      try {
        const aiPolicy = await resolveAiPolicyForRoom(room);
        const personalized = await Asema.greet(stage, room.topic || '', {
          ...buildAsemaOptions(room, aiPolicy),
        });
        await addMessage(roomId, {
          text: personalized,
          phase: stage,
          authorType: 'asema',
          personaIndex: 0,
        });
      } catch (err) {
        console.error('[stage side-effects DISCOVERY greet] error', err);
      }
    }

    if (stage === 'EDITING') {
      const draft = (room.draftText || '').trim();
      if (draft) {
        await addMessage(roomId, {
          text: `🧾 **Latest Draft (v${Number(room.draftVersion || 0)})**\n\n${draft}`,
          phase: 'EDITING',
          authorType: 'asema',
          personaIndex: 0,
        });
      } else {
        await addMessage(roomId, {
          text: 'I don’t see a saved draft yet — generate one in ROUGH_DRAFT first.',
          phase: 'EDITING',
          authorType: 'asema',
          personaIndex: 0,
        });
      }
    }

    if (stage === 'FINAL') {
      const draft = (room.draftText || '').trim();
      const version = Number(room.draftVersion || 0);
      await addMessage(roomId, {
        text:
          `🏁 **FINAL STAGE**\n` +
          `Make your last edits to the draft below. When YOU are finished, type **done** (or **submit**).\n\n` +
          `🧾 **Draft (v${version})**\n\n${draft || '(No draft saved yet.)'}`,
        phase: 'FINAL',
        authorType: 'asema',
        personaIndex: 0,
      });
    }
  } catch (err) {
    console.error('[emitStageSideEffectsOnce] error:', err);
  }
}

async function tryInitializeRoomStageEndsAt(room, now) {
  const roomId = room.roomId;
  const stage = room.stage || DEFAULT_STAGE;
  const stageEndsAt = now + getRoomStageDurationMs(room, stage);

  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET stageEndsAt = :endsAt, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(stageEndsAt) OR stageEndsAt = :zero',
        ExpressionAttributeValues: {
          ':endsAt': stageEndsAt,
          ':now': now,
          ':zero': 0,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'room_state', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      stage: updated.stage || DEFAULT_STAGE,
    });
    return { updated, conflict: false };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { updated: null, conflict: true };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('stage_init_ends_at', err);
      const updated = await updateRoom(roomId, { stageEndsAt });
      return { updated, conflict: false };
    }
    throw err;
  }
}

async function tryAdvanceNonFinalStage(room, now) {
  const roomId = room.roomId;
  const currentStage = room.stage || DEFAULT_STAGE;
  const currentEndsAt = toStageMs(room.stageEndsAt);
  if (!currentEndsAt || now < currentEndsAt) {
    return { updated: room, advanced: false, conflict: false };
  }

  const phaseGate = evaluatePhaseExitGate(room, currentStage);
  if (!phaseGate.ok) {
    await maybePostPhaseGateReminder(room, phaseGate).catch(() => null);
    const deferredEndsAt = now + 60_000;
    try {
      const { Attributes } = await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression: 'SET stageEndsAt = :deferredEndsAt, updatedAt = :now',
          ConditionExpression: '#stage = :currentStage AND stageEndsAt = :currentEndsAt',
          ExpressionAttributeNames: {
            '#stage': 'stage',
          },
          ExpressionAttributeValues: {
            ':deferredEndsAt': deferredEndsAt,
            ':now': now,
            ':currentStage': currentStage,
            ':currentEndsAt': currentEndsAt,
          },
          ReturnValues: 'ALL_NEW',
        })
      );
      const updated = normalizeRoomShape(Attributes || room);
      publishRoomEvent(roomId, 'room_state', {
        siteId: updated.siteId || parseRoomId(roomId).siteId,
        stage: updated.stage || DEFAULT_STAGE,
      });
      return {
        updated,
        advanced: false,
        conflict: false,
        gated: true,
        phaseGate,
      };
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        return { updated: null, advanced: false, conflict: true, gated: true, phaseGate };
      }
      if (shouldUseDemoFallback(err)) {
        logDemoFallback('stage_gate_hold', err);
        const updated = await updateRoom(roomId, { stageEndsAt: deferredEndsAt });
        return {
          updated,
          advanced: false,
          conflict: false,
          gated: true,
          phaseGate,
        };
      }
      throw err;
    }
  }

  const nextStage = advanceStageVal(currentStage);
  if (!nextStage || nextStage === currentStage) {
    return { updated: room, advanced: false, conflict: false };
  }
  const nextEndsAt = now + getRoomStageDurationMs(room, nextStage);

  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: 'SET #stage = :nextStage, stageEndsAt = :nextEndsAt, updatedAt = :now',
        ConditionExpression: '#stage = :currentStage AND stageEndsAt = :currentEndsAt',
        ExpressionAttributeNames: {
          '#stage': 'stage',
        },
        ExpressionAttributeValues: {
          ':nextStage': nextStage,
          ':nextEndsAt': nextEndsAt,
          ':now': now,
          ':currentStage': currentStage,
          ':currentEndsAt': currentEndsAt,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'room_state', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      stage: updated.stage || DEFAULT_STAGE,
    });
    return { updated, advanced: true, conflict: false };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { updated: null, advanced: false, conflict: true };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('stage_advance', err);
      const updated = await updateRoom(roomId, {
        stage: nextStage,
        stageEndsAt: nextEndsAt,
      });
      return { updated, advanced: true, conflict: false };
    }
    throw err;
  }
}

async function tryCloseFinalByTimeout(room, now) {
  const roomId = room.roomId;
  const stage = room.stage || DEFAULT_STAGE;
  const endsAt = toStageMs(room.stageEndsAt);
  if (stage !== 'FINAL' || !endsAt || now < endsAt) {
    return { closed: false, conflict: false, updated: room };
  }

  const cerGate = evaluateEvidenceBoardCerGate(room);
  if (!cerGate.ok) {
    await maybePostCerGateReminder(room, cerGate);
    return { closed: false, conflict: false, updated: room, blocked: 'cer_required', cerGate };
  }

  const finalAbstract = (room.draftText || '').trim();
  const closedAt = now;

  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: [
          'SET #stage = :closed',
          'inputLocked = :true',
          'finalCompletedAt = :closedAt',
          'finalAbstract = :finalAbstract',
          'closedReason = :reason',
          'closedAt = :closedAt',
          'updatedAt = :closedAt',
        ].join(', '),
        ConditionExpression: '#stage = :final AND stageEndsAt = :endsAt',
        ExpressionAttributeNames: {
          '#stage': 'stage',
        },
        ExpressionAttributeValues: {
          ':closed': 'CLOSED',
          ':true': true,
          ':closedAt': closedAt,
          ':finalAbstract': finalAbstract,
          ':reason': 'timeout',
          ':final': 'FINAL',
          ':endsAt': endsAt,
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    const updated = normalizeRoomShape(Attributes || room);
    publishRoomEvent(roomId, 'room_state', {
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      stage: updated.stage || 'CLOSED',
    });
    await appendDecisionLog(roomId, {
      type: 'ROOM_CLOSED',
      stage: 'CLOSED',
      label: 'Room closed (timeout)',
      actorUid: '(timer)',
      details: {
        reason: 'timeout',
        closedAt,
      },
    }).catch(() => null);

    await addMessage(roomId, {
      text: '⏰ **Time’s up — closing the room now.**',
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });
    if (finalAbstract) {
      await addMessage(roomId, {
        text: `**Final Abstract**\n\n${finalAbstract}`,
        phase: 'FINAL',
        authorType: 'asema',
        personaIndex: 0,
      });
    }

    try {
      const closedAtRoom = `${String(closedAt).padStart(13, '0')}#${updated.roomId}`;
      await ddbDoc.send(
        new PutCommand({
          TableName: TABLES.gallery,
          Item: {
            siteId: updated.siteId,
            closedAtRoom,
            licenseId: normalizedLicenseId(updated.licenseId || updated.siteId || ''),
            orgId: normalizedOrgId(updated.orgId || '', updated.licenseId || ''),
            roomId: updated.roomId,
            closedAt,
            index: updated.index,
            topic: updated.topic || '',
            abstract: updated.finalAbstract || '',
            closedBy: '(timer)',
          },
        })
      );
    } catch (err) {
      console.warn('[gallery timeout close] put skipped:', err?.message || err);
    }

    await writeAuditEvent({
      action: 'ROOM_CLOSED',
      actor: {
        uid: '(timer)',
        role: 'SYSTEM',
        licenseId: updated.licenseId || '',
        orgId: updated.orgId || '',
        siteId: updated.siteId || '',
      },
      target: {
        resourceType: 'ROOM',
        resourceId: roomId,
        roomId,
        siteId: updated.siteId || '',
        licenseId: updated.licenseId || '',
        orgId: updated.orgId || '',
      },
      details: {
        reason: 'timeout',
        closedAt,
      },
    });

    return { closed: true, conflict: false, updated };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { closed: false, conflict: true, updated: null };
    }
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('stage_close_final', err);
      const updated = await updateRoom(roomId, {
        stage: 'CLOSED',
        inputLocked: true,
        finalCompletedAt: closedAt,
        finalAbstract,
        closedReason: 'timeout',
        closedAt,
      });
      await addMessage(roomId, {
        text: '⏰ **Time’s up — closing the room now.**',
        phase: 'FINAL',
        authorType: 'asema',
        personaIndex: 0,
      });
      if (finalAbstract) {
        await addMessage(roomId, {
          text: `**Final Abstract**\n\n${finalAbstract}`,
          phase: 'FINAL',
          authorType: 'asema',
          personaIndex: 0,
        });
      }
      return { closed: true, conflict: false, updated };
    }
    throw err;
  }
}

async function advanceRoomTimeline(roomId, { room = null, now = Date.now(), maxTransitions = 6 } = {}) {
  let current = room ? normalizeRoomShape(room) : await ensureRoom(roomId);

  for (let i = 0; i < maxTransitions; i++) {
    current = await runAutopilotForRoom(current, now);
    const stage = current.stage || DEFAULT_STAGE;
    if (stage === 'CLOSED') return current;

    const endsAt = toStageMs(current.stageEndsAt);
    if (!endsAt) {
      const initRes = await tryInitializeRoomStageEndsAt(current, now);
      if (initRes.conflict) {
        current = await ensureRoom(roomId);
        continue;
      }
      current = initRes.updated || current;
      await emitStageSideEffectsOnce(current);
      return current;
    }

    if (stage === 'FINAL') {
      await emitStageSideEffectsOnce(current);
      const closeRes = await tryCloseFinalByTimeout(current, now);
      if (closeRes.conflict) {
        current = await ensureRoom(roomId);
        continue;
      }
      return closeRes.updated || current;
    }

    if (now < endsAt) {
      await emitStageSideEffectsOnce(current);
      return current;
    }

    const advanceRes = await tryAdvanceNonFinalStage(current, now);
    if (advanceRes.conflict) {
      current = await ensureRoom(roomId);
      continue;
    }
    current = advanceRes.updated || current;
    await emitStageSideEffectsOnce(current);
    if (!advanceRes.advanced) return current;
  }

  return current;
}

async function advanceSiteTimeline(siteIdRaw, licenseId, orgId = '') {
  const siteId = normalizedSiteId(siteIdRaw);
  if (!siteId) return;
  const roomConfig = await resolveWorkshopRoomConfig({ siteId, licenseId, orgId });
  const maxRooms = toPositiveInt(roomConfig?.roomsPerSite, 5, { min: 1, max: MAX_ROOMS_PER_SITE });
  const now = Date.now();
  for (let i = 1; i <= maxRooms; i++) {
    const roomId = `${siteId}-${i}`;
    // eslint-disable-next-line no-await-in-loop
    await advanceRoomTimeline(roomId, { now });
  }
}

// ---------- Room Assignment (capacity driven by workshop config) ----------
async function resolveWorkshopRoomConfig({ siteId, licenseId, orgId = '' } = {}) {
  const normalizedSite = normalizedSiteId(siteId);
  const normalizedLicense = normalizedLicenseId(licenseId || normalizedSite);
  const normalizedOrg = normalizedOrgId(orgId, normalizedLicense);
  if (!normalizedSite) {
    return {
      roomsPerSite: 5,
      seatLimitPerRoom: DEFAULT_SEAT_LIMIT_PER_ROOM,
      workshop: null,
      licenseStatus: 'ACTIVE',
      expectedUsers: DEFAULT_EXPECTED_USERS,
      activeUserCap: DEFAULT_EXPECTED_USERS,
    };
  }

  try {
    const workshop = await ensureWorkshopConfig({
      licenseId: normalizedLicense,
      orgId: normalizedOrg,
      siteIds: [normalizedSite],
    });
    return {
      roomsPerSite: toPositiveInt(workshop?.roomsPerSite, 5, {
        min: 1,
        max: MAX_ROOMS_PER_SITE,
      }),
      seatLimitPerRoom: toPositiveInt(
        workshop?.seatLimitPerRoom,
        DEFAULT_SEAT_LIMIT_PER_ROOM,
        { min: 1, max: MAX_SEAT_LIMIT_PER_ROOM }
      ),
      workshop,
      licenseStatus: String(workshop?.licenseStatus || 'ACTIVE').toUpperCase(),
      expectedUsers: toPositiveInt(workshop?.expectedUsers, DEFAULT_EXPECTED_USERS, {
        min: 1,
        max: 20_000,
      }),
      activeUserCap: toPositiveInt(
        workshop?.activeUserCap,
        toPositiveInt(workshop?.expectedUsers, DEFAULT_EXPECTED_USERS, {
          min: 1,
          max: 20_000,
        }),
        { min: 1, max: 50_000 }
      ),
    };
  } catch (err) {
    console.warn('[rooms] workshop config unavailable, using defaults', err?.message || err);
    return {
      roomsPerSite: 5,
      seatLimitPerRoom: DEFAULT_SEAT_LIMIT_PER_ROOM,
      workshop: null,
      licenseStatus: 'ACTIVE',
      expectedUsers: DEFAULT_EXPECTED_USERS,
      activeUserCap: DEFAULT_EXPECTED_USERS,
    };
  }
}

async function tryAssignSeat({ roomId, uid, maxSeats = null }) {
  const values = {
    ':emptySeats': [],
    ':emptySeatUids': [],
    ':newSeat': [{ uid }],
    ':newUid': [uid],
    ':uid': uid,
    ':now': Date.now(),
  };

  const conditionParts = ['attribute_not_exists(seatUids) OR NOT contains(seatUids, :uid)'];
  if (Number.isFinite(Number(maxSeats))) {
    values[':maxSeats'] = Number(maxSeats);
    conditionParts.push('attribute_not_exists(seatUids) OR size(seatUids) < :maxSeats');
  }

  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: [
          'SET seats = list_append(if_not_exists(seats, :emptySeats), :newSeat)',
          'seatUids = list_append(if_not_exists(seatUids, :emptySeatUids), :newUid)',
          'updatedAt = :now',
        ].join(', '),
        ConditionExpression: conditionParts.map((p) => `(${p})`).join(' AND '),
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );

    const room = normalizeRoomShape(Attributes);
    publishRoomEvent(roomId, 'room_state', {
      siteId: room.siteId || parseRoomId(roomId).siteId,
      stage: room.stage || DEFAULT_STAGE,
    });
    return room;
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('room_assign_seat', err);
      const room = getDemoRoomRecord(roomId) || createDemoRoomRecord(roomId);
      const seatUids = Array.isArray(room.seatUids)
        ? room.seatUids.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      if (seatUids.includes(uid)) return setDemoRoomRecord(room);
      if (Number.isFinite(Number(maxSeats)) && seatUids.length >= Number(maxSeats)) {
        return null;
      }
      const seats = Array.isArray(room.seats) ? room.seats.slice() : [];
      seats.push({ uid });
      seatUids.push(uid);
      const next = setDemoRoomRecord({
        ...room,
        seats,
        seatUids,
        updatedAt: Date.now(),
      });
      publishRoomEvent(roomId, 'room_state', {
        siteId: next.siteId || parseRoomId(roomId).siteId,
        stage: next.stage || DEFAULT_STAGE,
      });
      return next;
    }
    if (err?.name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw err;
  }
}

async function assignRoomForUser(
  siteIdRaw,
  uid,
  { maxRooms = 5, maxSeats = DEFAULT_SEAT_LIMIT_PER_ROOM } = {}
) {
  const siteId = String(siteIdRaw || '').trim().toUpperCase();
  if (!siteId) throw new Error('siteId required');

  const MAX_ROOMS = toPositiveInt(maxRooms, 5, { min: 1, max: MAX_ROOMS_PER_SITE });
  const MAX_SEATS = toPositiveInt(maxSeats, DEFAULT_SEAT_LIMIT_PER_ROOM, {
    min: 1,
    max: MAX_SEAT_LIMIT_PER_ROOM,
  });
  const rooms = [];

  for (let i = 1; i <= MAX_ROOMS; i++) {
    const roomId = `${siteId}-${i}`;
    const room = await ensureRoom(roomId);
    const seatUids = Array.isArray(room.seatUids) ? room.seatUids : [];

    if (seatUids.includes(uid)) {
      return {
        roomId,
        index: room.index,
        siteId,
        seats: seatUids.length,
      };
    }

    rooms.push({
      roomId,
      index: room.index,
      seats: seatUids.length,
    });
  }

  // Try strict assignment first (cap at MAX_SEATS)
  for (const room of rooms) {
    if (room.seats >= MAX_SEATS) continue;
    const updated = await tryAssignSeat({
      roomId: room.roomId,
      uid,
      maxSeats: MAX_SEATS,
    });
    if (!updated) continue;
    return {
      roomId: updated.roomId,
      index: updated.index,
      siteId,
      seats: getSeatCount(updated),
    };
  }

  // Overflow fallback: allow one more seat but still enforce idempotency.
  const overflowRoom = rooms[rooms.length - 1];
  const overflowUpdated = await tryAssignSeat({
    roomId: overflowRoom.roomId,
    uid,
    maxSeats: null,
  });

  if (!overflowUpdated) {
    const latest = await ensureRoom(overflowRoom.roomId);
    if (Array.isArray(latest.seatUids) && latest.seatUids.includes(uid)) {
      return {
        roomId: latest.roomId,
        index: latest.index,
        siteId,
        seats: getSeatCount(latest),
      };
    }
    throw new Error('assign_conflict');
  }

  return {
    roomId: overflowUpdated.roomId,
    index: overflowUpdated.index,
    siteId,
    seats: getSeatCount(overflowUpdated),
  };
}

async function getSiteSeatStats(siteIdRaw, uid, maxRooms = 5) {
  const siteId = String(siteIdRaw || '').trim().toUpperCase();
  const MAX_ROOMS = toPositiveInt(maxRooms, 5, { min: 1, max: MAX_ROOMS_PER_SITE });
  let assignedSeats = 0;
  let existingAssignment = null;
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const roomId = `${siteId}-${i}`;
    // eslint-disable-next-line no-await-in-loop
    const room = await ensureRoom(roomId);
    const seatUids = Array.isArray(room.seatUids) ? room.seatUids : [];
    assignedSeats += seatUids.length;
    if (!existingAssignment && uid && seatUids.includes(uid)) {
      existingAssignment = {
        roomId,
        index: room.index,
        siteId,
        seats: seatUids.length,
      };
    }
  }
  return { assignedSeats, existingAssignment };
}

app.post('/rooms/assign', requireAuth, async (req, res) => {
  try {
    const { siteId } = req.body || {};
    if (!siteId) {
      return res.status(400).json({ error: 'siteId required' });
    }
    const requestedSite = normalizedSiteId(siteId);
    const tokenSite = normalizedSiteId(req.user.siteId);
    if (tokenSite && tokenSite !== requestedSite) {
      return res.status(403).json({ error: 'site_forbidden' });
    }
    const tenantSites = sanitizeSiteIds(req.tenantWorkshop?.siteIds, []);
    if (tenantSites.length && !tenantSites.includes(requestedSite)) {
      return res.status(403).json({ error: 'tenant_site_mismatch' });
    }
    const roomConfig = await resolveWorkshopRoomConfig({
      siteId: requestedSite,
      licenseId: req.user.licenseId,
      orgId: req.user.orgId,
    });
    if (String(roomConfig.licenseStatus || 'ACTIVE') !== 'ACTIVE') {
      const status =
        String(roomConfig.licenseStatus || '').toUpperCase() === 'SUSPENDED' ? 423 : 402;
      return res.status(status).json({ error: `license_${String(roomConfig.licenseStatus || '').toLowerCase()}` });
    }
    const entitlementCheck = await enforceRuntimeLicenseEntitlements({
      role: req.user.role,
      licenseId: req.user.licenseId,
      orgId: req.user.orgId,
      siteId: requestedSite,
      workshop: roomConfig,
      automate: true,
      bypassAdmin: false,
    });
    if (!entitlementCheck.ok) {
      return res.status(entitlementCheck.statusCode || 403).json({
        error: entitlementCheck.error || 'license_forbidden',
        usageCap: Number(entitlementCheck.usageCap || 0) || undefined,
        meteredUnits: Number(entitlementCheck.meteredUnits || 0) || undefined,
        overageUnits: Number(entitlementCheck.overageUnits || 0) || undefined,
      });
    }

    // Enforce per-site assignment checks and global seat caps before assigning a new seat.
    const { assignedSeats, existingAssignment } = await getSiteSeatStats(
      requestedSite,
      req.user.uid,
      roomConfig.roomsPerSite
    );
    const globalSeatCap = Math.max(
      0,
      Number(
        entitlementCheck.license?.seatCap ||
          roomConfig.seatCap ||
          roomConfig.expectedUsers ||
          DEFAULT_EXPECTED_USERS
      ) || 0
    );
    const globallyAssignedSeats = Math.max(
      0,
      Number(entitlementCheck.usage?.assignedSeats || 0) || 0
    );
    if (!existingAssignment && globalSeatCap > 0 && globallyAssignedSeats >= globalSeatCap) {
      return res.status(429).json({
        error: 'license_seat_cap_reached',
        seatCap: globalSeatCap,
        assignedSeats: globallyAssignedSeats,
      });
    }
    if (!existingAssignment) {
      const activeCapCheck = await enforceLicenseActiveUserCap({
        licenseId: req.user.licenseId,
        activeUserCap: roomConfig.activeUserCap,
        uid: req.user.uid,
      });
      if (!activeCapCheck.ok) {
        return res.status(429).json({
          error: activeCapCheck.error,
          activeUsers: activeCapCheck.activeUsers,
          activeUserCap: activeCapCheck.cap,
        });
      }
    }
    const assigned =
      existingAssignment ||
      (await assignRoomForUser(requestedSite, req.user.uid, {
        maxRooms: roomConfig.roomsPerSite,
        maxSeats: roomConfig.seatLimitPerRoom,
      }));
    return res.json({
      ...assigned,
      seatLimitPerRoom: roomConfig.seatLimitPerRoom,
      roomsPerSite: roomConfig.roomsPerSite,
      activeUserCap: roomConfig.activeUserCap,
      seatCap: globalSeatCap,
      assignedSeatsGlobal: globallyAssignedSeats,
      assignedSeatsSite: assignedSeats,
    });
  } catch (e) {
    console.error('[/rooms/assign] error', e);
    return res.status(500).json({ error: 'assign_failed' });
  }
});

// Legacy compatibility shim: progression is handled by advanceRoomTimeline().
stageEngine = {
  touch: () => {},
  start: () => {},
  stop: () => {},
};

// ---------- Health ----------
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    region: AWS_REGION,
    time: new Date().toISOString(),
    demoModeFallback: DEMO_MODE_FALLBACK,
  })
);
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    region: AWS_REGION,
    time: new Date().toISOString(),
    demoModeFallback: DEMO_MODE_FALLBACK,
  })
);
app.get('/health/dependencies', async (_req, res) => {
  const health = await refreshDependencyHealth();
  return res.json({
    ok: true,
    time: new Date().toISOString(),
    demoModeFallback: DEMO_MODE_FALLBACK,
    dependencies: {
      api: health.api,
      aws: health.aws,
      openai: health.openai,
    },
  });
});
app.get('/metrics', (_req, res) => {
  const routeTop = Array.from(runtimeMetrics.byRoute.entries())
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 100)
    .map(([route, count]) => ({ route, count }));
  const byStatus = Object.fromEntries(Array.from(runtimeMetrics.byStatus.entries()));
  const byMethod = Object.fromEntries(Array.from(runtimeMetrics.byMethod.entries()));
  res.json({
    requestsTotal: runtimeMetrics.requestsTotal,
    errors5xx: runtimeMetrics.errors5xx,
    byStatus,
    byMethod,
    topRoutes: routeTop,
    emittedAt: new Date().toISOString(),
  });
});
app.get('/version', (_req, res) =>
  res.json({
    commit: process.env.GIT_COMMIT || null,
    build: process.env.BUILD_ID || null,
    time: new Date().toISOString(),
  })
);

// ---------- Presenter: list rooms ----------
app.get(
  '/presenter/rooms',
  requireAuth,
  requirePresenter,
  requirePresenterSiteMatchFromQuery,
  async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) return res.json({ rooms: [] });

  const roomConfig = await resolveWorkshopRoomConfig({
    siteId,
    licenseId: req.user.licenseId,
    orgId: req.user.orgId,
  });

  const out = [];
  const MAX_ROOMS = roomConfig.roomsPerSite;
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const id = `${siteId}-${i}`;
    const r = await advanceRoomTimeline(id);
    const phaseExitGate = evaluatePhaseExitGate(r, r.stage || DEFAULT_STAGE);
    const qualityScorecard = buildRoomQualityScorecard(r);
    const privateDraftQueueCount = serializePrivateDraftState(r, '').submissions.length;
    const draftApprovalRequired = getSeatCount(r) >= 4 ? 2 : 1;
    const approvalUids = Array.isArray(r.draftApprovedByUids)
      ? r.draftApprovedByUids.map((uid) => String(uid || '').trim()).filter(Boolean)
      : [];
    const seatUids = roomSeatUids(r);
    const approvalRoster = seatUids.map((uid, index) => ({
      uid,
      label: `Seat ${index + 1}`,
      approved: approvalUids.includes(uid),
    }));
    out.push({
      id: r.roomId,
      index: r.index,
      stage: r.stage,
      stageEndsAt: toStageMs(r.stageEndsAt),
      inputLocked: !!r.inputLocked,
      topic: r.topic || '',
      seats: getSeatCount(r),
      vote: {
        open: !!r.voteOpen,
        total: Number(r.voteTotal || 0),
        tallies: r.voteTallies || {},
      },
      autopilot: normalizeAutopilotConfig(r.autopilot, AUTOPILOT_DEFAULT),

      // draft + final preview
      draftVersion: Number(r.draftVersion || 0),
      draftUpdatedAt: r.draftUpdatedAt || null,
      finalAbstract: r.finalAbstract || '',
      closedAt: r.closedAt || null,
      closedReason: r.closedReason || null,
      phaseExitGate,
      qualityScorecard,
      privateDraftQueueCount,
      draftApproval: {
        approvedCount: approvalUids.length,
        requiredApprovals: draftApprovalRequired,
        approvedVersion: Number(r.draftApprovedVersion || 0),
        draftVersion: Number(r.draftVersion || 0),
        approvedByUids: approvalUids,
        roster: approvalRoster,
      },
      decisionLogCount: Array.isArray(r.decisionLog) ? r.decisionLog.length : 0,
      aiFallback: serializeAiFallbackState(r, r.stage || DEFAULT_STAGE),
      lastParticipantMessageAt: Number(r.lastParticipantMessageAt || 0) || 0,
    });

  }
    await writeAuditEvent({
      action: 'PRESENTER_ROOMS_READ',
      actor: req.user,
      target: {
        resourceType: 'ROOM',
        resourceId: siteId,
        siteId,
        licenseId: req.user.licenseId,
        orgId: req.user.orgId,
      },
      details: { roomsReturned: out.length },
    });
    res.json({ rooms: out });
  }
);

// Presenter gallery (all closed abstracts for site)
app.get(
  '/presenter/gallery',
  requireAuth,
  requirePresenter,
  requirePresenterSiteMatchFromQuery,
  async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) return res.json({ items: [] });
  const roomConfig = await resolveWorkshopRoomConfig({
    siteId,
    licenseId: req.user.licenseId,
    orgId: req.user.orgId,
  });

  let items = [];
  // If TABLES.gallery exists with PK=siteId, query it; else fallback to rooms
  try {
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.gallery,
        KeyConditionExpression: 'siteId = :s',
        ExpressionAttributeValues: { ':s': siteId },
        ScanIndexForward: false,
        Limit: 50,
      })
    );
    items = Items || [];
  } catch (e) {
    items = [];
    for (let i = 1; i <= roomConfig.roomsPerSite; i++) {
      const r = await ensureRoom(`${siteId}-${i}`);
      if (r.stage === 'CLOSED' && (r.finalAbstract || '').trim()) {
        items.push({
          siteId,
          roomId: r.roomId,
          closedAt: r.closedAt || r.finalCompletedAt || null,
          index: r.index,
          topic: r.topic || '',
          abstract: r.finalAbstract || '',
        });
      }
    }
  }
    await writeAuditEvent({
      action: 'PRESENTER_GALLERY_READ',
      actor: req.user,
      target: {
        resourceType: 'GALLERY',
        resourceId: siteId,
        siteId,
        licenseId: req.user.licenseId,
        orgId: req.user.orgId,
      },
      details: { itemsReturned: Array.isArray(items) ? items.length : 0 },
    });
    return res.json({ items });
  }
);

app.get(
  '/presenter/autopilot',
  requireAuth,
  requirePresenter,
  requirePresenterSiteMatchFromQuery,
  async (req, res) => {
    try {
      const siteId = normalizedSiteId(req.query?.siteId || '');
      if (!siteId) return res.status(400).json({ error: 'siteId required' });
      const room = await ensureRoom(`${siteId}-1`);
      const config = normalizeAutopilotConfig(room.autopilot, AUTOPILOT_DEFAULT);
      return res.json({
        ok: true,
        siteId,
        autopilot: config,
        roomId: room.roomId,
      });
    } catch (err) {
      console.error('[/presenter/autopilot GET] error:', err);
      return res.status(500).json({ error: 'presenter_autopilot_fetch_failed' });
    }
  }
);

app.put(
  '/presenter/autopilot',
  requireAuth,
  requirePresenter,
  requirePresenterSiteMatchFromQuery,
  async (req, res) => {
    try {
      const siteId = normalizedSiteId(req.query?.siteId || '');
      if (!siteId) return res.status(400).json({ error: 'siteId required' });

      const seedRoom = await ensureRoom(`${siteId}-1`);
      const currentConfig = normalizeAutopilotConfig(
        seedRoom.autopilot,
        AUTOPILOT_DEFAULT
      );
      const nextConfig = normalizeAutopilotConfig(req.body || {}, currentConfig);
      const resetActions = req.body?.resetActions === true;
      const roomConfig = await resolveWorkshopRoomConfig({
        siteId,
        licenseId: req.user.licenseId,
        orgId: req.user.orgId,
      });
      const maxRooms = toPositiveInt(roomConfig?.roomsPerSite, 5, {
        min: 1,
        max: MAX_ROOMS_PER_SITE,
      });

      let updatedRooms = 0;
      for (let i = 1; i <= maxRooms; i += 1) {
        const roomId = `${siteId}-${i}`;
        // eslint-disable-next-line no-await-in-loop
        await ensureRoom(roomId);
        // eslint-disable-next-line no-await-in-loop
        await updateRoom(roomId, {
          autopilot: nextConfig,
          ...(resetActions ? { autopilotActions: {} } : {}),
        });
        updatedRooms += 1;
      }

      await writeAuditEvent({
        action: 'PRESENTER_AUTOPILOT_UPDATE',
        actor: req.user,
        target: {
          resourceType: 'SITE',
          resourceId: siteId,
          siteId,
          licenseId: req.user.licenseId,
          orgId: req.user.orgId,
        },
        details: {
          autopilot: nextConfig,
          resetActions,
          updatedRooms,
        },
      });

      return res.json({
        ok: true,
        siteId,
        autopilot: nextConfig,
        updatedRooms,
      });
    } catch (err) {
      console.error('[/presenter/autopilot PUT] error:', err);
      return res.status(500).json({ error: 'presenter_autopilot_update_failed' });
    }
  }
);

// ---------- Room state & messages ----------
app.get('/rooms/:roomId/state', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const r = req.room || (await ensureRoom(roomId));
  const typing = cleanRoomPresence(roomId);
  const cerGate = evaluateEvidenceBoardCerGate(r);
  const phaseExitGate = evaluatePhaseExitGate(r, r.stage || DEFAULT_STAGE);
  const roleRotation = buildRoleRotationState(r, r.stage || DEFAULT_STAGE, req.user?.uid || '');
  const privateDraftState = serializePrivateDraftState(r, req.user?.uid || '');
  const decisionLog = serializeDecisionLog(r, { limit: 60 });
  const qualityScorecard = buildRoomQualityScorecard(r);
  const aiFallback = serializeAiFallbackState(r, r.stage || DEFAULT_STAGE);

  res.json({
    id: r.roomId,
    siteId: r.siteId,
    index: r.index,
    stage: r.stage || 'LOBBY',
    stageEndsAt: toStageMs(r.stageEndsAt),
    stageDurationSec:
      (r.stage || 'LOBBY') === 'CLOSED'
        ? 0
        : Math.floor(getRoomStageDurationMs(r, r.stage || 'LOBBY') / 1000),
    inputLocked: !!r.inputLocked,
    topic: r.topic || '',
    ideaSummary: r.ideaSummary || '',

    seats: getSeatCount(r),
    finalReadyCount: Number(r.finalReadyCount || 0),
    finalCompletedAt: r.finalCompletedAt || null,

    // living draft meta + final abstract
    draftVersion: Number(r.draftVersion || 0),
    draftUpdatedAt: r.draftUpdatedAt || null,
    finalAbstract: r.finalAbstract || '',
    closedAt: r.closedAt || null,
    closedReason: r.closedReason || null,
    workshopMode: r.workshopMode || '',
    aiBehavior: r.aiBehavior || '',
    assistantPersona: r.assistantPersona || '',
    autopilot: normalizeAutopilotConfig(r.autopilot, AUTOPILOT_DEFAULT),
    cerGate,
    phaseExitGate,
    roleRotation,
    draftApproval: {
      approvedByUids: Array.isArray(r.draftApprovedByUids) ? r.draftApprovedByUids : [],
      approvedCount: Array.isArray(r.draftApprovedByUids) ? r.draftApprovedByUids.length : 0,
      requiredApprovals: getSeatCount(r) >= 4 ? 2 : 1,
      approvedVersion: Number(r.draftApprovedVersion || 0),
      approvedAt: Number(r.draftApprovedAt || 0) || 0,
    },
    privateDraft: privateDraftState.mine,
    sharedDraftSubmissions: privateDraftState.submissions,
    decisionLog,
    qualityScorecard,
    aiFallback,
    shareLinkCount: Object.keys(r.shareLinks || {}).length,
    topicOptions: Array.isArray(r.topicOptions) ? r.topicOptions : [],
    phasePlan: Array.isArray(r.phasePlan) ? r.phasePlan : [],
    typing,
  });
});

app.get('/rooms/:roomId/canvas', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const room = req.room || (await ensureRoom(roomId));
  const phase = normalizeCanvasPhase(req.query?.phase || room.stage || 'DISCOVERY');
  const canvas = getPhaseCanvas(room, phase);
  return res.json({ ok: true, roomId, phase, canvas });
});

app.put('/rooms/:roomId/canvas', requireAuth, requireRoomAccess, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = req.room || (await ensureRoom(roomId));
    const phase = normalizeCanvasPhase(req.body?.phase || room.stage || 'DISCOVERY');
    const existing = getPhaseCanvas(room, phase);
    const section = String(req.body?.section || '').trim().toLowerCase();
    const content = normalizeCanvasText(req.body?.content || '', 10_000);
    const sectionAlias = {
      ideas: 'stickyNotes',
      stickynotes: 'stickyNotes',
      structure: 'outlineMap',
      outlinemap: 'outlineMap',
      evidenceboard: 'evidenceBoard',
      map: 'narrativeMap',
      narrativemap: 'narrativeMap',
    };
    let partial = {};
    const canonicalSection = sectionAlias[section] || '';
    if (canonicalSection) {
      partial = { [canonicalSection]: content };
    } else {
      partial = {
        stickyNotes: req.body?.stickyNotes ?? req.body?.ideas ?? existing.stickyNotes,
        outlineMap: req.body?.outlineMap ?? req.body?.structure ?? existing.outlineMap,
        evidenceBoard: req.body?.evidenceBoard ?? existing.evidenceBoard,
        narrativeMap: req.body?.narrativeMap ?? req.body?.map ?? existing.narrativeMap,
      };
    }
    const saved = await savePhaseCanvas(roomId, phase, partial, req.user);
    publishRoomEvent(roomId, 'canvas_update', {
      siteId: room.siteId || parseRoomId(roomId).siteId,
      phase: saved.phase,
    });
    return res.json({
      ok: true,
      roomId,
      phase: saved.phase,
      canvas: saved.canvas,
    });
  } catch (err) {
    console.error('[/rooms/:roomId/canvas PUT] error:', err);
    return res.status(500).json({ error: 'canvas_update_failed' });
  }
});

app.get('/rooms/:roomId/replay', requireAuth, requireRoomAccess, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = req.room || (await ensureRoom(roomId));
    const limit = Math.min(1200, Math.max(100, Number(req.query?.limit || 800)));
    const includeActions = String(req.query?.includeActions ?? 'true').trim().toLowerCase() !== 'false';
    const [messages, replayAuditEntries] = await Promise.all([
      getMessagesForRoom(roomId, limit),
      includeActions ? listRoomReplayAuditEntries(room, roomId, Math.max(180, Math.floor(limit / 3))) : Promise.resolve([]),
    ]);
    const entries = buildReplayEntries(messages, replayAuditEntries);
    return res.json({
      ok: true,
      roomId,
      stage: room.stage || DEFAULT_STAGE,
      includeActions,
      entries,
    });
  } catch (err) {
    console.error('[/rooms/:roomId/replay GET] error:', err);
    return res.status(500).json({ error: 'room_replay_failed' });
  }
});

app.get('/rooms/:roomId/presence', requireAuth, requireRoomAccess, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = req.room || (await ensureRoom(roomId));
    const typing = cleanRoomPresence(roomId);
    const messages = await getMessagesForRoom(roomId, 260);
    const contributionMap = new Map();
    const byUid = new Map();
    const emojiByUid = new Map();
    for (const msg of messages) {
      if (String(msg.authorType || 'user') !== 'user') continue;
      const key = String(msg.emoji || '').trim() || `persona-${Number(msg.personaIndex || 0) + 1}`;
      contributionMap.set(key, Number(contributionMap.get(key) || 0) + 1);
      const uid = String(msg.uid || '').trim();
      if (!uid) continue;
      const words = String(msg.text || '')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean).length;
      const row = byUid.get(uid) || { uid, messages: 0, words: 0 };
      row.messages += 1;
      row.words += words;
      byUid.set(uid, row);
      if (String(msg.emoji || '').trim()) {
        emojiByUid.set(uid, String(msg.emoji || '').trim());
      }
    }
    const contributionHeat = Array.from(contributionMap.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
      .slice(0, 12);

    const seatUids = Array.isArray(room.seatUids) && room.seatUids.length
      ? room.seatUids.map((uid) => String(uid || '').trim()).filter(Boolean)
      : (Array.isArray(room.seats) ? room.seats.map((seat) => String(seat?.uid || '').trim()).filter(Boolean) : []);
    const participantUids = seatUids.length ? seatUids : Array.from(byUid.keys());
    const equityRows = participantUids.map((uid, index) => {
      const metrics = byUid.get(uid) || { messages: 0, words: 0 };
      const label = emojiByUid.get(uid) || `Seat ${index + 1}`;
      return {
        uid,
        label,
        messages: Number(metrics.messages || 0),
        words: Number(metrics.words || 0),
      };
    });
    const totalMessages = equityRows.reduce((sum, row) => sum + Number(row.messages || 0), 0);
    const quietCount = equityRows.filter((row) => Number(row.messages || 0) === 0).length;
    const dominantShare = totalMessages
      ? Math.max(
          0,
          ...equityRows.map((row) => Number(row.messages || 0) / totalMessages)
        )
      : 0;
    const idealShare = equityRows.length > 0 ? 1 / equityRows.length : 0;
    const imbalance = totalMessages && idealShare
      ? equityRows.reduce(
          (sum, row) => sum + Math.abs(Number(row.messages || 0) / totalMessages - idealShare),
          0
        ) / 2
      : 0;
    const balanceScore = totalMessages ? Math.max(0, Math.round((1 - imbalance) * 100)) : 100;
    const nudge = quietCount > 0
      ? `Invite ${quietCount} quieter participant${quietCount === 1 ? '' : 's'} to add one line.`
      : dominantShare >= 0.6 && totalMessages >= 6
        ? 'Turn balance prompt: one voice is dominating. Rotate turns for the next round.'
        : '';
    const equity = {
      rows: equityRows
        .map((row) => ({
          ...row,
          sharePct: totalMessages ? Math.round((Number(row.messages || 0) / totalMessages) * 100) : 0,
        }))
        .sort((a, b) => Number(b.messages || 0) - Number(a.messages || 0)),
      totalMessages,
      quietCount,
      balanceScore,
      dominantSharePct: Math.round(dominantShare * 100),
      nudge,
    };
    return res.json({
      ok: true,
      roomId,
      typing,
      contributionHeat,
      equity,
    });
  } catch (err) {
    console.error('[/rooms/:roomId/presence GET] error:', err);
    return res.status(500).json({ error: 'room_presence_failed' });
  }
});

app.post('/rooms/:roomId/presence/typing', requireAuth, requireRoomAccess, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const emoji = String(req.body?.emoji || '').trim();
    const typing = upsertTypingPresence(roomId, req.user.uid, emoji);
    publishRoomEvent(roomId, 'presence_update', {
      siteId: req.room?.siteId || parseRoomId(roomId).siteId,
      typingCount: typing.length,
    });
    return res.json({ ok: true, typing });
  } catch (err) {
    console.error('[/rooms/:roomId/presence/typing POST] error:', err);
    return res.status(500).json({ error: 'typing_update_failed' });
  }
});

app.post('/rooms/:roomId/messages', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const { text, phase, personaIndex = 0, emoji } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  let r = await ensureRoom(roomId);
  const doneWord = isDoneWord(text);
  const aiPolicy = await resolveAiPolicyForRoom(r).catch(() => AI_POLICY_DEFAULT);
  if (!doneWord) {
    const safety = evaluateSchoolSafetyText(text, aiPolicy);
    if (safety.blocked) {
      return res.status(422).json(schoolSafetyErrorPayload(safety));
    }
  }

  // If user types "done/submit" during FINAL in normal chat, mark them ready
  if ((r.stage || 'LOBBY') === 'FINAL' && doneWord) {
    // still store their message (so the room sees who’s done)
    const saved = await addMessage(roomId, {
      text,
      phase: phase || r.stage || 'FINAL',
      authorType: 'user',
      personaIndex,
      uid: req.user.uid,
      emoji: emoji || null,
    });

    if (String(req.user?.role || '').toUpperCase() === 'PARTICIPANT') {
      await touchRoomParticipantActivity(roomId, saved.createdAt);
    }

    const readyRes = await markFinalReady(roomId, req.user.uid);

    return res.json({
      ok: true,
      createdAt: saved.createdAt,
      finalReady: readyRes.ok && !readyRes.blocked,
      alreadyReady: !!readyRes.alreadyReady,
      readyCount: readyRes.ok ? readyRes.readyCount : undefined,
      seats: readyRes.ok ? readyRes.seats : undefined,
      autoClosed: readyRes.ok ? readyRes.autoClosed : undefined,
      blocked: readyRes.ok ? readyRes.blocked || null : undefined,
      cerGate: readyRes.ok ? readyRes.cerGate || null : undefined,
    });
  }

  // Keep ROUGH_DRAFT open; respect lock elsewhere except FINAL
  if (
    r.inputLocked &&
    (r.stage || 'LOBBY') !== 'FINAL' &&
    r.stage !== 'ROUGH_DRAFT'
  ) {
    return res.status(403).json({ error: 'input_locked' });
  }

  const saved = await addMessage(roomId, {
    text,
    phase: phase || r.stage || 'LOBBY',
    authorType: 'user',
    personaIndex,
    uid: req.user.uid,
    emoji: emoji || null,
  });

  if (String(req.user?.role || '').toUpperCase() === 'PARTICIPANT') {
    await touchRoomParticipantActivity(roomId, saved.createdAt);
  }

  res.json({ ok: true, createdAt: saved.createdAt });
});

app.get('/rooms/:roomId/messages', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const limit = Math.min(200, Number(req.query.limit || 100));
  const items = await getMessagesForRoom(roomId, limit);
  res.json({ messages: items });
});

// ---------- Stage controls ----------
app.post(
  '/rooms/:roomId/next',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const cur = await ensureRoom(roomId);
  const phaseGate = evaluatePhaseExitGate(cur, cur.stage || DEFAULT_STAGE);
  if (!phaseGate.ok) {
    await maybePostPhaseGateReminder(cur, phaseGate, { force: true }).catch(() => null);
    return res.status(409).json({
      error: 'phase_exit_incomplete',
      phaseGate,
    });
  }
  const nextStage = advanceStageVal(cur.stage);
  const dur = getRoomStageDurationMs(cur, nextStage);
  const updated = await updateRoom(roomId, {
    stage: nextStage,
    stageEndsAt: Date.now() + dur,
  });
  await appendDecisionLog(roomId, {
    type: 'STAGE_ADVANCED',
    stage: updated.stage || nextStage,
    label: `${String(cur.stage || DEFAULT_STAGE).replace(/_/g, ' ')} -> ${String(
      updated.stage || nextStage
    ).replace(/_/g, ' ')}`,
    actorUid: req.user?.uid || '',
    details: {
      fromStage: cur.stage || DEFAULT_STAGE,
      toStage: updated.stage || nextStage,
    },
  }).catch(() => null);
  await writeAuditEvent({
    action: 'PRESENTER_STAGE_NEXT',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: {
      fromStage: cur.stage || DEFAULT_STAGE,
      toStage: updated.stage || nextStage,
    },
  });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
  }
);

app.post(
  '/rooms/:roomId/extend',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const by = Math.max(1, Number((req.body && req.body.by) || 120));
  const cur = await ensureRoom(roomId);
  const updated = await updateRoom(roomId, {
    stageEndsAt: (cur.stageEndsAt || Date.now()) + by * 1000,
  });
  await appendDecisionLog(roomId, {
    type: 'TIMER_EXTENDED',
    stage: updated.stage || cur.stage || DEFAULT_STAGE,
    label: `Timer extended by ${by}s`,
    actorUid: req.user?.uid || '',
    details: { bySeconds: by },
  }).catch(() => null);
  await writeAuditEvent({
    action: 'PRESENTER_STAGE_EXTEND',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: { bySeconds: by },
  });

  res.json({ ok: true, stageEndsAt: updated.stageEndsAt });
  }
);

app.post(
  '/rooms/:roomId/redo',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const cur = await ensureRoom(roomId);
  const updated = await updateRoom(roomId, {
    stage: 'ROUGH_DRAFT',
    stageEndsAt: Date.now() + getRoomStageDurationMs(cur, 'ROUGH_DRAFT'),
    inputLocked: false,
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,
    closedAt: null,
    closedReason: null,
    finalAbstract: '',
  });
  await appendDecisionLog(roomId, {
    type: 'STAGE_REDO',
    stage: 'ROUGH_DRAFT',
    label: 'Stage reset to Rough Draft',
    actorUid: req.user?.uid || '',
  }).catch(() => null);
  await writeAuditEvent({
    action: 'PRESENTER_STAGE_REDO',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: { stage: updated.stage },
  });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
  }
);

app.post(
  '/rooms/:roomId/lock',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const inputLocked = !!(req.body && req.body.inputLocked);
  const updated = await updateRoom(roomId, { inputLocked });
  await appendDecisionLog(roomId, {
    type: inputLocked ? 'INPUT_LOCKED' : 'INPUT_UNLOCKED',
    stage: updated.stage || DEFAULT_STAGE,
    label: inputLocked ? 'Input locked' : 'Input unlocked',
    actorUid: req.user?.uid || '',
    details: { inputLocked: !!updated.inputLocked },
  }).catch(() => null);
  await writeAuditEvent({
    action: inputLocked ? 'PRESENTER_INPUT_LOCK' : 'PRESENTER_INPUT_UNLOCK',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: { inputLocked: !!updated.inputLocked },
  });
  res.json({ ok: true, inputLocked: !!updated.inputLocked });
  }
);

app.post(
  '/rooms/:roomId/intervention',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
    const roomId = req.params.roomId;
    const kind = String(req.body?.kind || '').trim().toLowerCase();
    if (!kind) return res.status(400).json({ error: 'kind_required' });

    const room = await ensureRoom(roomId);
    let updated = room;
    const now = Date.now();
    const stage = String(room.stage || DEFAULT_STAGE).toUpperCase();
    const messagePhase = stage === 'CLOSED' ? 'FINAL' : stage;

    if (kind === 'extend_time') {
      const by = Math.max(30, Math.min(900, Number(req.body?.by || 120)));
      updated = await updateRoom(roomId, {
        stageEndsAt: (toStageMs(room.stageEndsAt) || now) + by * 1000,
      });
      await addMessage(roomId, {
        text: `🧭 Facilitator intervention: extending this phase by ${by} seconds.`,
        phase: messagePhase,
        authorType: 'asema',
        personaIndex: 0,
      });
    } else if (kind === 'unlock_input') {
      updated = await updateRoom(roomId, { inputLocked: false });
      await addMessage(roomId, {
        text: '🧭 Facilitator intervention: input unlocked. Add one concrete line now.',
        phase: messagePhase,
        authorType: 'asema',
        personaIndex: 0,
      });
    } else if (kind === 'nudge_quiet') {
      await addMessage(roomId, {
        text:
          '🧭 Facilitator intervention: quick round-robin. If you have not spoken yet, share one concrete sentence now.',
        phase: messagePhase,
        authorType: 'asema',
        personaIndex: 0,
      });
    } else if (kind === 'reopen_voting') {
      if (stage !== 'DISCOVERY') {
        return res.status(400).json({ error: 'wrong_stage', stage });
      }
      updated = await updateRoom(roomId, {
        voteOpen: true,
        voteTotal: 0,
        voteTallies: {},
        voteByUid: {},
        voteSubmittedUids: [],
        voteSubmittedCount: 0,
      });
      publishRoomEvent(roomId, 'vote_update', {
        siteId: updated.siteId || parseRoomId(roomId).siteId,
      });
      await addMessage(roomId, {
        text: '🗳️ Facilitator intervention: voting has been reopened for a quick re-check.',
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
    } else {
      return res.status(400).json({ error: 'unknown_intervention_kind' });
    }

    await appendDecisionLog(roomId, {
      type: 'FACILITATOR_INTERVENTION',
      stage: updated.stage || stage,
      label: `Intervention: ${kind.replace(/_/g, ' ')}`,
      actorUid: req.user?.uid || '',
      details: {
        kind,
      },
    }).catch(() => null);

    await writeAuditEvent({
      action: 'PRESENTER_INTERVENTION',
      actor: req.user,
      target: {
        resourceType: 'ROOM',
        resourceId: roomId,
        roomId,
        siteId: updated.siteId || parseRoomId(roomId).siteId,
        licenseId: updated.licenseId || req.user.licenseId || '',
        orgId: updated.orgId || req.user.orgId || '',
      },
      details: {
        kind,
        stage: updated.stage || stage,
      },
    });

    return res.json({
      ok: true,
      kind,
      room: {
        roomId,
        stage: updated.stage || stage,
        stageEndsAt: toStageMs(updated.stageEndsAt),
        inputLocked: !!updated.inputLocked,
        voteOpen: !!updated.voteOpen,
      },
    });
  }
);

// ---------- Voting ----------
const DEFAULT_ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap',
];

const ISSUE_MAP = Object.fromEntries(
  DEFAULT_ISSUES.map((label, idx) => [idx + 1, label])
);

function getDefaultVoteOptions() {
  return DEFAULT_ISSUES.map((label, idx) => ({
    num: idx + 1,
    label,
  }));
}

function getVoteOptionsForRoom(room) {
  const custom = Array.isArray(room?.topicOptions)
    ? room.topicOptions.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  if (custom.length) {
    return custom.map((label, idx) => ({ num: idx + 1, label }));
  }
  return getDefaultVoteOptions();
}

function toVoteOptionMap(optionEntries) {
  const map = {};
  for (const opt of optionEntries || []) {
    const num = Number(opt?.num || 0);
    if (!num) continue;
    map[num] = String(opt?.label || `#${num}`);
  }
  return map;
}

function computeWinningTopic(voteTallies, currentTopic = '', optionMap = ISSUE_MAP) {
  const tallies = voteTallies || {};
  const entries = Object.entries(tallies);
  if (!entries.length) return currentTopic || '';
  entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const [winningNum] = entries[0];
  return optionMap[Number(winningNum)] || `#${winningNum}`;
}

function normalizeExportTemplate(templateRaw = '') {
  const normalized = String(templateRaw || '').trim().toLowerCase();
  if (normalized === 'brief' || normalized === 'storyboard') return normalized;
  return 'story';
}

function normalizeExportTheme(themeRaw = '') {
  const normalized = String(themeRaw || '').trim().toLowerCase();
  if (normalized === 'sunrise' || normalized === 'meadow') return normalized;
  return 'heritage';
}

function buildAbsoluteUrl(req, pathValue = '/') {
  const proto =
    String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https')
      .split(',')[0]
      .trim() || 'https';
  const host =
    String(req.headers?.['x-forwarded-host'] || req.get('host') || '')
      .split(',')[0]
      .trim();
  if (!host) return String(pathValue || '/');
  return `${proto}://${host}${pathValue}`;
}

function serializeShareLinkForClient(req, roomId, entry) {
  const token = String(entry?.linkToken || '').trim();
  const query = token ? `?k=${encodeURIComponent(token)}` : '';
  const path = `/shared/${encodeURIComponent(roomId)}/${encodeURIComponent(
    entry.linkId
  )}${query}`;
  return {
    linkId: entry.linkId,
    title: entry.title,
    topic: entry.topic,
    orgLabel: entry.orgLabel,
    template: entry.template,
    theme: entry.theme,
    createdAt: Number(entry.createdAt || 0) || 0,
    createdBy: entry.createdBy || '',
    expiresAt: Number(entry.expiresAt || 0) || 0,
    revoked: !!entry.revoked,
    maxViews: Number(entry.maxViews || 0) || 0,
    viewCount: Number(entry.viewCount || 0) || 0,
    lastViewedAt: Number(entry.lastViewedAt || 0) || 0,
    path,
    url: buildAbsoluteUrl(req, path),
  };
}

app.post('/rooms/:roomId/vote/ready', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'no_uid' });

  const room = await ensureRoom(roomId);
  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY') {
    return res.status(400).json({ error: 'wrong_stage', stage });
  }

  let updated = room;
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: [
          'SET voteReadyUids = list_append(if_not_exists(voteReadyUids, :emptyList), :uidList)',
          'voteReadyCount = if_not_exists(voteReadyCount, :zero) + :one',
          'updatedAt = :now',
        ].join(', '),
        ConditionExpression:
          'attribute_not_exists(voteReadyUids) OR NOT contains(voteReadyUids, :uid)',
        ExpressionAttributeValues: {
          ':emptyList': [],
          ':uidList': [uid],
          ':uid': uid,
          ':zero': 0,
          ':one': 1,
          ':now': Date.now(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    updated = normalizeRoomShape(Attributes);
  } catch (e) {
    if (shouldUseDemoFallback(e)) {
      logDemoFallback('vote_ready_update', e);
      const readyUids = Array.isArray(room.voteReadyUids)
        ? room.voteReadyUids.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      if (!readyUids.includes(uid)) readyUids.push(uid);
      updated = await updateRoom(roomId, {
        voteReadyUids: readyUids,
        voteReadyCount: readyUids.length,
      });
    } else if (e?.name === 'ConditionalCheckFailedException') {
      updated = await ensureRoom(roomId);
    } else {
      throw e;
    }
  }

  const seats = getSeatCount(updated);
  const voteReadyCount = Number(updated.voteReadyCount || 0);
  const threshold = seats > 0 ? Math.ceil(seats * 0.5) : 0;
  if (!updated.voteOpen && threshold > 0 && voteReadyCount >= threshold) {
    updated = await updateRoom(roomId, {
      voteOpen: true,
      voteTotal: 0,
      voteTallies: {},
      voteByUid: {},
      voteSubmittedUids: [],
      voteSubmittedCount: 0,
    });
    await appendDecisionLog(roomId, {
      type: 'VOTE_OPENED',
      stage: 'DISCOVERY',
      label: 'Topic voting opened (readiness threshold reached)',
      actorUid: req.user?.uid || '',
    }).catch(() => null);
    publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });
    try {
      await addMessage(roomId, {
        text:
          '🗳️ At least half the room is ready — opening topic voting now. Pick one option that fits your story best.',
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
    } catch (e) {
      console.warn('[vote/ready] Asema announcement failed', e);
    }
  }
  publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });
  await writeAuditEvent({
    action: 'ROOM_VOTE_READY',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId || '',
      orgId: updated.orgId || req.user.orgId || '',
    },
    details: {
      stage,
      voteReadyCount: Number(updated.voteReadyCount || 0),
      seats,
    },
  });

  return res.json({
    ok: true,
    votingOpen: !!updated.voteOpen,
    voteReadyCount: updated.voteReadyCount || 0,
    seats,
  });
});

app.get('/rooms/:roomId/vote', requireAuth, requireRoomAccess, async (req, res) => {
  const r = req.room || (await ensureRoom(req.params.roomId));

  const tallies = r.voteTallies || {};
  const optionEntries = getVoteOptionsForRoom(r);
  const counts = optionEntries.map(({ num }) =>
    Number.isFinite(Number(tallies[num])) ? Number(tallies[num]) : 0
  );

  const votesReceived = counts.reduce(
    (a, b) => a + (Number.isFinite(b) ? b : 0),
    0
  );

  const seats = getSeatCount(r);

  res.json({
    votingOpen: !!r.voteOpen,
    options: optionEntries,
    votesReceived,
    counts,
    topic: r.topic || '',
    voteReadyCount: Number(r.voteReadyCount || 0),
    voteSubmittedCount: Number(r.voteSubmittedCount || 0),
    seats,
  });
});

app.post(
  '/rooms/:roomId/vote/start',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const updated = await updateRoom(roomId, {
    voteOpen: true,
    voteTotal: 0,
    voteTallies: {},
    voteByUid: {},
    voteReadyUids: [],
    voteReadyCount: 0,
    voteSubmittedUids: [],
    voteSubmittedCount: 0,
  });
  await appendDecisionLog(roomId, {
    type: 'VOTE_OPENED',
    stage: 'DISCOVERY',
    label: 'Topic voting opened',
    actorUid: req.user?.uid || '',
  }).catch(() => null);
  await writeAuditEvent({
    action: 'PRESENTER_VOTE_START',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: { voteOpen: true },
  });
  publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });
  res.json({ ok: true, started: true });
  }
);

app.post('/rooms/:roomId/vote/submit', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const { choice } = req.body || {};
  const uid = req.user?.uid;

  if (typeof choice !== 'number') {
    return res.status(400).json({ error: 'choice must be a number' });
  }
  const choiceNum = Number(choice);
  if (!uid) {
    return res.status(401).json({ error: 'no_uid' });
  }
  const votingRoom = await ensureRoom(roomId);
  const optionEntries = getVoteOptionsForRoom(votingRoom);
  const optionMap = toVoteOptionMap(optionEntries);
  if (!Number.isFinite(choiceNum) || !optionMap[choiceNum]) {
    return res.status(400).json({ error: 'invalid_choice' });
  }

  let updated;
  try {
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression: [
          'SET voteTallies.#choice = if_not_exists(voteTallies.#choice, :zero) + :one',
          'voteTotal = if_not_exists(voteTotal, :zero) + :one',
          'voteSubmittedUids = list_append(if_not_exists(voteSubmittedUids, :emptyList), :uidList)',
          'voteSubmittedCount = if_not_exists(voteSubmittedCount, :zero) + :one',
          'voteByUid.#uid = :choiceNum',
          'updatedAt = :now',
        ].join(', '),
        ConditionExpression: 'voteOpen = :true AND attribute_not_exists(voteByUid.#uid)',
        ExpressionAttributeNames: {
          '#choice': String(choiceNum),
          '#uid': uid,
        },
        ExpressionAttributeValues: {
          ':true': true,
          ':zero': 0,
          ':one': 1,
          ':emptyList': [],
          ':uidList': [uid],
          ':choiceNum': choiceNum,
          ':now': Date.now(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    updated = normalizeRoomShape(Attributes);
  } catch (err) {
    if (shouldUseDemoFallback(err)) {
      logDemoFallback('vote_submit_update', err);
      const latest = await ensureRoom(roomId);
      const voteByUid = { ...(latest.voteByUid || {}) };
      if (Object.prototype.hasOwnProperty.call(voteByUid, uid)) {
        return res.json({
          ok: true,
          alreadySubmitted: true,
          voteSubmittedCount: Number(latest.voteSubmittedCount || 0),
          seats: getSeatCount(latest),
          votingOpen: !!latest.voteOpen,
          topic: latest.topic || '',
        });
      }
      if (!latest.voteOpen) {
        return res.status(400).json({ error: 'voting_closed' });
      }
      const voteTallies = { ...(latest.voteTallies || {}) };
      voteTallies[choiceNum] = Number(voteTallies[choiceNum] || 0) + 1;
      const voteSubmittedUids = Array.isArray(latest.voteSubmittedUids)
        ? latest.voteSubmittedUids.slice()
        : [];
      voteSubmittedUids.push(uid);
      voteByUid[uid] = choiceNum;
      updated = await updateRoom(roomId, {
        voteTallies,
        voteTotal: Number(latest.voteTotal || 0) + 1,
        voteSubmittedUids,
        voteSubmittedCount: voteSubmittedUids.length,
        voteByUid,
      });
    } else if (err?.name !== 'ConditionalCheckFailedException') {
      throw err;
    } else {
      const latest = await ensureRoom(roomId);
      if (Object.prototype.hasOwnProperty.call(latest.voteByUid || {}, uid)) {
        return res.json({
          ok: true,
          alreadySubmitted: true,
          voteSubmittedCount: Number(latest.voteSubmittedCount || 0),
          seats: getSeatCount(latest),
          votingOpen: !!latest.voteOpen,
          topic: latest.topic || '',
        });
      }
      if (!latest.voteOpen) {
        return res.status(400).json({ error: 'voting_closed' });
      }
      return res.status(409).json({ error: 'vote_conflict_retry' });
    }
  }

  publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });
  await writeAuditEvent({
    action: 'ROOM_VOTE_SUBMIT',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId || '',
      orgId: updated.orgId || req.user.orgId || '',
    },
    details: {
      choice: choiceNum,
      voteSubmittedCount: Number(updated.voteSubmittedCount || 0),
    },
  });

  const seats = getSeatCount(updated);
  const voteSubmittedCount = Number(updated.voteSubmittedCount || 0);

  if (seats > 0 && voteSubmittedCount >= seats && updated.voteOpen) {
    const topic = computeWinningTopic(
      updated.voteTallies,
      updated.topic || '',
      toVoteOptionMap(getVoteOptionsForRoom(updated))
    );
    try {
      const { Attributes } = await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression: 'SET voteOpen = :false, topic = :topic, updatedAt = :now',
          ConditionExpression: 'voteOpen = :true',
          ExpressionAttributeValues: {
            ':false': false,
            ':true': true,
            ':topic': topic,
            ':now': Date.now(),
          },
          ReturnValues: 'ALL_NEW',
        })
      );
      updated = normalizeRoomShape(Attributes);
      publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });

      try {
        await addMessage(roomId, {
          text: `🔒 Topic locked in: **${topic}** — keep everything focused around this issue as you move forward.`,
          phase: 'DISCOVERY',
          authorType: 'asema',
          personaIndex: 0,
        });
      } catch (e) {
        console.warn('[vote/submit] Asema topic announce failed', e);
      }
      await writeAuditEvent({
        action: 'ROOM_TOPIC_LOCKED',
        actor: {
          uid: 'system',
          role: 'SYSTEM',
          siteId: updated.siteId || parseRoomId(roomId).siteId,
          licenseId: updated.licenseId || req.user.licenseId || '',
          orgId: updated.orgId || req.user.orgId || '',
        },
        target: {
          resourceType: 'ROOM',
          resourceId: roomId,
          roomId,
          siteId: updated.siteId || parseRoomId(roomId).siteId,
          licenseId: updated.licenseId || req.user.licenseId || '',
          orgId: updated.orgId || req.user.orgId || '',
        },
        details: {
          topic: updated.topic || topic || '',
          voteSubmittedCount: Number(updated.voteSubmittedCount || 0),
        },
      });
      await appendDecisionLog(roomId, {
        type: 'TOPIC_LOCKED',
        stage: 'DISCOVERY',
        label: `Topic locked: ${updated.topic || topic || '(none)'}`,
        actorUid: req.user?.uid || 'system',
        details: {
          topic: updated.topic || topic || '',
          voteSubmittedCount: Number(updated.voteSubmittedCount || 0),
        },
      }).catch(() => null);
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        logDemoFallback('vote_close_auto', err);
        updated = await updateRoom(roomId, {
          voteOpen: false,
          topic,
        });
      } else if (err?.name !== 'ConditionalCheckFailedException') {
        throw err;
      } else {
        updated = await ensureRoom(roomId);
      }
    }
  }

  res.json({
    ok: true,
    voteSubmittedCount,
    seats,
    votingOpen: !!updated.voteOpen,
    topic: updated.topic || '',
  });
});

app.post(
  '/rooms/:roomId/vote/close',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const r = await ensureRoom(roomId);
  const topic = computeWinningTopic(
    r.voteTallies,
    r.topic || '',
    toVoteOptionMap(getVoteOptionsForRoom(r))
  );
  const updated = await updateRoom(roomId, { voteOpen: false, topic });
  await appendDecisionLog(roomId, {
    type: 'VOTE_CLOSED',
    stage: 'DISCOVERY',
    label: `Voting closed${topic ? `: ${topic}` : ''}`,
    actorUid: req.user?.uid || '',
    details: { topic: topic || '' },
  }).catch(() => null);
  await writeAuditEvent({
    action: 'PRESENTER_VOTE_CLOSE',
    actor: req.user,
    target: {
      resourceType: 'ROOM',
      resourceId: roomId,
      roomId,
      siteId: updated.siteId || parseRoomId(roomId).siteId,
      licenseId: updated.licenseId || req.user.licenseId,
      orgId: updated.orgId || req.user.orgId,
    },
    details: { topic: updated.topic || topic || '' },
  });
  publishRoomEvent(roomId, 'vote_update', { siteId: updated.siteId });
  res.json({ ok: true, closed: true, topic: updated.topic || topic });
  }
);

app.get(
  '/rooms/:roomId/share-links',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
    try {
      const roomId = String(req.params.roomId || '').trim();
      const room = await ensureRoom(roomId);
      const rows = listShareLinksForRoom(room, { includeSecrets: true })
        .map((entry) => serializeShareLinkForClient(req, roomId, entry));
      return res.json({ ok: true, roomId, links: rows });
    } catch (err) {
      console.error('[/rooms/:roomId/share-links GET] error:', err);
      return res.status(500).json({ error: 'share_links_fetch_failed' });
    }
  }
);

app.post(
  '/rooms/:roomId/share-links',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
    try {
      const roomId = String(req.params.roomId || '').trim();
      const room = await ensureRoom(roomId);
      const title = String(req.body?.title || '').trim() || 'Workshop Story';
      const topic = String(req.body?.topic || room.topic || '').trim();
      const orgLabel = String(req.body?.orgLabel || room.siteId || '').trim();
      const template = normalizeExportTemplate(req.body?.template);
      const theme = normalizeExportTheme(req.body?.theme);
      const content = String(
        req.body?.content || room.finalAbstract || room.draftText || ''
      )
        .trim()
        .slice(0, 32_000);
      if (!content) {
        return res.status(400).json({ error: 'share_content_required' });
      }
      const expiresHours = toPositiveInt(req.body?.expiresHours, 72, {
        min: 1,
        max: 24 * 365,
      });
      const maxViewsRaw = Number(req.body?.maxViews || 0);
      const maxViews =
        Number.isFinite(maxViewsRaw) && maxViewsRaw > 0
          ? Math.max(1, Math.min(100_000, Math.floor(maxViewsRaw)))
          : 0;
      const now = Date.now();
      const expiresAt = now + expiresHours * 60 * 60 * 1000;
      const linkId = crypto.randomBytes(6).toString('hex');
      const linkToken = crypto.randomBytes(18).toString('base64url');
      const tokenHash = hashTokenValue(linkToken);
      const existingLinks = listShareLinksForRoom(room);
      if (existingLinks.length >= 60) {
        return res.status(429).json({ error: 'share_link_limit_reached' });
      }
      const entry = {
        linkId,
        linkToken,
        tokenHash,
        title,
        topic,
        content,
        orgLabel,
        template,
        theme,
        createdAt: now,
        createdBy: req.user.uid,
        expiresAt,
        revoked: false,
        maxViews,
        viewCount: 0,
        lastViewedAt: 0,
      };

      const { Attributes } = await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression: 'SET shareLinks.#linkId = :entry, updatedAt = :now',
          ExpressionAttributeNames: {
            '#linkId': linkId,
          },
          ExpressionAttributeValues: {
            ':entry': entry,
            ':now': now,
          },
          ReturnValues: 'ALL_NEW',
        })
      );
      const updatedRoom = normalizeRoomShape(Attributes || room);
      const saved =
        listShareLinksForRoom(updatedRoom, { includeSecrets: true }).find(
          (row) => row.linkId === linkId
        ) || entry;

      const out = serializeShareLinkForClient(req, roomId, saved);
      await writeAuditEvent({
        action: 'PRESENTER_SHARE_LINK_CREATE',
        actor: req.user,
        target: {
          resourceType: 'SHARE_LINK',
          resourceId: `${roomId}:${linkId}`,
          roomId,
          siteId: updatedRoom.siteId || parseRoomId(roomId).siteId,
          licenseId: updatedRoom.licenseId || req.user.licenseId,
          orgId: updatedRoom.orgId || req.user.orgId,
        },
        details: {
          expiresAt,
          maxViews,
          template,
          theme,
        },
      });
      return res.json({ ok: true, roomId, link: out });
    } catch (err) {
      console.error('[/rooms/:roomId/share-links POST] error:', err);
      return res.status(500).json({ error: 'share_link_create_failed' });
    }
  }
);

app.post(
  '/rooms/:roomId/share-links/:linkId/revoke',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
    try {
      const roomId = String(req.params.roomId || '').trim();
      const linkId = String(req.params.linkId || '').trim();
      if (!roomId || !linkId) {
        return res.status(400).json({ error: 'share_identity_required' });
      }
      const revoked = req.body?.revoked !== false;
      const now = Date.now();
      let updatedRoom;
      try {
        const { Attributes } = await ddbDoc.send(
          new UpdateCommand({
            TableName: TABLES.rooms,
            Key: { roomId },
            UpdateExpression:
              'SET shareLinks.#linkId.revoked = :revoked, updatedAt = :now',
            ConditionExpression: 'attribute_exists(shareLinks.#linkId)',
            ExpressionAttributeNames: {
              '#linkId': linkId,
            },
            ExpressionAttributeValues: {
              ':revoked': revoked,
              ':now': now,
            },
            ReturnValues: 'ALL_NEW',
          })
        );
        updatedRoom = normalizeRoomShape(Attributes || {});
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          return res.status(404).json({ error: 'share_link_not_found' });
        }
        throw err;
      }

      await writeAuditEvent({
        action: revoked
          ? 'PRESENTER_SHARE_LINK_REVOKE'
          : 'PRESENTER_SHARE_LINK_UNREVOKE',
        actor: req.user,
        target: {
          resourceType: 'SHARE_LINK',
          resourceId: `${roomId}:${linkId}`,
          roomId,
          siteId: updatedRoom.siteId || parseRoomId(roomId).siteId,
          licenseId: updatedRoom.licenseId || req.user.licenseId,
          orgId: updatedRoom.orgId || req.user.orgId,
        },
        details: { revoked },
      });

      const links = listShareLinksForRoom(updatedRoom, { includeSecrets: true }).map(
        (entry) => serializeShareLinkForClient(req, roomId, entry)
      );
      return res.json({ ok: true, roomId, linkId, revoked, links });
    } catch (err) {
      console.error('[/rooms/:roomId/share-links/:linkId/revoke POST] error:', err);
      return res.status(500).json({ error: 'share_link_revoke_failed' });
    }
  }
);

app.get('/shared/:roomId/:linkId', async (req, res) => {
  try {
    const roomId = String(req.params.roomId || '').trim();
    const linkId = String(req.params.linkId || '').trim();
    const key = String(req.query?.k || '').trim();
    if (!roomId || !linkId || !key) {
      return res.status(400).json({ error: 'share_access_key_required' });
    }
    const roomRaw = await getRoom(roomId);
    if (!roomRaw) return res.status(404).json({ error: 'share_not_found' });
    const room = normalizeRoomShape(roomRaw);
    const link = normalizeShareLinksMap(room.shareLinks || {})[linkId];
    if (!link) return res.status(404).json({ error: 'share_not_found' });

    const now = Date.now();
    if (link.revoked) return res.status(410).json({ error: 'share_link_revoked' });
    if (Number(link.expiresAt || 0) > 0 && now >= Number(link.expiresAt || 0)) {
      return res.status(410).json({ error: 'share_link_expired' });
    }
    if (link.tokenHash !== hashTokenValue(key)) {
      return res.status(403).json({ error: 'share_link_forbidden' });
    }
    if (Number(link.maxViews || 0) > 0 && Number(link.viewCount || 0) >= Number(link.maxViews || 0)) {
      return res.status(410).json({ error: 'share_link_view_limit_reached' });
    }

    const names = {
      '#shareLinks': 'shareLinks',
      '#linkId': linkId,
      '#tokenHash': 'tokenHash',
      '#revoked': 'revoked',
      '#expiresAt': 'expiresAt',
      '#viewCount': 'viewCount',
      '#lastViewedAt': 'lastViewedAt',
      '#maxViews': 'maxViews',
    };
    const values = {
      ':tokenHash': link.tokenHash,
      ':false': false,
      ':now': now,
      ':zero': 0,
      ':one': 1,
      ':maxViews': Number(link.maxViews || 0),
    };
    const conditionParts = [
      'attribute_exists(#shareLinks.#linkId)',
      '#shareLinks.#linkId.#tokenHash = :tokenHash',
      '(attribute_not_exists(#shareLinks.#linkId.#revoked) OR #shareLinks.#linkId.#revoked = :false)',
      '(attribute_not_exists(#shareLinks.#linkId.#expiresAt) OR #shareLinks.#linkId.#expiresAt = :zero OR #shareLinks.#linkId.#expiresAt > :now)',
    ];
    if (Number(link.maxViews || 0) > 0) {
      conditionParts.push(
        '(attribute_not_exists(#shareLinks.#linkId.#viewCount) OR #shareLinks.#linkId.#viewCount < :maxViews)'
      );
    }

    let updatedRoom = room;
    try {
      const { Attributes } = await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression: [
            'SET #shareLinks.#linkId.#viewCount = if_not_exists(#shareLinks.#linkId.#viewCount, :zero) + :one',
            '#shareLinks.#linkId.#lastViewedAt = :now',
            'updatedAt = :now',
          ].join(', '),
          ConditionExpression: conditionParts.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        })
      );
      updatedRoom = normalizeRoomShape(Attributes || room);
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const latest = normalizeRoomShape((await getRoom(roomId)) || room);
      const latestEntry = normalizeShareLinksMap(latest.shareLinks || {})[linkId];
      if (!latestEntry) return res.status(404).json({ error: 'share_not_found' });
      if (latestEntry.revoked) return res.status(410).json({ error: 'share_link_revoked' });
      if (Number(latestEntry.expiresAt || 0) > 0 && Date.now() >= Number(latestEntry.expiresAt || 0)) {
        return res.status(410).json({ error: 'share_link_expired' });
      }
      if (Number(latestEntry.maxViews || 0) > 0 && Number(latestEntry.viewCount || 0) >= Number(latestEntry.maxViews || 0)) {
        return res.status(410).json({ error: 'share_link_view_limit_reached' });
      }
      return res.status(403).json({ error: 'share_link_forbidden' });
    }

    const viewed = normalizeShareLinksMap(updatedRoom.shareLinks || {})[linkId] || link;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      share: {
        roomId,
        siteId: updatedRoom.siteId || parseRoomId(roomId).siteId,
        linkId: viewed.linkId,
        title: viewed.title,
        topic: viewed.topic,
        content: viewed.content,
        orgLabel: viewed.orgLabel,
        template: viewed.template,
        theme: viewed.theme,
        createdAt: viewed.createdAt,
        expiresAt: viewed.expiresAt,
        viewCount: Number(viewed.viewCount || 0),
        maxViews: Number(viewed.maxViews || 0),
      },
    });
  } catch (err) {
    console.error('[/shared/:roomId/:linkId GET] error:', err);
    return res.status(500).json({ error: 'share_link_read_failed' });
  }
});

// ---------- Idea summarization (Discovery + Idea Dump + Planning) ----------
const IDEA_MIN_INTERVAL_MS = 20_000; // 20s per room
const ideaLastRun = new Map(); // roomId -> timestamp

function shouldRunIdeaSummary(roomId) {
  const now = Date.now();
  const last = ideaLastRun.get(roomId) || 0;
  if (now - last < IDEA_MIN_INTERVAL_MS) return false;
  ideaLastRun.set(roomId, now);
  return true;
}

async function summarizeIdeas(roomId) {
  const r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';
  if (!['DISCOVERY', 'IDEA_DUMP', 'PLANNING'].includes(stage)) return;

  const all = await getMessagesForRoom(roomId, 800);
  const phases = ['DISCOVERY', 'IDEA_DUMP', 'PLANNING'];
  const humanLines = all
    .filter(
      (m) =>
        phases.includes(m.phase || '') && (m.authorType || 'user') === 'user'
    )
    .map((m) => m.text);

  if (humanLines.length === 0) {
    await updateRoom(roomId, {
      ideaSummary: '',
      lastIdeaSummaryAt: Date.now(),
    });
    return;
  }

  try {
    const aiPolicy = await resolveAiPolicyForRoom(r);
    const summary = await Asema.summarizeIdeas(stage, r.topic || '', humanLines, {
      ...buildAsemaOptions(r, aiPolicy),
    });
    await updateRoom(roomId, {
      ideaSummary: summary,
      lastIdeaSummaryAt: Date.now(),
    });
  } catch (e) {
    console.error('[ideas] summarize failed', e?.message || e);
  }
}

app.post('/rooms/:roomId/ideas/trigger', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  try {
    if (shouldRunIdeaSummary(roomId)) {
      await summarizeIdeas(roomId);
      return res.json({ ok: true, ran: true });
    }
    return res.json({ ok: true, skipped: true });
  } catch (e) {
    console.error('[ideas/trigger] error', e);
    return res.status(500).json({ error: 'summarize_failed' });
  }
});

// ---------- AI Greeting & Ask ----------
const ASK_MIN_INTERVAL_MS = 4_000; // 4s per room
const askLastRun = new Map(); // roomId -> timestamp

function shouldRunAsk(roomId) {
  const now = Date.now();
  const last = askLastRun.get(roomId) || 0;
  if (now - last < ASK_MIN_INTERVAL_MS) return false;
  askLastRun.set(roomId, now);
  return true;
}

// Legacy welcome endpoint (no-op)
app.post('/rooms/:roomId/welcome', requireAuth, requireRoomAccess, async (req, res) => {
  return res.json({ ok: true, disabled: true });
});

// GET current living draft
app.get('/rooms/:roomId/draft', requireAuth, requireRoomAccess, async (req, res) => {
  const room = await ensureRoom(req.params.roomId);
  return res.json({
    ok: true,
    draftText: room.draftText || '',
    draftVersion: Number(room.draftVersion || 0),
    draftUpdatedAt: room.draftUpdatedAt || null,
  });
});

app.get('/rooms/:roomId/private-draft', requireAuth, requireRoomAccess, async (req, res) => {
  const room = await ensureRoom(req.params.roomId);
  const state = serializePrivateDraftState(room, req.user?.uid || '');
  return res.json({
    ok: true,
    stage: room.stage || DEFAULT_STAGE,
    privateDraft: state.mine,
    submissions: state.submissions,
  });
});

app.post('/rooms/:roomId/private-draft', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = String(req.user?.uid || '').trim();
  if (!uid) return res.status(401).json({ error: 'no_uid' });
  const text = clipText(String(req.body?.text || ''), 8_000).trim();
  if (!text) return res.status(400).json({ error: 'text_required' });

  const room = await ensureRoom(roomId);
  const privateDrafts = normalizePrivateDraftMap(room.privateDrafts || {});
  const current = privateDrafts[uid] || normalizePrivateDraftEntry({});
  const now = Date.now();
  const changed = text !== String(current.text || '');
  privateDrafts[uid] = {
    ...current,
    text,
    updatedAt: now,
    submittedAt: changed ? 0 : Number(current.submittedAt || 0) || 0,
  };
  const updated = await updateRoom(roomId, { privateDrafts });
  const mine = serializePrivateDraftState(updated, uid).mine;
  return res.json({ ok: true, privateDraft: mine });
});

app.post('/rooms/:roomId/private-draft/submit', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = String(req.user?.uid || '').trim();
  if (!uid) return res.status(401).json({ error: 'no_uid' });

  const room = await ensureRoom(roomId);
  const privateDrafts = normalizePrivateDraftMap(room.privateDrafts || {});
  const current = privateDrafts[uid] || normalizePrivateDraftEntry({});
  const incomingText = clipText(String(req.body?.text || ''), 8_000).trim();
  const finalText = incomingText || String(current.text || '').trim();
  if (!finalText) return res.status(400).json({ error: 'text_required' });
  const now = Date.now();
  privateDrafts[uid] = {
    ...current,
    text: finalText,
    updatedAt: incomingText ? now : Number(current.updatedAt || now) || now,
    submittedAt: now,
  };
  const updated = await updateRoom(roomId, { privateDrafts });
  await appendDecisionLog(roomId, {
    type: 'PRIVATE_DRAFT_SUBMITTED',
    stage: updated.stage || DEFAULT_STAGE,
    label: 'Private draft submitted to merge panel',
    actorUid: uid,
    details: {
      chars: finalText.length,
    },
  }).catch(() => null);
  const state = serializePrivateDraftState(updated, uid);
  return res.json({ ok: true, privateDraft: state.mine, submissions: state.submissions });
});

app.post('/rooms/:roomId/private-draft/merge', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const actorUid = String(req.user?.uid || '').trim();
  if (!actorUid) return res.status(401).json({ error: 'no_uid' });
  const sourceUid = String(req.body?.sourceUid || '').trim();
  if (!sourceUid) return res.status(400).json({ error: 'source_uid_required' });
  const mode = String(req.body?.mode || 'append').trim().toLowerCase();
  const room = await ensureRoom(roomId);
  const privateDrafts = normalizePrivateDraftMap(room.privateDrafts || {});
  const source = privateDrafts[sourceUid];
  if (!source || !Number(source.submittedAt || 0) || !String(source.text || '').trim()) {
    return res.status(404).json({ error: 'submitted_private_draft_not_found' });
  }
  const sourceText = String(source.text || '').trim();
  const current = String(room.draftText || '').trim();
  const mergedText =
    mode === 'replace' || !current
      ? sourceText
      : `${current}\n\n[Merged contribution from ${sourceUid}]\n${sourceText}`;
  const now = Date.now();
  const nextVersion = Number(room.draftVersion || 0) + 1;
  privateDrafts[sourceUid] = {
    ...source,
    mergedAt: now,
    mergedBy: actorUid,
  };
  const updated = await updateRoom(roomId, {
    draftText: mergedText,
    draftVersion: nextVersion,
    draftUpdatedAt: now,
    draftApprovedByUids: [],
    draftApprovedVersion: 0,
    draftApprovedAt: 0,
    privateDrafts,
  });
  await saveDraftSnapshot(roomId, mergedText, nextVersion);
  await addMessage(roomId, {
    text: `🧩 **Merged draft contribution** from room member. Draft is now v${nextVersion}.`,
    phase: updated.stage || DEFAULT_STAGE,
    authorType: 'asema',
    personaIndex: 0,
  });
  await appendDecisionLog(roomId, {
    type: 'PRIVATE_DRAFT_MERGED',
    stage: updated.stage || DEFAULT_STAGE,
    label: `Private draft merged into shared draft (v${nextVersion})`,
    actorUid,
    details: {
      sourceUid,
      mode,
      version: nextVersion,
    },
  }).catch(() => null);
  return res.json({
    ok: true,
    version: nextVersion,
    draftText: mergedText,
    submissions: serializePrivateDraftState(updated, actorUid).submissions,
  });
});

app.post('/rooms/:roomId/draft/approve', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = String(req.user?.uid || '').trim();
  if (!uid) return res.status(401).json({ error: 'no_uid' });
  const room = await ensureRoom(roomId);
  if (!['EDITING', 'FINAL'].includes(String(room.stage || DEFAULT_STAGE).toUpperCase())) {
    return res.status(400).json({ error: 'wrong_stage', stage: room.stage || DEFAULT_STAGE });
  }
  if (!String(room.draftText || '').trim()) {
    return res.status(400).json({ error: 'draft_required' });
  }
  const approve = req.body?.approved !== false;
  const approvals = new Set(
    Array.isArray(room.draftApprovedByUids)
      ? room.draftApprovedByUids.map((entry) => String(entry || '').trim()).filter(Boolean)
      : []
  );
  if (approve) approvals.add(uid);
  else approvals.delete(uid);
  const nextApprovals = Array.from(approvals);
  const patch = {
    draftApprovedByUids: nextApprovals,
    draftApprovedVersion: nextApprovals.length ? Number(room.draftVersion || 0) : 0,
    draftApprovedAt: nextApprovals.length ? Date.now() : 0,
  };
  const updated = await updateRoom(roomId, patch);
  await appendDecisionLog(roomId, {
    type: approve ? 'DRAFT_APPROVED' : 'DRAFT_APPROVAL_REVOKED',
    stage: updated.stage || DEFAULT_STAGE,
    label: approve ? 'Draft approved by room member' : 'Draft approval removed',
    actorUid: uid,
    details: {
      approvals: nextApprovals.length,
      draftVersion: Number(updated.draftVersion || 0),
    },
  }).catch(() => null);
  const requiredApprovals = getSeatCount(updated) >= 4 ? 2 : 1;
  return res.json({
    ok: true,
    approved: approve,
    approvedByUids: nextApprovals,
    approvedCount: nextApprovals.length,
    requiredApprovals,
    draftVersion: Number(updated.draftVersion || 0),
    approvedVersion: Number(updated.draftApprovedVersion || 0),
    approvedAt: Number(updated.draftApprovedAt || 0) || 0,
  });
});

app.get('/rooms/:roomId/ai-fallback', requireAuth, requireRoomAccess, async (req, res) => {
  const room = await ensureRoom(req.params.roomId);
  return res.json({
    ok: true,
    aiFallback: serializeAiFallbackState(room, room.stage || DEFAULT_STAGE),
  });
});

// Edit the living draft (EDITING / FINAL)
app.post('/rooms/:roomId/draft/edit', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const { instructions } = req.body || {};
  if (!instructions || typeof instructions !== 'string') {
    return res.status(400).json({ error: 'instructions required' });
  }

  let room = await ensureRoom(roomId);
  const stage = room.stage || 'LOBBY';
  if (!['EDITING', 'FINAL'].includes(stage)) {
    return res.status(400).json({ error: 'wrong_stage', stage });
  }

  try {
    const aiPolicy = await resolveAiPolicyForRoom(room).catch(() => AI_POLICY_DEFAULT);
    const safety = evaluateSchoolSafetyText(instructions, aiPolicy);
    if (safety.blocked) {
      return res.status(422).json(schoolSafetyErrorPayload(safety));
    }

    const priorDraft = {
      text: String(room.draftText || ''),
      version: Number(room.draftVersion || 0),
      updatedAt: room.draftUpdatedAt || null,
      approvedByUids: Array.isArray(room.draftApprovedByUids)
        ? room.draftApprovedByUids.slice()
        : [],
      approvedVersion: Number(room.draftApprovedVersion || 0),
      approvedAt: Number(room.draftApprovedAt || 0) || 0,
    };
    const { draftText, version } = await applyDraftEdits(room, instructions);
    const outputSafety = evaluateSchoolSafetyText(draftText, aiPolicy);
    if (outputSafety.blocked) {
      await updateRoom(roomId, {
        draftText: priorDraft.text,
        draftVersion: priorDraft.version,
        draftUpdatedAt: priorDraft.updatedAt,
        draftApprovedByUids: priorDraft.approvedByUids,
        draftApprovedVersion: priorDraft.approvedVersion,
        draftApprovedAt: priorDraft.approvedAt,
      });
      await addMessage(roomId, {
        text:
          '⚠️ Edit blocked by organization safety policy. Keep wording policy-safe and remove sensitive details, then try again.',
        phase: stage,
        authorType: 'asema',
        personaIndex: 0,
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'policy_guard',
          prompt: instructions,
          fallback: true,
          blockedFlags: outputSafety.flags,
        }),
      });
      return res.status(422).json(schoolSafetyErrorPayload(outputSafety));
    }
    const aiReceipt = buildAiReceipt({
      stage,
      policy: aiPolicy,
      source: 'openai_edit',
      prompt: instructions,
    });

    await addMessage(roomId, {
      text: `✅ **Updated Draft (v${version})**\n\n${draftText}`,
      phase: stage,
      authorType: 'asema',
      personaIndex: 0,
      aiReceipt,
    });
    await writeAuditEvent({
      action: 'ROOM_DRAFT_EDIT',
      actor: req.user,
      target: {
        resourceType: 'ROOM',
        resourceId: roomId,
        roomId,
        siteId: room.siteId || parseRoomId(roomId).siteId,
        licenseId: room.licenseId || req.user.licenseId || '',
        orgId: room.orgId || req.user.orgId || '',
      },
      details: {
        stage,
        version,
      },
    });

    return res.json({ ok: true, version, aiReceipt });
  } catch (e) {
    console.error('[draft/edit] error', e?.message || e);
    return res.status(500).json({ error: 'edit_failed' });
  }
});

app.post('/rooms/:roomId/ask', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  let r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';
  const aiPolicy = await resolveAiPolicyForRoom(r).catch(() => AI_POLICY_DEFAULT);
  const safety = evaluateSchoolSafetyText(text, aiPolicy);
  if (safety.blocked) {
    await addMessage(roomId, {
      text:
        '⚠️ I can’t process that request under the current safety settings. Rephrase with policy-safe language and no personal identifiers.',
      phase: stage,
      authorType: 'asema',
      aiReceipt: buildAiReceipt({
        stage,
        policy: aiPolicy,
        source: 'policy_guard',
        prompt: text,
        fallback: true,
        blockedFlags: safety.flags,
      }),
    });
    return res.status(422).json(schoolSafetyErrorPayload(safety));
  }

  // If user asks to show latest draft, paste current living draft
  if (wantsShowDraft(text)) {
    const d = (r.draftText || '').trim();
    if (d) {
      await addMessage(roomId, {
        text: `🧾 **Latest Draft (v${Number(r.draftVersion || 0)})**\n\n${d}`,
        phase: stage,
        authorType: 'asema',
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'room_memory',
          prompt: text,
        }),
      });
    } else {
      await addMessage(roomId, {
        text: 'I don’t see a saved draft yet. Generate one in ROUGH_DRAFT first.',
        phase: stage,
        authorType: 'asema',
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'room_memory',
          prompt: text,
          fallback: true,
        }),
      });
    }
    return res.json({
      ok: true,
      showedDraft: true,
      aiReceipt: buildAiReceipt({
        stage,
        policy: aiPolicy,
        source: 'room_memory',
        prompt: text,
      }),
    });
  }

  // In EDITING/FINAL, treat edit-like messages as edit instructions (edits SAME draft)
  if (
    (stage === 'EDITING' || stage === 'FINAL') &&
    looksLikeEditInstruction(text)
  ) {
    try {
      const priorDraft = {
        text: String(r.draftText || ''),
        version: Number(r.draftVersion || 0),
        updatedAt: r.draftUpdatedAt || null,
        approvedByUids: Array.isArray(r.draftApprovedByUids)
          ? r.draftApprovedByUids.slice()
          : [],
        approvedVersion: Number(r.draftApprovedVersion || 0),
        approvedAt: Number(r.draftApprovedAt || 0) || 0,
      };
      const { draftText, version } = await applyDraftEdits(r, text);
      const outputSafety = evaluateSchoolSafetyText(draftText, aiPolicy);
      if (outputSafety.blocked) {
        await updateRoom(roomId, {
          draftText: priorDraft.text,
          draftVersion: priorDraft.version,
          draftUpdatedAt: priorDraft.updatedAt,
          draftApprovedByUids: priorDraft.approvedByUids,
          draftApprovedVersion: priorDraft.approvedVersion,
          draftApprovedAt: priorDraft.approvedAt,
        });
        await addMessage(roomId, {
          text:
            '⚠️ Edit blocked by organization safety policy. Keep wording policy-safe and remove sensitive details, then try again.',
          phase: stage,
          authorType: 'asema',
          aiReceipt: buildAiReceipt({
            stage,
            policy: aiPolicy,
            source: 'policy_guard',
            prompt: text,
            fallback: true,
            blockedFlags: outputSafety.flags,
          }),
        });
        return res.status(422).json(schoolSafetyErrorPayload(outputSafety));
      }
      await addMessage(roomId, {
        text: `✅ **Updated Draft (v${version})**\n\n${draftText}`,
        phase: stage,
        authorType: 'asema',
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'openai_edit',
          prompt: text,
        }),
      });
      await writeAuditEvent({
        action: 'ROOM_DRAFT_EDIT',
        actor: req.user,
        target: {
          resourceType: 'ROOM',
          resourceId: roomId,
          roomId,
          siteId: r.siteId || parseRoomId(roomId).siteId,
          licenseId: r.licenseId || req.user.licenseId || '',
          orgId: r.orgId || req.user.orgId || '',
        },
        details: {
          stage,
          version,
          via: 'ask',
        },
      });
      return res.json({
        ok: true,
        edited: true,
        version,
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'openai_edit',
          prompt: text,
        }),
      });
    } catch (e) {
      console.error('[ask edit flow] error', e);
      await addMessage(roomId, {
        text:
          'I had trouble applying that edit. Try specifying exactly what to replace or which paragraph to change.',
        phase: stage,
        authorType: 'asema',
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'fallback',
          prompt: text,
          fallback: true,
        }),
      });
      return res.json({
        ok: true,
        fallback: true,
        aiReceipt: buildAiReceipt({
          stage,
          policy: aiPolicy,
          source: 'fallback',
          prompt: text,
          fallback: true,
        }),
      });
    }
  }

  // Throttle actual OpenAI calls per room
  if (!shouldRunAsk(roomId)) {
    await addMessage(roomId, {
      text:
        'I’m catching up on a few questions — give the room a few seconds before calling on me again.',
      phase: stage,
      authorType: 'asema',
      aiReceipt: buildAiReceipt({
        stage,
        policy: aiPolicy,
        source: 'throttle_guard',
        prompt: text,
        fallback: true,
      }),
    });
    return res.json({
      ok: true,
      throttled: true,
      aiReceipt: buildAiReceipt({
        stage,
        policy: aiPolicy,
        source: 'throttle_guard',
        prompt: text,
        fallback: true,
      }),
    });
  }

  try {
    let reply = await Asema.replyToUser(stage, r.topic || '', text, {
      ...buildAsemaOptions(r, aiPolicy),
    });
    const outputSafety = evaluateSchoolSafetyText(reply, aiPolicy);
    const blockedFlags = outputSafety.blocked ? outputSafety.flags : [];
    if (outputSafety.blocked) {
      reply =
        'Let’s keep this policy-safe: share one concrete, respectful observation tied to your topic, then one piece of evidence.';
    }
    const aiReceipt = buildAiReceipt({
      stage,
      policy: aiPolicy,
      source: outputSafety.blocked ? 'policy_guard' : 'openai',
      prompt: text,
      blockedFlags,
    });
    await addMessage(roomId, {
      text: reply,
      phase: stage,
      authorType: 'asema',
      aiReceipt,
    });
    res.json({ ok: true, aiReceipt });
  } catch (e) {
    console.error('[ask] error', e);
    const fallback =
      'Nice direction — now anchor it with one clear character, place, and problem.';
    const aiReceipt = buildAiReceipt({
      stage,
      policy: aiPolicy,
      source: 'fallback',
      prompt: text,
      fallback: true,
    });
    await addMessage(roomId, {
      text: fallback,
      phase: stage,
      authorType: 'asema',
      aiReceipt,
    });
    await markRoomAiFallback(roomId, {
      stage,
      reason: 'ask_generation_failed',
      actorUid: req.user?.uid || '(system)',
    }).catch(() => null);
    res.json({ ok: true, fallback: true, aiReceipt });
  }
});

// ---------- Draft / Final ----------
app.post('/rooms/:roomId/draft/generate', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const { mode } = req.body || {};
  try {
    const room = await ensureRoom(roomId);
    if ((room.stage || 'LOBBY') !== 'ROUGH_DRAFT') {
      return res.status(400).json({ error: 'wrong_stage', stage: room.stage });
    }

    const force = mode === 'regen' || mode === 'regenerate' || mode === 'ask';

    const draft = await generateRoughDraftForRoom(room, { force });
    res.json({ ok: true, ...draft });
  } catch (e) {
    console.error('[draft/generate] error', e);
    res.status(500).json({ error: 'draft_failed' });
  }
});

app.post('/rooms/:roomId/final/start', requireAuth, requireRoomAccess, async (_req, res) =>
  res.json({ ok: true })
);

// Presenter manual close button (FINAL stage only)
app.post(
  '/rooms/:roomId/final/close',
  requireAuth,
  requirePresenter,
  requirePresenterRoomScope,
  async (req, res) => {
  const roomId = req.params.roomId;
  const room = await ensureRoom(roomId);
  if ((room.stage || 'LOBBY') !== 'FINAL') {
    return res.status(400).json({ error: 'wrong_stage', stage: room.stage });
  }

  try {
    const updated = await closeRoomWithFinal(room, {
      reason: 'presenter',
      closedBy: req.user.uid,
    });
    await writeAuditEvent({
      action: 'PRESENTER_FINAL_CLOSE',
      actor: req.user,
      target: {
        resourceType: 'ROOM',
        resourceId: roomId,
        roomId,
        siteId: updated.siteId || parseRoomId(roomId).siteId,
        licenseId: updated.licenseId || req.user.licenseId,
        orgId: updated.orgId || req.user.orgId,
      },
      details: {
        closedReason: updated.closedReason || 'presenter',
        closedAt: updated.closedAt || null,
      },
    });
    return res.json({
      ok: true,
      closed: true,
      stage: updated.stage,
      closedAt: updated.closedAt,
    });
  } catch (e) {
    console.error('[final/close] error', e);
    if (e?.code === 'cer_required') {
      return res.status(409).json({
        error: 'cer_required',
        cerGate: e.cerGate || null,
      });
    }
    return res.status(500).json({ error: 'close_failed' });
  }
  }
);

// Mark a participant as "ready" in FINAL stage (called when they click done/submit)
app.post('/rooms/:roomId/final/ready', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = req.user?.uid;
  if (!uid) {
    return res.status(401).json({ error: 'no_uid' });
  }

  const readyRes = await markFinalReady(roomId, uid);
  if (!readyRes.ok) {
    return res.status(400).json({ error: 'wrong_stage', stage: readyRes.stage });
  }

  return res.json({
    ok: true,
    readyCount: readyRes.readyCount,
    seats: readyRes.seats,
    alreadyReady: !!readyRes.alreadyReady,
    autoClosed: readyRes.autoClosed,
    blocked: readyRes.blocked || null,
    cerGate: readyRes.cerGate || null,
    stage: readyRes.autoClosed ? 'CLOSED' : 'FINAL',
  });
});

function normalizeCodeSiteIds(item = {}) {
  const directList = sanitizeSiteIds(item.siteIds);
  if (directList.length) return directList;
  const single = normalizedSiteId(item.siteId);
  return single ? [single] : [];
}

function normalizeLicenseFromCode(item = {}, fallbackCode = '') {
  const fromItem = normalizedLicenseId(item.licenseId);
  if (fromItem) return fromItem;
  const site = normalizedSiteId(item.siteId);
  if (site) return site;
  const rawCode = String(fallbackCode || item.code || '').trim();
  if (!rawCode) return '';
  return `LIC-${rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

function normalizeOrgFromCode(item = {}, fallbackLicense = '') {
  return normalizedOrgId(item.orgId || '', item.licenseId || fallbackLicense || '');
}

function classifyCodeUnusable(item = {}) {
  if (!item || typeof item !== 'object') return 'code_not_found';
  if (item.revoked) return 'code_revoked';
  if (codeIsExpired(item)) return 'code_expired';
  return '';
}

async function getCodeRecordByInput(rawCode) {
  const normalizedCode = String(rawCode || '').trim().toUpperCase();
  if (!normalizedCode) return null;
  let item = null;
  try {
    const getRes = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.codes,
        Key: { code: normalizedCode },
      })
    );
    item = getRes.Item || null;
  } catch (err) {
    if (!shouldUseDemoFallback(err)) throw err;
    logDemoFallback('code_get', err);
    item = getOrCreateDemoCodeRecord(normalizedCode);
  }
  if (!item && DEMO_MODE_FALLBACK) {
    item = getOrCreateDemoCodeRecord(normalizedCode);
  }
  if (!item) return null;

  const expectedHash = String(item.codeHash || '').trim().toLowerCase();
  const actualHash = hashCodeValue(normalizedCode).toLowerCase();
  if (expectedHash && expectedHash !== actualHash) {
    return null;
  }
  if (!expectedHash) {
    try {
      await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.codes,
          Key: { code: normalizedCode },
          UpdateExpression: 'SET codeHash = :hash',
          ConditionExpression: 'attribute_not_exists(codeHash)',
          ExpressionAttributeValues: { ':hash': actualHash },
        })
      );
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        logDemoFallback('code_hash_backfill', err);
        const next = { ...item, codeHash: actualHash };
        demoFallbackState.codes.set(normalizedCode, deepCloneDemo(next));
      } else if (err?.name !== 'ConditionalCheckFailedException') {
        console.warn('[codes] codeHash backfill skipped:', err?.message || err);
      }
    }
  }
  return item;
}

async function consumeCodeForUser(item, uid) {
  const unusable = classifyCodeUnusable(item);
  if (unusable) {
    return { ok: false, conflict: true, reason: unusable };
  }

  try {
    const now = Date.now();
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.codes,
        Key: { code: item.code },
        UpdateExpression: 'SET #consumed = :c, #usedBy = :u, consumedAt = :t',
        ConditionExpression:
          '(attribute_not_exists(#consumed) OR #consumed = :f OR #usedBy = :u) AND ' +
          '(attribute_not_exists(revoked) OR revoked = :f) AND ' +
          '(attribute_not_exists(expiresAt) OR expiresAt > :now)',
        ExpressionAttributeNames: {
          '#consumed': 'consumed',
          '#usedBy': 'usedBy',
        },
        ExpressionAttributeValues: {
          ':c': true,
          ':f': false,
          ':u': uid || '(unknown)',
          ':t': now,
          ':now': now,
        },
      })
    );
    return { ok: true };
  } catch (e) {
    if (e?.name === 'ConditionalCheckFailedException') {
      return { ok: false, conflict: true };
    }
    if (shouldUseDemoFallback(e)) {
      logDemoFallback('code_consume_update', e);
      return consumeDemoCodeRecord(item, uid);
    }
    console.warn('[codes] consume update skipped:', e?.message || e);
    return { ok: false, error: e };
  }
}

app.post('/super-admin/auth/email', requireAuth, async (req, res) => {
  try {
    const email = normalizeSuperAdminEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: 'email_required' });
    }
    if (email !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ error: 'super_admin_email_not_allowed' });
    }

    const pair = await issueTokenPair(
      {
        uid: req.user.uid,
        role: 'SUPER_ADMIN',
        orgId: req.user.orgId || null,
        email,
      },
      req
    );
    await writeAuditEvent({
      action: 'SUPER_ADMIN_AUTH_EMAIL',
      actor: { ...req.user, email },
      target: { resourceType: 'SUPER_ADMIN', resourceId: req.user.uid },
      details: { email },
    });
    return res.json({
      ok: true,
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      expiresIn: pair.accessTtlSeconds,
      role: 'SUPER_ADMIN',
      email,
      userId: req.user.uid,
    });
  } catch (err) {
    console.error('[/super-admin/auth/email] error:', err);
    return res.status(500).json({ error: 'super_admin_auth_failed' });
  }
});

app.get('/super-admin/overview', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const activeCutoff = now - SUPER_ADMIN_ACTIVE_WINDOW_MS;

    const rolePartitions = ['PARTICIPANT', 'PRESENTER', 'ADMIN', 'SUPER_ADMIN'];
    let sessionsTableMissing = false;
    let sessionsObserved = 0;
    const sessionRowsRaw = [];

    for (const role of rolePartitions) {
      let remaining = 350;
      let lastKey = undefined;
      let exhaustedByCutoff = false;

      while (remaining > 0 && !exhaustedByCutoff) {
        const pageLimit = Math.min(150, remaining);
        let page;
        try {
          // eslint-disable-next-line no-await-in-loop
          page = await queryByPartitionKey({
            tableName: TABLES.sessions,
            indexName: 'byRoleLastSeen',
            partitionKey: 'role',
            partitionValue: role,
            limit: pageLimit,
            scanForward: false,
            exclusiveStartKey: lastKey,
          });
        } catch (err) {
          if (err?.name === 'ResourceNotFoundException') {
            sessionsTableMissing = true;
            break;
          }
          throw err;
        }

        const items = page.items || [];
        sessionsObserved += items.length;
        remaining -= items.length;
        lastKey = page.lastKey || undefined;

        for (const item of items) {
          const lastSeenAt = Number(item.lastSeenAt || 0);
          if (!lastSeenAt || lastSeenAt < activeCutoff) {
            exhaustedByCutoff = true;
            break;
          }
          sessionRowsRaw.push({
            uid: String(item.uid || '').trim(),
            role: String(item.role || '').trim().toUpperCase() || role,
            siteId: normalizedSiteId(item.siteId || 'UNASSIGNED'),
            licenseId: normalizedLicenseId(item.licenseId || ''),
            orgId: normalizedOrgId(item.orgId || '', item.licenseId || ''),
            email: normalizeSuperAdminEmail(item.email || ''),
            lastSeenAt,
            lastSeenIso: String(item.lastSeenIso || ''),
            ip: String(item.ip || ''),
          });
        }

        if (!lastKey) break;
      }
    }

    const sessionByUid = new Map();
    for (const row of sessionRowsRaw) {
      if (!row.uid) continue;
      const prev = sessionByUid.get(row.uid);
      if (!prev || Number(row.lastSeenAt || 0) > Number(prev.lastSeenAt || 0)) {
        sessionByUid.set(row.uid, row);
      }
    }
    const activeSessionRows = Array.from(sessionByUid.values()).sort(
      (a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)
    );
    const activeUserIds = new Set(activeSessionRows.map((row) => row.uid));

    let codesTableMissing = false;
    const codeRoleCounts = { PARTICIPANT: 0, PRESENTER: 0, ADMIN: 0, SUPER_ADMIN: 0 };
    let consumedCodes = 0;
    const recentCodesRaw = [];
    for (const role of rolePartitions) {
      try {
        const { items } = await queryRecentCodesByRole({ role, limit: 220 });
        for (const item of items) {
          codeRoleCounts[role] += 1;
          if (item.consumed) consumedCodes += 1;
          recentCodesRaw.push(item);
        }
      } catch (err) {
        if (err?.name === 'ResourceNotFoundException') {
          codesTableMissing = true;
          break;
        }
        throw err;
      }
    }
    const recentCodes = recentCodesRaw
      .map(mapCodeRow)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 150);

    let workshopsTableMissing = false;
    const workshopItems = [];
    const candidateLicenseIds = new Set();
    for (const row of activeSessionRows) {
      const licenseId = normalizedLicenseId(row.licenseId || '');
      if (licenseId) candidateLicenseIds.add(licenseId);
    }
    for (const code of recentCodesRaw) {
      const licenseId = normalizedLicenseId(code.licenseId || '');
      if (licenseId) candidateLicenseIds.add(licenseId);
    }
    if (req.user?.licenseId) {
      candidateLicenseIds.add(normalizedLicenseId(req.user.licenseId));
    }

    for (const licenseId of candidateLicenseIds) {
      if (!licenseId) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const workshop = await getWorkshopConfig(licenseId);
        if (workshop) workshopItems.push(workshop);
      } catch (err) {
        if (err?.name === 'ResourceNotFoundException') {
          workshopsTableMissing = true;
          break;
        }
        throw err;
      }
    }

    const licenseRows = workshopItems
      .map((workshop) => ({
        licenseId: normalizedLicenseId(workshop.licenseId || ''),
        orgId: normalizedOrgId(workshop.orgId || '', workshop.licenseId || ''),
        name: workshop.name || '',
        mode: workshop.mode || '',
        expectedUsers: Number(workshop.expectedUsers || 0),
        activeUserCap: Number(workshop.activeUserCap || workshop.expectedUsers || 0),
        roomsPerSite: Number(workshop.roomsPerSite || 0),
        seatLimitPerRoom: Number(workshop.seatLimitPerRoom || 0),
        licenseStatus: String(workshop.licenseStatus || 'ACTIVE').toUpperCase(),
        sites: sanitizeSiteIds(workshop.siteIds || []),
        updatedAt: Number(workshop.updatedAt || 0) || null,
      }))
      .filter((row) => row.licenseId)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    const candidateSites = new Set();
    for (const workshop of licenseRows) {
      for (const siteId of workshop.sites || []) candidateSites.add(siteId);
    }
    for (const row of activeSessionRows) {
      if (row.siteId && row.siteId !== 'UNASSIGNED') candidateSites.add(row.siteId);
    }
    for (const code of recentCodes) {
      if (code.siteId) candidateSites.add(code.siteId);
      for (const sid of code.siteIds || []) candidateSites.add(sid);
    }

    let roomsTableMissing = false;
    const roomRowsAll = [];
    for (const siteId of candidateSites) {
      let lastKey = undefined;
      let remaining = 160;
      while (remaining > 0) {
        let page;
        try {
          // eslint-disable-next-line no-await-in-loop
          page = await queryByPartitionKey({
            tableName: TABLES.rooms,
            indexName: 'bySiteIndex',
            partitionKey: 'siteId',
            partitionValue: siteId,
            limit: Math.min(80, remaining),
            scanForward: true,
            exclusiveStartKey: lastKey,
          });
        } catch (err) {
          if (err?.name === 'ResourceNotFoundException') {
            roomsTableMissing = true;
            break;
          }
          throw err;
        }
        const items = page.items || [];
        roomRowsAll.push(...items.map((room) => normalizeRoomShape(room)));
        remaining -= items.length;
        lastKey = page.lastKey || undefined;
        if (!lastKey) break;
      }
    }

    const activeRooms = roomRowsAll.filter((room) => String(room.stage || '') !== 'CLOSED');
    const roomStateBySite = new Map();
    const fallbackUserIds = new Set();
    const fallbackUsersBySiteMap = new Map();
    for (const room of roomRowsAll) {
      const siteId = normalizedSiteId(room.siteId || parseRoomId(room.roomId).siteId || 'E1');
      const userIds = userIdsFromRoom(room);
      for (const uid of userIds) fallbackUserIds.add(uid);

      const priorUsers = fallbackUsersBySiteMap.get(siteId) || {
        siteId,
        users: 0,
        openRooms: 0,
        closedRooms: 0,
      };
      priorUsers.users += userIds.length;
      if (String(room.stage || '') === 'CLOSED') priorUsers.closedRooms += 1;
      else priorUsers.openRooms += 1;
      fallbackUsersBySiteMap.set(siteId, priorUsers);

      const priorState = roomStateBySite.get(siteId) || { openRooms: 0, closedRooms: 0 };
      if (String(room.stage || '') === 'CLOSED') priorState.closedRooms += 1;
      else priorState.openRooms += 1;
      roomStateBySite.set(siteId, priorState);
    }

    const sessionsBySiteMap = new Map();
    for (const row of activeSessionRows) {
      const prior = sessionsBySiteMap.get(row.siteId) || 0;
      sessionsBySiteMap.set(row.siteId, prior + 1);
    }

    const usersBySiteRows = [];
    if (activeSessionRows.length) {
      const sites = new Set([...roomStateBySite.keys(), ...sessionsBySiteMap.keys()]);
      for (const siteId of sites) {
        const roomState = roomStateBySite.get(siteId) || { openRooms: 0, closedRooms: 0 };
        usersBySiteRows.push({
          siteId,
          users: Number(sessionsBySiteMap.get(siteId) || 0),
          openRooms: roomState.openRooms,
          closedRooms: roomState.closedRooms,
        });
      }
      usersBySiteRows.sort((a, b) => a.siteId.localeCompare(b.siteId));
    } else {
      usersBySiteRows.push(
        ...Array.from(fallbackUsersBySiteMap.values()).sort((a, b) =>
          a.siteId.localeCompare(b.siteId)
        )
      );
    }

    const roomRows = activeRooms
      .map((room) => ({
        roomId: room.roomId,
        siteId: normalizedSiteId(room.siteId || parseRoomId(room.roomId).siteId),
        index: Number(room.index || parseRoomId(room.roomId).index || 1),
        stage: room.stage || 'LOBBY',
        seats: getSeatCount(room),
        topic: room.topic || '',
        voteOpen: !!room.voteOpen,
        updatedAt: Number(room.updatedAt || 0) || null,
      }))
      .sort((a, b) => {
        if (a.siteId === b.siteId) return Number(a.index || 0) - Number(b.index || 0);
        return a.siteId.localeCompare(b.siteId);
      })
      .slice(0, 400);

    const currentUsers = activeSessionRows.slice(0, 400).map((row) => ({
      uid: row.uid,
      role: row.role,
      siteId: row.siteId,
      licenseId: row.licenseId,
      orgId: row.orgId,
      email: row.email || '',
      lastSeenAt: row.lastSeenAt,
      lastSeenIso:
        row.lastSeenIso ||
        (row.lastSeenAt ? new Date(Number(row.lastSeenAt)).toISOString() : ''),
      ip: row.ip || '',
    }));

    let openaiEnabled = false;
    try {
      getOpenAI();
      openaiEnabled = true;
    } catch {
      openaiEnabled = false;
    }

    await writeAuditEvent({
      action: 'SUPER_ADMIN_OVERVIEW_READ',
      actor: req.user,
      target: { resourceType: 'SUPER_ADMIN_DASHBOARD', resourceId: 'overview' },
      details: { usersReturned: currentUsers.length, roomsReturned: roomRows.length },
    });

    return res.json({
      health: {
        apiOk: true,
        time: new Date().toISOString(),
        region: AWS_REGION,
        demoModeFallback: DEMO_MODE_FALLBACK,
        openaiEnabled,
        roomsTableMissing,
        codesTableMissing,
        workshopsTableMissing,
        sessionsTableMissing,
        activeWindowMs: SUPER_ADMIN_ACTIVE_WINDOW_MS,
      },
      stats: {
        roomsTotal: roomRowsAll.length,
        roomsActive: activeRooms.length,
        usersActive: activeSessionRows.length ? activeUserIds.size : fallbackUserIds.size,
        sitesActive: usersBySiteRows.length,
        licensesTotal: licenseRows.length,
        codesTotal: recentCodesRaw.length,
        codesConsumed: consumedCodes,
        codesAvailable: Math.max(0, recentCodesRaw.length - consumedCodes),
        sessionsObserved,
        sessionsActive: activeSessionRows.length,
      },
      codeRoleCounts,
      usersBySite: usersBySiteRows,
      currentUsers,
      activeRooms: roomRows,
      licenses: licenseRows.slice(0, 200),
      recentCodes,
    });
  } catch (err) {
    console.error('[/super-admin/overview] error:', err);
    return res.status(500).json({ error: 'super_admin_overview_failed' });
  }
});


app.get('/super-admin/codes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 200, { min: 1, max: 1000 });
    const roleFilter = String(req.query?.role || '').trim().toUpperCase();
    const siteFilter = normalizedSiteId(req.query?.siteId || '');
    const licenseFilter = normalizedLicenseId(req.query?.licenseId || '');
    const consumedFilterRaw = String(req.query?.consumed || '').trim().toLowerCase();
    const revokedFilterRaw = String(req.query?.revoked || '').trim().toLowerCase();
    const includeExpired = String(req.query?.includeExpired || '').trim().toLowerCase() === 'true';
    const consumedFilter =
      consumedFilterRaw === 'true' ? true : consumedFilterRaw === 'false' ? false : null;
    const revokedFilter =
      revokedFilterRaw === 'true' ? true : revokedFilterRaw === 'false' ? false : null;

    const cursor = decodeCursor(req.query?.cursor);
    const roles = ['PARTICIPANT', 'PRESENTER', 'ADMIN', 'SUPER_ADMIN'];
    const postFilter = (item) => {
      if (typeof consumedFilter === 'boolean' && !!item.consumed !== consumedFilter) return false;
      if (typeof revokedFilter === 'boolean' && !!item.revoked !== revokedFilter) return false;
      if (!includeExpired && codeIsExpired(item)) return false;
      return true;
    };

    let rows = [];
    let nextCursor = '';
    if (roleFilter || siteFilter || licenseFilter) {
      const indexName = roleFilter
        ? 'byRoleCreatedAt'
        : siteFilter
        ? 'bySiteCreatedAt'
        : 'byLicenseCreatedAt';
      const partitionKey = roleFilter ? 'role' : siteFilter ? 'siteId' : 'licenseId';
      const partitionValue = roleFilter || siteFilter || licenseFilter;
      const cursorKey =
        cursor &&
        cursor.kind === 'single' &&
        cursor.indexName === indexName &&
        cursor.partitionValue === partitionValue
          ? cursor.lastKey
          : undefined;

      const page = await queryByPartitionKey({
        tableName: TABLES.codes,
        indexName,
        partitionKey,
        partitionValue,
        limit: Math.max(limit * 2, 150),
        scanForward: false,
        exclusiveStartKey: cursorKey,
      });
      rows = (page.items || [])
        .filter(postFilter)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, limit)
        .map(mapCodeRow);
      if (page.lastKey) {
        nextCursor = encodeCursor({
          kind: 'single',
          indexName,
          partitionValue,
          lastKey: page.lastKey,
        });
      }
    } else {
      const roleState = cursor && cursor.kind === 'role_merge' ? cursor.roleState || {} : {};
      const out = [];
      const nextRoleState = {};
      const perRoleLimit = Math.max(60, Math.ceil(limit / roles.length) + 25);

      for (const role of roles) {
        const lastKey = roleState[role] || undefined;
        const page = await queryByPartitionKey({
          tableName: TABLES.codes,
          indexName: 'byRoleCreatedAt',
          partitionKey: 'role',
          partitionValue: role,
          limit: perRoleLimit,
          scanForward: false,
          exclusiveStartKey: lastKey,
        });
        out.push(...(page.items || []));
        if (page.lastKey) {
          nextRoleState[role] = page.lastKey;
        }
      }

      rows = out
        .filter(postFilter)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, limit)
        .map(mapCodeRow);
      if (Object.keys(nextRoleState).length) {
        nextCursor = encodeCursor({
          kind: 'role_merge',
          roleState: nextRoleState,
        });
      }
    }

    await writeAuditEvent({
      action: 'SUPER_ADMIN_CODES_READ',
      actor: req.user,
      target: { resourceType: 'CODE', resourceId: 'list' },
      details: {
        filters: {
          role: roleFilter || '',
          siteId: siteFilter || '',
          licenseId: licenseFilter || '',
          consumed: consumedFilterRaw || '',
          revoked: revokedFilterRaw || '',
        },
        returned: rows.length,
      },
    });

    return res.json({ codes: rows, nextCursor: nextCursor || null });
  } catch (err) {
    console.error('[/super-admin/codes] error:', err);
    if (err?.name === 'ResourceNotFoundException') {
      return res.json({ codes: [], nextCursor: null });
    }
    return res.status(500).json({ error: 'super_admin_codes_list_failed' });
  }
});

app.post('/super-admin/codes/:code/revoke', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const code = String(req.params?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code_required' });

    const now = Date.now();
    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.codes,
        Key: { code },
        UpdateExpression: 'SET revoked = :true, revokedAt = :now, revokedBy = :by',
        ConditionExpression: 'attribute_exists(code)',
        ExpressionAttributeValues: {
          ':true': true,
          ':now': now,
          ':by': req.user.uid,
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    await writeAuditEvent({
      action: 'SUPER_ADMIN_CODE_REVOKE',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: code,
        orgId: normalizedOrgId(Attributes?.orgId || '', Attributes?.licenseId || ''),
        licenseId: normalizedLicenseId(Attributes?.licenseId || ''),
        siteId: normalizedSiteId(Attributes?.siteId || ''),
      },
      details: { revoked: true },
    });
    publishSuperAdminStreamEvent({
      source: 'code_revoke',
      code,
      revoked: true,
      licenseId: normalizedLicenseId(Attributes?.licenseId || ''),
      orgId: normalizedOrgId(Attributes?.orgId || '', Attributes?.licenseId || ''),
      siteId: normalizedSiteId(Attributes?.siteId || ''),
    });

    return res.json({ ok: true, code: mapCodeRow(Attributes || { code, revoked: true }) });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'code_not_found' });
    }
    console.error('[/super-admin/codes/:code/revoke] error:', err);
    return res.status(500).json({ error: 'code_revoke_failed' });
  }
});

app.post('/super-admin/codes/:code/unrevoke', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const code = String(req.params?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code_required' });

    const { Attributes } = await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.codes,
        Key: { code },
        UpdateExpression: 'SET revoked = :false REMOVE revokedAt, revokedBy',
        ConditionExpression: 'attribute_exists(code)',
        ExpressionAttributeValues: {
          ':false': false,
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    await writeAuditEvent({
      action: 'SUPER_ADMIN_CODE_UNREVOKE',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: code,
        orgId: normalizedOrgId(Attributes?.orgId || '', Attributes?.licenseId || ''),
        licenseId: normalizedLicenseId(Attributes?.licenseId || ''),
        siteId: normalizedSiteId(Attributes?.siteId || ''),
      },
      details: { revoked: false },
    });
    publishSuperAdminStreamEvent({
      source: 'code_revoke',
      code,
      revoked: false,
      licenseId: normalizedLicenseId(Attributes?.licenseId || ''),
      orgId: normalizedOrgId(Attributes?.orgId || '', Attributes?.licenseId || ''),
      siteId: normalizedSiteId(Attributes?.siteId || ''),
    });

    return res.json({ ok: true, code: mapCodeRow(Attributes || { code, revoked: false }) });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'code_not_found' });
    }
    console.error('[/super-admin/codes/:code/unrevoke] error:', err);
    return res.status(500).json({ error: 'code_unrevoke_failed' });
  }
});

app.get('/super-admin/audit', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 150, { min: 1, max: 500 });
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    const actorUid = String(req.query?.actorUid || '').trim();
    const action = String(req.query?.action || '').trim().toUpperCase();
    const format = String(req.query?.format || 'json').trim().toLowerCase();
    const startAt = Number(req.query?.startAt || 0);
    const endAt = Number(req.query?.endAt || 0);
    const cursor = decodeCursor(req.query?.cursor);

    let indexName = '';
    let partitionKey = '';
    let partitionValue = '';
    if (actorUid) {
      indexName = 'byActorCreatedAt';
      partitionKey = 'actorUid';
      partitionValue = actorUid;
    } else if (action) {
      indexName = 'byActionCreatedAt';
      partitionKey = 'action';
      partitionValue = action;
    } else if (orgId) {
      indexName = 'byOrgCreatedAt';
      partitionKey = 'orgId';
      partitionValue = orgId;
    } else {
      return res.status(400).json({
        error: 'filter_required',
        message: 'Provide orgId, actorUid, or action.',
      });
    }

    const page = await queryByPartitionKey({
      tableName: TABLES.audit,
      indexName,
      partitionKey,
      partitionValue,
      limit,
      scanForward: false,
      exclusiveStartKey:
        cursor &&
        cursor.kind === 'audit' &&
        cursor.indexName === indexName &&
        cursor.partitionValue === partitionValue
          ? cursor.lastKey
          : undefined,
    });

    let items = (page.items || []).map((item) => ({
      scopeId: item.scopeId || '',
      createdAtAudit: item.createdAtAudit || '',
      createdAt: Number(item.createdAt || 0) || null,
      action: String(item.action || ''),
      actorUid: String(item.actorUid || ''),
      actorRole: String(item.actorRole || ''),
      actorEmail: normalizeSuperAdminEmail(item.actorEmail || ''),
      orgId: normalizedOrgId(item.orgId || '', item.licenseId || ''),
      licenseId: normalizedLicenseId(item.licenseId || ''),
      siteId: normalizedSiteId(item.siteId || ''),
      roomId: String(item.roomId || ''),
      resourceType: String(item.resourceType || ''),
      resourceId: String(item.resourceId || ''),
      details: String(item.details || ''),
    }));
    if (Number.isFinite(startAt) && startAt > 0) {
      items = items.filter((item) => Number(item.createdAt || 0) >= startAt);
    }
    if (Number.isFinite(endAt) && endAt > 0) {
      items = items.filter((item) => Number(item.createdAt || 0) <= endAt);
    }

    const nextCursor = page.lastKey
      ? encodeCursor({
          kind: 'audit',
          indexName,
          partitionValue,
          lastKey: page.lastKey,
        })
      : null;

    await writeAuditEvent({
      action: 'SUPER_ADMIN_AUDIT_READ',
      actor: req.user,
      target: { resourceType: 'AUDIT', resourceId: indexName },
      details: {
        format,
        actorUid,
        action,
        orgId,
        returned: items.length,
      },
    });

    if (format === 'csv') {
      const headers = [
        'createdAt',
        'action',
        'actorUid',
        'actorRole',
        'actorEmail',
        'orgId',
        'licenseId',
        'siteId',
        'roomId',
        'resourceType',
        'resourceId',
        'details',
      ];
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [
        headers.join(','),
        ...items.map((item) =>
          headers.map((h) => esc(item[h])).join(',')
        ),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
      return res.status(200).send(csv);
    }

    return res.json({ items, nextCursor });
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      return res.json({ items: [], nextCursor: null });
    }
    console.error('[/super-admin/audit] error:', err);
    return res.status(500).json({ error: 'super_admin_audit_failed' });
  }
});

app.post('/super-admin/tenants/purge', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.body?.orgId || '', req.body?.licenseId || '');
    const licenseId = normalizedLicenseId(req.body?.licenseId || '');
    const confirm = String(req.body?.confirm || '').trim().toUpperCase();
    if (!orgId && !licenseId) {
      return res.status(400).json({ error: 'org_or_license_required' });
    }
    if (confirm !== 'PURGE') {
      return res.status(400).json({ error: 'confirm_purge_required' });
    }

    if (licenseId) {
      const workshop = await getWorkshopByLicenseCached(licenseId);
      if (workshop && workshop.legalHold) {
        return res.status(423).json({ error: 'legal_hold_enabled' });
      }
    }

    await writeAuditEvent({
      action: 'SUPER_ADMIN_PURGE_REQUEST',
      actor: req.user,
      target: {
        resourceType: 'TENANT',
        resourceId: licenseId || orgId,
        orgId,
        licenseId,
      },
      details: {
        requestedAt: Date.now(),
        runbook: 'scripts/purgeOrgData.mjs',
      },
    });

    return res.json({
      ok: true,
      queued: true,
      orgId: orgId || null,
      licenseId: licenseId || null,
      runCommand: licenseId
        ? `node scripts/purgeOrgData.mjs --licenseId=${licenseId} --apply=true`
        : `node scripts/purgeOrgData.mjs --orgId=${orgId} --apply=true`,
    });
  } catch (err) {
    console.error('[/super-admin/tenants/purge] error:', err);
    return res.status(500).json({ error: 'tenant_purge_request_failed' });
  }
});

app.post('/super-admin/codes/generate', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim().toUpperCase() || 'PARTICIPANT';
    if (!['PARTICIPANT', 'PRESENTER', 'ADMIN'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }

    const count = toPositiveInt(req.body?.count, 1, { min: 1, max: 500 });
    const siteId = normalizedSiteId(req.body?.siteId || '');
    const siteIds = sanitizeSiteIds(req.body?.siteIds, siteId ? [siteId] : []);
    const licenseId = normalizedLicenseId(req.body?.licenseId || siteId || siteIds[0] || '');
    const orgId = normalizedOrgId(req.body?.orgId || '', licenseId);
    const defaultMode = normalizeMode(req.body?.defaultMode || DEFAULT_WORKSHOP_MODE);
    const expiresAtMs = Number(req.body?.expiresAt || 0) || 0;
    const createdBy = normalizeSuperAdminEmail(req.user?.email || SUPER_ADMIN_EMAIL);

    if (!siteIds.length && !siteId) {
      return res.status(400).json({ error: 'site_required_for_role' });
    }

    const generated = [];
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const record = await createCodeRecord({
        role,
        siteId: siteId || siteIds[0] || '',
        siteIds,
        licenseId,
        orgId,
        defaultMode,
        createdBy,
        expiresAtMs,
      });
      generated.push(record);
    }

    await writeAuditEvent({
      action: 'SUPER_ADMIN_CODES_GENERATE',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: role,
        siteId: siteId || siteIds[0] || '',
        licenseId,
        orgId,
      },
      details: {
        count: generated.length,
        defaultMode,
      },
    });
    publishSuperAdminStreamEvent({
      source: 'code_generate',
      role,
      count: generated.length,
      licenseId,
      orgId,
      siteId: siteId || siteIds[0] || '',
    });

    return res.json({
      ok: true,
      count: generated.length,
      codes: generated,
    });
  } catch (err) {
    console.error('[/super-admin/codes/generate] error:', err);
    return res.status(500).json({ error: 'super_admin_code_generation_failed' });
  }
});

app.post('/admin/auth/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }
    const normalizedCode = code.trim().toUpperCase();

    const item = await getCodeRecordByInput(normalizedCode);
    if (!item) {
      return res.status(404).json({ error: 'Code not found or invalid' });
    }
    const unusableReason = classifyCodeUnusable(item);
    if (unusableReason) {
      const status = unusableReason === 'code_revoked' || unusableReason === 'code_expired' ? 410 : 400;
      return res.status(status).json({ error: unusableReason });
    }

    const role = String(item.role || '').trim().toUpperCase();
    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'admin_code_required' });
    }

    const consumeRes = await consumeCodeForUser(item, req.user.uid);
    if (consumeRes.conflict) {
      return res
        .status(409)
        .json({ error: consumeRes.reason || 'code_already_consumed' });
    }
    if (!consumeRes.ok && consumeRes.error) {
      return res.status(500).json({ error: 'code_consume_failed' });
    }

    const siteIds = normalizeCodeSiteIds(item);
    const licenseId = normalizeLicenseFromCode(item, normalizedCode);
    const orgId = normalizeOrgFromCode(item, licenseId);
    if (!licenseId) {
      return res.status(400).json({ error: 'license_missing_on_code' });
    }

    const defaultMode = normalizeMode(item.defaultMode || DEFAULT_WORKSHOP_MODE);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds,
      mode: defaultMode,
    });
    const licenseState = evaluateWorkshopLicenseState(workshop);
    if (!licenseState.ok) {
      return res.status(licenseState.statusCode || 403).json({ error: licenseState.error });
    }
    const activeCapCheck = await enforceLicenseActiveUserCap({
      licenseId,
      activeUserCap:
        Number(workshop?.activeUserCap || workshop?.expectedUsers || 0) || 0,
      uid: req.user.uid,
    });
    if (!activeCapCheck.ok) {
      return res.status(429).json({
        error: activeCapCheck.error,
        activeUsers: activeCapCheck.activeUsers,
        activeUserCap: activeCapCheck.cap,
      });
    }
    const entitlementCheck = await enforceRuntimeLicenseEntitlements({
      role: 'ADMIN',
      licenseId,
      orgId,
      siteId: siteIds[0] || '',
      workshop,
      automate: true,
      bypassAdmin: true,
    });
    if (!entitlementCheck.ok) {
      return res.status(entitlementCheck.statusCode || 403).json({
        error: entitlementCheck.error || 'license_forbidden',
      });
    }

    const roomsPerSite = toPositiveInt(workshop?.roomsPerSite, 5, {
      min: 1,
      max: MAX_ROOMS_PER_SITE,
    });
    for (const sid of sanitizeSiteIds(workshop?.siteIds, siteIds)) {
      for (let i = 1; i <= roomsPerSite; i++) {
        await syncRoomWorkshopConfig(`${sid}-${i}`, workshop);
      }
    }
    clearWorkshopTenantCache(licenseId);

    const pair = await issueTokenPair(
      {
        uid: req.user.uid,
        role: 'ADMIN',
        siteId: siteIds[0] || null,
        licenseId,
        orgId,
      },
      req
    );

    await writeAuditEvent({
      action: 'ADMIN_CODE_CONSUME',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: normalizedCode,
        orgId,
        licenseId,
        siteId: siteIds[0] || '',
      },
      details: {
        consumedRole: role,
      },
    });
    publishSuperAdminStreamEvent({
      source: 'admin_code_consume',
      role: 'ADMIN',
      siteId: siteIds[0] || '',
      licenseId,
      orgId,
    });

    return res.json({
      ok: true,
      role: 'ADMIN',
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      expiresIn: pair.accessTtlSeconds,
      userId: req.user.uid,
      licenseId,
      orgId,
      workshop,
    });
  } catch (err) {
    console.error('[/admin/auth/consume] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/workshop/modes', requireAuth, requireAdmin, requireAdminLicense, (_req, res) => {
  const modes = Object.values(WORKSHOP_MODE_TEMPLATES).map((mode) => ({
    id: mode.id,
    label: mode.label,
    description: mode.description,
    defaultPhases: mode.defaultPhases,
    defaultTopics: mode.defaultTopics || [],
  }));
  res.json({ modes });
});

app.get('/admin/workshop', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const fallbackSiteIds = req.user.siteId ? [req.user.siteId] : [];
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId: req.user.orgId,
      siteIds: fallbackSiteIds,
    });
    await writeAuditEvent({
      action: 'ADMIN_WORKSHOP_READ',
      actor: req.user,
      target: {
        resourceType: 'WORKSHOP',
        resourceId: licenseId,
        licenseId,
        orgId: req.user.orgId,
      },
      details: { mode: workshop?.mode || '' },
    });
    return res.json({ workshop });
  } catch (err) {
    console.error('[/admin/workshop GET] error:', err);
    return res.status(500).json({ error: 'workshop_fetch_failed' });
  }
});

app.put('/admin/workshop', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const next = await saveWorkshopConfig(licenseId, {
      ...(req.body || {}),
      orgId: normalizedOrgId(req.user.orgId || '', licenseId),
    });

    for (const siteId of next.siteIds || []) {
      for (let i = 1; i <= next.roomsPerSite; i++) {
        const roomId = `${siteId}-${i}`;
        await syncRoomWorkshopConfig(roomId, next);
        if (stageEngine?.touch) stageEngine.touch(roomId);
      }
    }
    clearWorkshopTenantCache(licenseId);

    await writeAuditEvent({
      action: 'ADMIN_WORKSHOP_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'WORKSHOP',
        resourceId: licenseId,
        orgId: next.orgId,
        licenseId,
      },
      details: {
        mode: next.mode,
        roomCount: next.roomsPerSite,
        seatLimitPerRoom: next.seatLimitPerRoom,
        siteCount: Array.isArray(next.siteIds) ? next.siteIds.length : 0,
      },
    });

    return res.json({ ok: true, workshop: next });
  } catch (err) {
    console.error('[/admin/workshop PUT] error:', err);
    return res.status(500).json({ error: err?.message || 'workshop_update_failed' });
  }
});

app.put('/admin/retention', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const next = await saveWorkshopConfig(licenseId, {
      orgId: normalizedOrgId(req.user.orgId || '', licenseId),
      messageRetentionDays: req.body?.messageRetentionDays,
      draftRetentionDays: req.body?.draftRetentionDays,
      sessionRetentionHours: req.body?.sessionRetentionHours,
      auditRetentionDays: req.body?.auditRetentionDays,
      legalHold: req.body?.legalHold,
    });
    clearWorkshopTenantCache(licenseId);
    for (const siteId of next.siteIds || []) {
      for (let i = 1; i <= next.roomsPerSite; i++) {
        const roomId = `${siteId}-${i}`;
        // eslint-disable-next-line no-await-in-loop
        await syncRoomWorkshopConfig(roomId, next);
      }
    }
    await writeAuditEvent({
      action: 'ADMIN_RETENTION_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'WORKSHOP',
        resourceId: licenseId,
        orgId: next.orgId,
        licenseId,
      },
      details: {
        messageRetentionDays: next.messageRetentionDays,
        draftRetentionDays: next.draftRetentionDays,
        sessionRetentionHours: next.sessionRetentionHours,
        auditRetentionDays: next.auditRetentionDays,
        legalHold: !!next.legalHold,
      },
    });
    return res.json({ ok: true, retention: {
      messageRetentionDays: next.messageRetentionDays,
      draftRetentionDays: next.draftRetentionDays,
      sessionRetentionHours: next.sessionRetentionHours,
      auditRetentionDays: next.auditRetentionDays,
      legalHold: !!next.legalHold,
    } });
  } catch (err) {
    console.error('[/admin/retention] error:', err);
    return res.status(500).json({ error: 'retention_update_failed' });
  }
});

function parseSiteIdsInput(input, fallback = []) {
  if (Array.isArray(input)) return sanitizeSiteIds(input, fallback);
  if (typeof input === 'string') {
    const values = input
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return sanitizeSiteIds(values, fallback);
  }
  return sanitizeSiteIds(fallback, []);
}

function mapBillingEventRow(row = {}) {
  return {
    orgId: normalizedOrgId(row.orgId || '', row.licenseId || ''),
    billingEventId: String(row.billingEventId || ''),
    licenseId: normalizedLicenseId(row.licenseId || ''),
    eventType: String(row.eventType || '').toUpperCase(),
    amountCents: Number(row.amountCents || 0) || 0,
    currency: String(row.currency || 'USD').toUpperCase(),
    status: String(row.status || '').toUpperCase(),
    payload: parseJsonObject(row.payload, {}),
    actorUid: String(row.actorUid || ''),
    createdAt: Number(row.createdAt || 0) || null,
    updatedAt: Number(row.updatedAt || 0) || null,
  };
}

function mapSupportTicketRow(row = {}) {
  const now = Date.now();
  const deadlines = resolveSupportTicketDeadlines(row, now);
  const sla = computeSupportSlaState(
    {
      ...row,
      responseDueAt: deadlines.responseDueAt,
      resolutionDueAt: deadlines.resolutionDueAt,
      escalateAfterAt: deadlines.escalateAfterAt,
    },
    now
  );
  return {
    orgId: normalizedOrgId(row.orgId || '', row.licenseId || ''),
    ticketId: String(row.ticketId || ''),
    licenseId: normalizedLicenseId(row.licenseId || ''),
    subject: String(row.subject || ''),
    description: String(row.description || ''),
    priority: normalizeTicketPriority(row.priority),
    ticketStatus: normalizeTicketStatus(row.ticketStatus),
    requesterEmail: normalizeSuperAdminEmail(row.requesterEmail || ''),
    owner: String(row.owner || ''),
    escalationTarget: String(row.escalationTarget || SUPPORT_ESCALATION_EMAIL),
    escalationLevel: Number(row.escalationLevel || 0) || 0,
    firstResponseAt: Number(row.firstResponseAt || 0) || null,
    responseDueAt: Number(deadlines.responseDueAt || 0) || null,
    resolutionDueAt: Number(deadlines.resolutionDueAt || 0) || null,
    escalateAfterAt: Number(deadlines.escalateAfterAt || 0) || null,
    resolvedAt: Number(row.resolvedAt || 0) || null,
    slaState: String(row.slaState || sla.slaState || 'ON_TRACK'),
    slaBreached:
      typeof row.slaBreached === 'boolean' ? row.slaBreached : !!sla.slaBreached,
    responseBreached: !!sla.responseBreached,
    resolutionBreached: !!sla.resolutionBreached,
    autoEscalated: !!row.autoEscalated,
    updatedBy: String(row.updatedBy || ''),
    lastNote: String(row.lastNote || ''),
    createdAt: Number(row.createdAt || 0) || null,
    updatedAt: Number(row.updatedAt || 0) || null,
  };
}

function mapStatusEventRow(row = {}) {
  return {
    scopeId: String(row.scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL',
    statusKey: String(row.statusKey || ''),
    payload: parseJsonObject(row.payload, {}),
    createdAt: Number(row.createdAt || 0) || null,
    updatedAt: Number(row.updatedAt || 0) || null,
  };
}

function parseTemplateVersion(templateKey = '') {
  const match = String(templateKey || '').match(/#v([0-9]+)$/i);
  if (!match) return 0;
  return Number(match[1] || 0) || 0;
}

function sortTemplatesByVersionDesc(rows = []) {
  return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
    const av = Number(a.version || parseTemplateVersion(a.templateKey) || 0);
    const bv = Number(b.version || parseTemplateVersion(b.templateKey) || 0);
    return bv - av;
  });
}

function templateRowsById(rows = [], templateIdRaw = '') {
  const templateId = String(templateIdRaw || '').trim();
  if (!templateId) return [];
  return sortTemplatesByVersionDesc(rows.filter((row) => String(row.templateId || '').trim() === templateId));
}

function renderApprovalGate(gate = {}) {
  return {
    ok: false,
    error: gate.error || 'approval_required',
    approvalRequired: !!gate.approvalRequired,
    approval: gate.approval || null,
  };
}

app.get('/admin/console', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const fallbackSiteIds = req.user.siteId ? [req.user.siteId] : [];
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: fallbackSiteIds,
    });
    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds: workshop?.siteIds || fallbackSiteIds,
      tier: workshop?.tier || 'STARTER',
    });
    const license = await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: Number(workshop?.expectedUsers || 30),
      activeUserCap: Number(workshop?.activeUserCap || workshop?.expectedUsers || 30),
      tier: org?.tier || 'STARTER',
    });

    const orgScope = makeScopeId({ orgId, licenseId });
    const licenseScope = makeScopeId({ licenseId });
    const tierScope = makeScopeId({ tier: license?.tier || org?.tier || 'STARTER' });
    const [usersPage, templates, approvals, billingRows, supportRows, statusRows, policyRow, effectiveFlags, orgFlagRows, licenseFlagRows, tierFlagRows, usage, codesPage] =
      await Promise.all([
        listOrgUsers(orgId, 250).catch(() => ({ items: [] })),
        listTemplatesForOrg(orgId, 300).catch(() => []),
        listApprovalsForOrg(orgId, 240).catch(() => []),
        listBillingEventsByOrg(orgId, 240).catch(() => []),
        listSupportTicketsByOrg(orgId, 240).catch(() => []),
        listStatusEvents('GLOBAL', 80).catch(() => []),
        getPolicy(orgScope, 'AI').catch(() => null),
        getEffectiveFeatureFlags({
          orgId,
          licenseId,
          tier: license?.tier || org?.tier || 'STARTER',
        }).catch(() => ({})),
        listFeatureFlags(orgScope).catch(() => []),
        listFeatureFlags(licenseScope).catch(() => []),
        listFeatureFlags(tierScope).catch(() => []),
        getLicenseUsageSnapshot({
          licenseId,
          orgId,
          siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
        }).catch(() => ({
          activeUsers: 0,
          assignedSeats: 0,
          activeRooms: 0,
          aiUsageCostCents30d: 0,
        })),
        queryByPartitionKey({
          tableName: TABLES.codes,
          indexName: 'byLicenseCreatedAt',
          partitionKey: 'licenseId',
          partitionValue: licenseId,
          limit: 300,
          scanForward: false,
        }).catch(() => ({ items: [] })),
      ]);

    const aiPolicy = normalizeAiPolicy(parseJsonObject(policyRow?.policy, AI_POLICY_DEFAULT));
    const users = Array.isArray(usersPage?.items) ? usersPage.items : [];
    const approvalsSorted = (Array.isArray(approvals) ? approvals : [])
      .slice()
      .sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
    const codes = (Array.isArray(codesPage?.items) ? codesPage.items : [])
      .filter((row) => normalizedLicenseId(row.licenseId || '') === licenseId)
      .filter(
        (row) => normalizedOrgId(row.orgId || '', row.licenseId || '') === orgId
      )
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .map(mapCodeRow);
    const resolvedSiteIds = sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []);
    const billingSummary = await buildBillingTransparencySummary({
      orgId,
      licenseId,
      workshop,
      license,
      usage,
      siteIds: resolvedSiteIds,
      actor: req.user,
      automate: true,
    }).catch(() => ({
      periodKey: billingPeriodKeyUtc(),
      entitlements: {},
      usage: {},
      overage: {},
      automation: { enabled: BILLING_AUTOMATION_ENABLED, ran: false },
      meterHistory: [],
      invoices: [],
      recentEvents: [],
    }));
    const outcomes = await buildOutcomesAnalytics({
      orgId,
      licenseId,
      siteIds: resolvedSiteIds,
      usage,
      windowDays: OUTCOMES_WINDOW_DAYS,
    }).catch(() => ({
      generatedAt: nowIso(),
      windowDays: OUTCOMES_WINDOW_DAYS,
      org: summarizeOutcomeRows([], usage || {}),
      bySite: [],
      methodology: 'heuristic_v1',
    }));
    const billingEvents = Array.isArray(billingSummary?.recentEvents)
      ? billingSummary.recentEvents
      : (Array.isArray(billingRows) ? billingRows : []).map(mapBillingEventRow);

    await writeAuditEvent({
      action: 'ADMIN_CONSOLE_READ',
      actor: req.user,
      target: {
        resourceType: 'ADMIN_CONSOLE',
        resourceId: orgId,
        orgId,
        licenseId,
      },
      details: {
        users: users.length,
        templates: Array.isArray(templates) ? templates.length : 0,
        approvals: approvalsSorted.length,
        codes: codes.length,
      },
    });

    return res.json({
      demoModeFallback: DEMO_MODE_FALLBACK,
      org,
      license,
      workshop,
      usage,
      users,
      templates: sortTemplatesByVersionDesc(Array.isArray(templates) ? templates : []),
      approvals: approvalsSorted,
      billingEvents,
      billingSummary,
      outcomes,
      supportTickets: (Array.isArray(supportRows) ? supportRows : []).map(mapSupportTicketRow),
      codes: codes.slice(0, 220),
      statusEvents: (Array.isArray(statusRows) ? statusRows : []).map(mapStatusEventRow),
      featureFlags: {
        effective: effectiveFlags,
        tierDefaults: FEATURE_FLAG_DEFAULTS_BY_TIER[normalizeLicenseTier(license?.tier || org?.tier || 'STARTER')] || {},
        tierOverrides: (Array.isArray(tierFlagRows) ? tierFlagRows : []).map((row) => ({
          scopeId: row.scopeId,
          flagKey: row.flagKey,
          enabled: !!row.enabled,
          updatedAt: Number(row.updatedAt || 0) || null,
        })),
        orgOverrides: (Array.isArray(orgFlagRows) ? orgFlagRows : []).map((row) => ({
          scopeId: row.scopeId,
          flagKey: row.flagKey,
          enabled: !!row.enabled,
          updatedAt: Number(row.updatedAt || 0) || null,
        })),
        licenseOverrides: (Array.isArray(licenseFlagRows) ? licenseFlagRows : []).map((row) => ({
          scopeId: row.scopeId,
          flagKey: row.flagKey,
          enabled: !!row.enabled,
          updatedAt: Number(row.updatedAt || 0) || null,
        })),
      },
      aiPolicy,
      policyScope: orgScope,
      supportEscalationEmail: SUPPORT_ESCALATION_EMAIL,
      statusPageUrl: STATUS_PAGE_URL,
      config: {
        licenseTiers: LICENSE_TIERS,
        licenseStates: LICENSE_STATES,
        templateStates: TEMPLATE_STATES,
      },
    });
  } catch (err) {
    console.error('[/admin/console] error:', err);
    return res.status(500).json({ error: 'admin_console_failed' });
  }
});

app.post('/admin/codes/generate', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const role = String(req.body?.role || 'PARTICIPANT').trim().toUpperCase();
    if (!['PARTICIPANT', 'PRESENTER', 'ADMIN'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }

    const count = toPositiveInt(req.body?.count, 1, { min: 1, max: 500 });
    const requestedSiteId = normalizedSiteId(req.body?.siteId || '');
    const requestedSiteIds = sanitizeSiteIds(
      req.body?.siteIds,
      requestedSiteId ? [requestedSiteId] : []
    );
    const expiresAtMs = Number(req.body?.expiresAt || 0) || 0;

    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : requestedSiteIds,
    });
    const licenseState = evaluateWorkshopLicenseState(workshop);
    if (!licenseState.ok) {
      return res
        .status(licenseState.statusCode || 403)
        .json({ error: licenseState.error });
    }

    const allowedSites = sanitizeSiteIds(
      workshop?.siteIds,
      req.user.siteId ? [req.user.siteId] : []
    );
    if (!allowedSites.length) {
      return res.status(400).json({ error: 'no_sites_configured_for_license' });
    }

    const targetSites = requestedSiteIds.length
      ? requestedSiteIds.filter((sid) => allowedSites.includes(sid))
      : allowedSites;
    if (!targetSites.length) {
      return res.status(403).json({ error: 'site_forbidden' });
    }

    const defaultMode = normalizeMode(
      req.body?.defaultMode || workshop?.mode || DEFAULT_WORKSHOP_MODE
    );
    const generated = [];
    for (let i = 0; i < count; i += 1) {
      const siteId = targetSites[i % targetSites.length];
      // eslint-disable-next-line no-await-in-loop
      const record = await createCodeRecord({
        role,
        siteId,
        siteIds: targetSites,
        licenseId,
        orgId,
        defaultMode,
        createdBy: String(req.user?.uid || '').trim() || 'admin',
        expiresAtMs,
      });
      generated.push(mapCodeRow(record));
    }

    await writeAuditEvent({
      action: 'ADMIN_CODES_GENERATE',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: role,
        orgId,
        licenseId,
        siteId: targetSites[0] || '',
      },
      details: {
        count: generated.length,
        role,
        siteIds: targetSites,
        expiresAt: expiresAtMs || null,
      },
    });

    return res.json({
      ok: true,
      count: generated.length,
      codes: generated,
    });
  } catch (err) {
    console.error('[/admin/codes/generate] error:', err);
    return res.status(500).json({ error: 'admin_code_generation_failed' });
  }
});

app.get('/admin/users', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const limit = toPositiveInt(req.query?.limit, 200, { min: 1, max: 500 });
    const out = await listOrgUsers(orgId, limit);
    const users = Array.isArray(out.items) ? out.items : [];
    return res.json({ users, nextCursor: out.lastKey ? encodeCursor({ kind: 'org_users', lastKey: out.lastKey }) : null });
  } catch (err) {
    console.error('[/admin/users GET] error:', err);
    return res.status(500).json({ error: 'admin_users_list_failed' });
  }
});

app.put('/admin/users/:userId', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const bodyRole = normalizeOrgUserRole(req.body?.role);
    if (bodyRole === 'SUPER_ADMIN' && !isSuperAdminReq(req)) {
      return res.status(403).json({ error: 'super_admin_role_forbidden' });
    }
    const fallbackUserId = deriveOrgUserIdFromEmail(req.body?.email || '');
    const userId = normalizeOrgUserId(req.params.userId || fallbackUserId);
    if (!userId) return res.status(400).json({ error: 'userId_or_email_required' });

    const user = await saveOrgUser(
      orgId,
      userId,
      {
        email: req.body?.email,
        name: req.body?.name,
        role: bodyRole,
        siteIds: parseSiteIdsInput(req.body?.siteIds, []),
        groups: Array.isArray(req.body?.groups) ? req.body.groups : [],
        active: req.body?.active !== false,
        invitedBy: req.user.uid,
        notes: req.body?.notes,
      },
      req.user
    );

    await writeAuditEvent({
      action: 'ADMIN_USER_UPSERT',
      actor: req.user,
      target: {
        resourceType: 'ORG_USER',
        resourceId: userId,
        orgId,
        licenseId,
      },
      details: {
        role: user.role,
        active: !!user.active,
        siteCount: Array.isArray(user.siteIds) ? user.siteIds.length : 0,
      },
    });

    return res.json({ ok: true, user });
  } catch (err) {
    console.error('[/admin/users/:userId PUT] error:', err);
    return res.status(500).json({ error: 'admin_user_upsert_failed' });
  }
});

app.post('/admin/users/:userId/deactivate', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const userId = normalizeOrgUserId(req.params.userId || '');
    if (!userId) return res.status(400).json({ error: 'userId_required' });
    await deactivateOrgUser(orgId, userId);

    await writeAuditEvent({
      action: 'ADMIN_USER_DEACTIVATE',
      actor: req.user,
      target: {
        resourceType: 'ORG_USER',
        resourceId: userId,
        orgId,
        licenseId,
      },
      details: {},
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[/admin/users/:userId/deactivate] error:', err);
    return res.status(500).json({ error: 'admin_user_deactivate_failed' });
  }
});

app.put('/admin/sites', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const currentWorkshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : [],
    });
    const siteIds = parseSiteIdsInput(req.body?.siteIds, currentWorkshop?.siteIds || []);
    if (!siteIds.length) return res.status(400).json({ error: 'siteIds_required' });

    const workshop = await saveWorkshopConfig(licenseId, {
      orgId,
      siteIds,
    });
    await saveOrgRecord(orgId, {
      orgId,
      tier: req.body?.tier,
      siteIds,
      name: req.body?.name,
      supportPlan: req.body?.supportPlan,
      ownerEmail: req.body?.ownerEmail,
      primaryDomain: req.body?.primaryDomain,
      notes: req.body?.notes,
    }, req.user);
    clearWorkshopTenantCache(licenseId);

    for (const siteId of workshop.siteIds || []) {
      for (let i = 1; i <= workshop.roomsPerSite; i++) {
        // eslint-disable-next-line no-await-in-loop
        await syncRoomWorkshopConfig(`${siteId}-${i}`, workshop);
      }
    }

    await writeAuditEvent({
      action: 'ADMIN_SITES_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'WORKSHOP',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: { siteIds },
    });
    return res.json({ ok: true, siteIds, workshop });
  } catch (err) {
    console.error('[/admin/sites PUT] error:', err);
    return res.status(500).json({ error: 'admin_sites_update_failed' });
  }
});

app.get('/admin/license', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : [],
    });
    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds: workshop?.siteIds || [],
      tier: workshop?.tier || 'STARTER',
    });
    const license = await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: Number(workshop?.expectedUsers || 30),
      activeUserCap: Number(workshop?.activeUserCap || workshop?.expectedUsers || 30),
      tier: org?.tier || 'STARTER',
    });
    const usage = await getLicenseUsageSnapshot({
      licenseId,
      orgId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
    });
    return res.json({ org, license, workshop, usage });
  } catch (err) {
    console.error('[/admin/license GET] error:', err);
    return res.status(500).json({ error: 'admin_license_fetch_failed' });
  }
});

app.put('/admin/license', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const payload = {
      orgId,
      status: req.body?.status,
      tier: req.body?.tier,
      seatCap: req.body?.seatCap,
      activeUserCap: req.body?.activeUserCap,
      usageCap: req.body?.usageCap,
      expiresAt: req.body?.expiresAt,
      renewalAt: req.body?.renewalAt,
      overagePolicy: req.body?.overagePolicy,
      billingMode: req.body?.billingMode,
      billingAccountId: req.body?.billingAccountId,
      notes: req.body?.notes,
    };
    const renewDays = Number(req.body?.renewDays || 0);
    if (Number.isFinite(renewDays) && renewDays > 0) {
      const now = Date.now();
      payload.expiresAt = now + Math.round(renewDays) * 24 * 60 * 60 * 1000;
    }

    const gate = await resolveSensitiveChangeGate(req, {
      orgId,
      licenseId,
      requestType: 'LICENSE_CHANGE',
      targetType: 'LICENSE',
      targetId: licenseId,
      payload,
    });
    if (!gate.ok) {
      return res.status(gate.statusCode || 409).json(renderApprovalGate(gate));
    }

    const license = await saveLicenseRecord(licenseId, payload, req.user);
    const workshop = await saveWorkshopConfig(licenseId, {
      orgId,
      expectedUsers: license.seatCap,
      activeUserCap: license.activeUserCap,
      licenseStatus: license.status,
      licenseExpiresAt: Number(license.expiresAt || 0) || null,
    });
    clearWorkshopTenantCache(licenseId);
    if (gate.approval?.approvalId) {
      await markApprovalConsumed(orgId, gate.approval.approvalId).catch(() => null);
    }

    await writeAuditEvent({
      action: 'ADMIN_LICENSE_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'LICENSE',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: {
        status: license.status,
        tier: license.tier,
        seatCap: license.seatCap,
        activeUserCap: license.activeUserCap,
        expiresAt: license.expiresAt,
        approvalId: gate.approval?.approvalId || '',
      },
    });
    return res.json({ ok: true, license, workshop, approvalId: gate.approval?.approvalId || null });
  } catch (err) {
    console.error('[/admin/license PUT] error:', err);
    return res.status(500).json({ error: 'admin_license_update_failed' });
  }
});

app.get('/admin/feature-flags', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const license = (await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: 30,
      activeUserCap: 30,
      tier: 'STARTER',
    })) || {};

    const tier = normalizeLicenseTier(license.tier || 'STARTER');
    const orgScope = makeScopeId({ orgId, licenseId });
    const licenseScope = makeScopeId({ licenseId });
    const tierScope = makeScopeId({ tier });
    const [effective, orgRows, licenseRows, tierRows] = await Promise.all([
      getEffectiveFeatureFlags({ orgId, licenseId, tier }),
      listFeatureFlags(orgScope),
      listFeatureFlags(licenseScope),
      listFeatureFlags(tierScope),
    ]);

    return res.json({
      effective,
      tierDefaults: FEATURE_FLAG_DEFAULTS_BY_TIER[tier] || {},
      tierOverrides: tierRows,
      orgOverrides: orgRows,
      licenseOverrides: licenseRows,
      scope: {
        org: orgScope,
        license: licenseScope,
      },
    });
  } catch (err) {
    console.error('[/admin/feature-flags GET] error:', err);
    return res.status(500).json({ error: 'admin_feature_flags_fetch_failed' });
  }
});

app.put('/admin/feature-flags', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const scopeRaw = String(req.body?.scope || 'ORG').trim().toUpperCase();
    const scopeId = scopeRaw === 'LICENSE' ? makeScopeId({ licenseId }) : makeScopeId({ orgId, licenseId });
    const flags = normalizeFeatureFlagPatch(req.body?.flags || req.body || {});
    if (!Object.keys(flags).length) {
      return res.status(400).json({ error: 'flags_required' });
    }
    const saved = await saveFeatureFlags(scopeId, flags, req.user);
    const license = await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: 30,
      activeUserCap: 30,
      tier: 'STARTER',
    });
    const effective = await getEffectiveFeatureFlags({
      orgId,
      licenseId,
      tier: license?.tier || 'STARTER',
    });

    await writeAuditEvent({
      action: 'ADMIN_FEATURE_FLAGS_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'FEATURE_FLAGS',
        resourceId: scopeId,
        orgId,
        licenseId,
      },
      details: { flags },
    });
    return res.json({ ok: true, scopeId, saved, effective });
  } catch (err) {
    console.error('[/admin/feature-flags PUT] error:', err);
    return res.status(500).json({ error: 'admin_feature_flags_update_failed' });
  }
});

app.get('/admin/policies/ai', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const scopeId = makeScopeId({ orgId, licenseId });
    const policyRow = await getPolicy(scopeId, 'AI');
    const policy = normalizeAiPolicy(parseJsonObject(policyRow?.policy, AI_POLICY_DEFAULT));
    return res.json({ scopeId, policy, updatedAt: Number(policyRow?.updatedAt || 0) || null });
  } catch (err) {
    console.error('[/admin/policies/ai GET] error:', err);
    return res.status(500).json({ error: 'admin_ai_policy_fetch_failed' });
  }
});

app.put('/admin/policies/ai', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const scopeId = makeScopeId({ orgId, licenseId });
    const policyInput = req.body?.policy && typeof req.body.policy === 'object'
      ? req.body.policy
      : req.body || {};

    const gate = await resolveSensitiveChangeGate(req, {
      orgId,
      licenseId,
      requestType: 'AI_POLICY_CHANGE',
      targetType: 'AI_POLICY',
      targetId: scopeId,
      payload: policyInput,
    });
    if (!gate.ok) {
      return res.status(gate.statusCode || 409).json(renderApprovalGate(gate));
    }

    const saved = await saveAiPolicy(scopeId, policyInput, req.user);
    if (gate.approval?.approvalId) {
      await markApprovalConsumed(orgId, gate.approval.approvalId).catch(() => null);
    }

    await writeAuditEvent({
      action: 'ADMIN_AI_POLICY_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'AI_POLICY',
        resourceId: scopeId,
        orgId,
        licenseId,
      },
      details: {
        policy: saved.policy,
        approvalId: gate.approval?.approvalId || '',
      },
    });

    return res.json({
      ok: true,
      scopeId,
      policy: saved.policy,
      approvalId: gate.approval?.approvalId || null,
    });
  } catch (err) {
    console.error('[/admin/policies/ai PUT] error:', err);
    return res.status(500).json({ error: 'admin_ai_policy_update_failed' });
  }
});

app.get('/admin/templates', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const templates = await listTemplatesForOrg(orgId, 500);
    return res.json({ templates: sortTemplatesByVersionDesc(templates) });
  } catch (err) {
    console.error('[/admin/templates GET] error:', err);
    return res.status(500).json({ error: 'admin_templates_fetch_failed' });
  }
});

app.post('/admin/templates', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const templateId = String(req.body?.templateId || '').trim() || makePrefixedId('TPL');
    const existing = await listTemplatesForOrg(orgId, 500);
    const versions = templateRowsById(existing, templateId);
    const latestVersion = Number(versions[0]?.version || 0);
    const explicitVersion = Number(req.body?.version || 0);
    const version = explicitVersion > 0 ? explicitVersion : latestVersion + 1 || 1;

    const template = await saveTemplateRecord(orgId, {
      templateId,
      version,
      name: req.body?.name,
      mode: req.body?.mode,
      description: req.body?.description,
      status: req.body?.status || 'DRAFT',
      phases: Array.isArray(req.body?.phases) ? req.body.phases : [],
      topicCatalog: Array.isArray(req.body?.topicCatalog) ? req.body.topicCatalog : [],
      metadata: parseJsonObject(req.body?.metadata, {}),
      createdBy: req.user.uid,
      updatedBy: req.user.uid,
    });

    await writeAuditEvent({
      action: 'ADMIN_TEMPLATE_CREATE',
      actor: req.user,
      target: {
        resourceType: 'TEMPLATE',
        resourceId: template.templateKey,
        orgId,
        licenseId,
      },
      details: {
        templateId: template.templateId,
        version: template.version,
        status: template.status,
      },
    });
    return res.json({ ok: true, template });
  } catch (err) {
    console.error('[/admin/templates POST] error:', err);
    return res.status(500).json({ error: 'admin_template_create_failed' });
  }
});

app.post('/admin/templates/:templateId/publish', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const templateId = String(req.params.templateId || '').trim();
    if (!templateId) return res.status(400).json({ error: 'templateId_required' });

    const all = await listTemplatesForOrg(orgId, 500);
    const rows = templateRowsById(all, templateId);
    if (!rows.length) return res.status(404).json({ error: 'template_not_found' });
    const requestedVersion = Number(req.body?.version || 0);
    const target = requestedVersion > 0
      ? rows.find((row) => Number(row.version || 0) === requestedVersion)
      : rows[0];
    if (!target) return res.status(404).json({ error: 'template_version_not_found' });

    const gate = await resolveSensitiveChangeGate(req, {
      orgId,
      licenseId,
      requestType: 'TEMPLATE_PUBLISH',
      targetType: 'TEMPLATE',
      targetId: target.templateKey,
      payload: { templateId, version: target.version },
    });
    if (!gate.ok) {
      return res.status(gate.statusCode || 409).json(renderApprovalGate(gate));
    }

    const now = Date.now();
    const published = await saveTemplateRecord(orgId, {
      ...target,
      status: 'PUBLISHED',
      publishedAt: now,
      deprecatedAt: 0,
      updatedBy: req.user.uid,
    });

    for (const row of rows) {
      if (row.templateKey === published.templateKey) continue;
      if (normalizeTemplateState(row.status) !== 'PUBLISHED') continue;
      // eslint-disable-next-line no-await-in-loop
      await saveTemplateRecord(orgId, {
        ...row,
        status: 'DEPRECATED',
        deprecatedAt: now,
        updatedBy: req.user.uid,
      });
    }
    if (gate.approval?.approvalId) {
      await markApprovalConsumed(orgId, gate.approval.approvalId).catch(() => null);
    }

    await writeAuditEvent({
      action: 'ADMIN_TEMPLATE_PUBLISH',
      actor: req.user,
      target: {
        resourceType: 'TEMPLATE',
        resourceId: published.templateKey,
        orgId,
        licenseId,
      },
      details: {
        templateId: published.templateId,
        version: published.version,
        approvalId: gate.approval?.approvalId || '',
      },
    });
    return res.json({ ok: true, template: published, approvalId: gate.approval?.approvalId || null });
  } catch (err) {
    console.error('[/admin/templates/:templateId/publish] error:', err);
    return res.status(500).json({ error: 'admin_template_publish_failed' });
  }
});

app.post('/admin/templates/:templateId/deprecate', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const templateId = String(req.params.templateId || '').trim();
    const version = Number(req.body?.version || 0);
    if (!templateId || !version) return res.status(400).json({ error: 'templateId_and_version_required' });

    const template = await getTemplateByKey(orgId, makeTemplateKey(templateId, version));
    if (!template) return res.status(404).json({ error: 'template_version_not_found' });

    const gate = await resolveSensitiveChangeGate(req, {
      orgId,
      licenseId,
      requestType: 'TEMPLATE_DEPRECATE',
      targetType: 'TEMPLATE',
      targetId: template.templateKey,
      payload: { templateId, version },
    });
    if (!gate.ok) {
      return res.status(gate.statusCode || 409).json(renderApprovalGate(gate));
    }

    const next = await saveTemplateRecord(orgId, {
      ...template,
      status: 'DEPRECATED',
      deprecatedAt: Date.now(),
      updatedBy: req.user.uid,
    });
    if (gate.approval?.approvalId) {
      await markApprovalConsumed(orgId, gate.approval.approvalId).catch(() => null);
    }

    await writeAuditEvent({
      action: 'ADMIN_TEMPLATE_DEPRECATE',
      actor: req.user,
      target: {
        resourceType: 'TEMPLATE',
        resourceId: next.templateKey,
        orgId,
        licenseId,
      },
      details: {
        templateId,
        version,
        approvalId: gate.approval?.approvalId || '',
      },
    });
    return res.json({ ok: true, template: next, approvalId: gate.approval?.approvalId || null });
  } catch (err) {
    console.error('[/admin/templates/:templateId/deprecate] error:', err);
    return res.status(500).json({ error: 'admin_template_deprecate_failed' });
  }
});

app.post('/admin/templates/:templateId/rollback', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const templateId = String(req.params.templateId || '').trim();
    const toVersion = Number(req.body?.toVersion || req.body?.version || 0);
    if (!templateId || !toVersion) return res.status(400).json({ error: 'templateId_and_toVersion_required' });

    const all = await listTemplatesForOrg(orgId, 500);
    const rows = templateRowsById(all, templateId);
    const target = rows.find((row) => Number(row.version || 0) === toVersion);
    if (!target) return res.status(404).json({ error: 'template_version_not_found' });

    const gate = await resolveSensitiveChangeGate(req, {
      orgId,
      licenseId,
      requestType: 'TEMPLATE_ROLLBACK',
      targetType: 'TEMPLATE',
      targetId: target.templateKey,
      payload: { templateId, toVersion },
    });
    if (!gate.ok) {
      return res.status(gate.statusCode || 409).json(renderApprovalGate(gate));
    }

    const now = Date.now();
    for (const row of rows) {
      const shouldPublish = Number(row.version || 0) === toVersion;
      // eslint-disable-next-line no-await-in-loop
      await saveTemplateRecord(orgId, {
        ...row,
        status: shouldPublish ? 'PUBLISHED' : normalizeTemplateState(row.status) === 'PUBLISHED' ? 'DEPRECATED' : row.status,
        publishedAt: shouldPublish ? now : row.publishedAt || 0,
        deprecatedAt:
          shouldPublish || normalizeTemplateState(row.status) !== 'PUBLISHED'
            ? row.deprecatedAt || 0
            : now,
        updatedBy: req.user.uid,
      });
    }
    if (gate.approval?.approvalId) {
      await markApprovalConsumed(orgId, gate.approval.approvalId).catch(() => null);
    }

    await writeAuditEvent({
      action: 'ADMIN_TEMPLATE_ROLLBACK',
      actor: req.user,
      target: {
        resourceType: 'TEMPLATE',
        resourceId: target.templateKey,
        orgId,
        licenseId,
      },
      details: {
        templateId,
        toVersion,
        approvalId: gate.approval?.approvalId || '',
      },
    });
    const refreshed = await getTemplateByKey(orgId, target.templateKey);
    return res.json({ ok: true, template: refreshed, approvalId: gate.approval?.approvalId || null });
  } catch (err) {
    console.error('[/admin/templates/:templateId/rollback] error:', err);
    return res.status(500).json({ error: 'admin_template_rollback_failed' });
  }
});

app.get('/admin/approvals', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const approvals = await listApprovalsForOrg(orgId, 300);
    approvals.sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
    return res.json({ approvals });
  } catch (err) {
    console.error('[/admin/approvals GET] error:', err);
    return res.status(500).json({ error: 'admin_approvals_fetch_failed' });
  }
});

app.get('/admin/billing/summary', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : [],
    });
    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds: workshop?.siteIds || [],
      tier: workshop?.tier || 'STARTER',
    });
    const license = await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: Number(workshop?.expectedUsers || 30),
      activeUserCap: Number(workshop?.activeUserCap || workshop?.expectedUsers || 30),
      tier: org?.tier || 'STARTER',
    });
    const usage = await getLicenseUsageSnapshot({
      licenseId,
      orgId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
    }).catch(() => ({
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    }));
    const summary = await buildBillingTransparencySummary({
      orgId,
      licenseId,
      workshop,
      license,
      usage,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
      actor: req.user,
      periodKey: String(req.query?.periodKey || '').trim(),
      automate: false,
    });

    await writeAuditEvent({
      action: 'ADMIN_BILLING_SUMMARY_READ',
      actor: req.user,
      target: {
        resourceType: 'BILLING',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: {
        periodKey: summary.periodKey,
        overageUnits: Number(summary?.overage?.units || 0),
      },
    });
    return res.json({
      ok: true,
      orgId,
      licenseId,
      summary,
    });
  } catch (err) {
    console.error('[/admin/billing/summary GET] error:', err);
    return res.status(500).json({ error: 'admin_billing_summary_failed' });
  }
});

app.post('/admin/billing/run-cycle', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : [],
    });
    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds: workshop?.siteIds || [],
      tier: workshop?.tier || 'STARTER',
    });
    const license = await ensureLicenseRecord({
      licenseId,
      orgId,
      seatCap: Number(workshop?.expectedUsers || 30),
      activeUserCap: Number(workshop?.activeUserCap || workshop?.expectedUsers || 30),
      tier: org?.tier || 'STARTER',
    });
    const usage = await getLicenseUsageSnapshot({
      licenseId,
      orgId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
    }).catch(() => ({
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    }));
    const summary = await buildBillingTransparencySummary({
      orgId,
      licenseId,
      workshop,
      license,
      usage,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
      actor: req.user,
      periodKey: String(req.body?.periodKey || req.query?.periodKey || '').trim(),
      automate: true,
    });
    await writeAuditEvent({
      action: 'ADMIN_BILLING_CYCLE_RUN',
      actor: req.user,
      target: {
        resourceType: 'BILLING',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: {
        periodKey: summary.periodKey,
        overageUnits: Number(summary?.overage?.units || 0),
        projectedAmountCents: Number(summary?.overage?.projectedAmountCents || 0),
      },
    });
    return res.json({ ok: true, orgId, licenseId, summary });
  } catch (err) {
    console.error('[/admin/billing/run-cycle POST] error:', err);
    return res.status(500).json({ error: 'admin_billing_cycle_failed' });
  }
});

app.get('/admin/outcomes', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: req.user.siteId ? [req.user.siteId] : [],
    });
    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds: workshop?.siteIds || [],
      tier: workshop?.tier || 'STARTER',
    });
    const usage = await getLicenseUsageSnapshot({
      licenseId,
      orgId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
    }).catch(() => ({
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    }));
    const outcomes = await buildOutcomesAnalytics({
      orgId,
      licenseId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, org?.siteIds || []),
      usage,
      windowDays: toPositiveInt(req.query?.windowDays, OUTCOMES_WINDOW_DAYS, {
        min: 7,
        max: 180,
      }),
    });
    await writeAuditEvent({
      action: 'ADMIN_OUTCOMES_READ',
      actor: req.user,
      target: {
        resourceType: 'OUTCOMES',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: {
        completionRate: Number(outcomes?.org?.completionRate || 0),
        qualityScore: Number(outcomes?.org?.participationQualityScore || 0),
      },
    });
    return res.json({ ok: true, orgId, licenseId, outcomes });
  } catch (err) {
    console.error('[/admin/outcomes GET] error:', err);
    return res.status(500).json({ error: 'admin_outcomes_failed' });
  }
});

app.get('/admin/billing/events', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const events = await listBillingEventsByOrg(orgId, toPositiveInt(req.query?.limit, 240, { min: 1, max: 500 }));
    return res.json({ events: events.map(mapBillingEventRow) });
  } catch (err) {
    console.error('[/admin/billing/events GET] error:', err);
    return res.status(500).json({ error: 'admin_billing_fetch_failed' });
  }
});

app.post('/admin/billing/invoices', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const amountCents = Math.max(0, Number(req.body?.amountCents || 0));
    const eventType = String(req.body?.eventType || 'INVOICE').trim().toUpperCase();
    if (eventType === 'INVOICE' && amountCents <= 0) {
      return res.status(400).json({ error: 'amountCents_required' });
    }
    const invoiceId = String(req.body?.invoiceId || '').trim() || makePrefixedId('INV');
    const currency = String(req.body?.currency || 'USD').trim().toUpperCase() || 'USD';
    const description = String(req.body?.description || '').trim() || `Invoice ${invoiceId}`;
    const dueAt = Number(req.body?.dueAt || 0) || 0;

    const providerResult = await sendInvoiceToProvider({
      invoiceId,
      orgId,
      licenseId,
      amountCents,
      currency,
      description,
      dueAt,
    });
    const status = providerResult.ok ? 'SENT' : 'FAILED';
    const event = await recordBillingEvent({
      orgId,
      licenseId,
      eventType,
      amountCents,
      currency,
      status,
      payload: {
        invoiceId,
        description,
        dueAt,
        providerResult,
      },
      actor: req.user,
    });

    await writeAuditEvent({
      action: 'ADMIN_BILLING_EVENT_CREATE',
      actor: req.user,
      target: {
        resourceType: 'BILLING_EVENT',
        resourceId: event.billingEventId,
        orgId,
        licenseId,
      },
      details: {
        eventType,
        status,
        amountCents,
        provider: providerResult.provider || '',
      },
    });

    return res.json({ ok: true, event: mapBillingEventRow(event), providerResult });
  } catch (err) {
    console.error('[/admin/billing/invoices POST] error:', err);
    return res.status(500).json({ error: 'admin_billing_create_failed' });
  }
});

app.get('/admin/support/tickets', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const tickets = await listSupportTicketsByOrg(orgId, toPositiveInt(req.query?.limit, 250, { min: 1, max: 500 }));
    return res.json({ tickets: tickets.map(mapSupportTicketRow), escalationEmail: SUPPORT_ESCALATION_EMAIL });
  } catch (err) {
    console.error('[/admin/support/tickets GET] error:', err);
    return res.status(500).json({ error: 'admin_support_list_failed' });
  }
});

app.post('/admin/support/tickets', requireAuth, requireAdmin, requireAdminLicense, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.user.licenseId);
    const orgId = normalizedOrgId(req.user.orgId || '', licenseId);
    const subject = String(req.body?.subject || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!subject || !description) {
      return res.status(400).json({ error: 'subject_and_description_required' });
    }
    const priority = normalizeTicketPriority(req.body?.priority || 'P3');
    const ticket = await createSupportTicket({
      orgId,
      licenseId,
      subject,
      description,
      priority,
      requesterEmail: req.body?.requesterEmail || req.user.email || '',
      actor: req.user,
    });
    const shouldEscalate = priority === 'P1' || req.body?.escalate === true;
    const updatedTicket = shouldEscalate
      ? await updateSupportTicket({
          orgId,
          ticketId: ticket.ticketId,
          ticketStatus: 'ESCALATED',
          owner: String(req.body?.owner || '').trim(),
          note: String(req.body?.note || 'Auto escalated by priority.').trim(),
          actor: req.user,
        })
      : ticket;

    await writeAuditEvent({
      action: shouldEscalate ? 'ADMIN_SUPPORT_TICKET_ESCALATE' : 'ADMIN_SUPPORT_TICKET_CREATE',
      actor: req.user,
      target: {
        resourceType: 'SUPPORT_TICKET',
        resourceId: ticket.ticketId,
        orgId,
        licenseId,
      },
      details: {
        priority,
        escalated: shouldEscalate,
      },
    });

    return res.json({
      ok: true,
      ticket: mapSupportTicketRow(updatedTicket || ticket),
      escalationEmail: SUPPORT_ESCALATION_EMAIL,
    });
  } catch (err) {
    console.error('[/admin/support/tickets POST] error:', err);
    return res.status(500).json({ error: 'admin_support_create_failed' });
  }
});

app.get('/status', async (_req, res) => {
  try {
    const events = await listStatusEvents('GLOBAL', 160).catch(() => []);
    const statusSnapshot = buildStatusSnapshot(events);
    const trustCenter = buildTrustCenterSnapshot(statusSnapshot);

    return res.json({
      status: statusSnapshot.status,
      unresolvedIncidents: statusSnapshot.unresolvedIncidents,
      incidents: statusSnapshot.incidents,
      recentEvents: statusSnapshot.recentEvents.slice(0, 80),
      demoModeFallback: DEMO_MODE_FALLBACK,
      supportEscalationEmail: SUPPORT_ESCALATION_EMAIL,
      statusPageUrl: STATUS_PAGE_URL,
      trustCenterUrl: '/trust-center',
      availability30dPercent: Number(trustCenter?.uptime30d?.availabilityPercent || 0),
      sla: {
        uptimeTarget: '99.9%',
        supportResponseTargets: {
          P1: '< 1 hour',
          P2: '< 4 hours',
          P3: '< 1 business day',
          P4: '< 2 business days',
        },
      },
      generatedAt: nowIso(),
    });
  } catch (err) {
    console.error('[/status] error:', err);
    return res.status(500).json({ error: 'status_page_failed' });
  }
});

app.get('/trust-center', async (_req, res) => {
  try {
    const events = await listStatusEvents('GLOBAL', 240).catch(() => []);
    const statusSnapshot = buildStatusSnapshot(events);
    const trustCenter = buildTrustCenterSnapshot(statusSnapshot);
    return res.json({
      ...trustCenter,
      demoModeFallback: DEMO_MODE_FALLBACK,
      sla: {
        uptimeTarget: '99.9%',
        supportResponseTargets: {
          P1: '< 1 hour',
          P2: '< 4 hours',
          P3: '< 1 business day',
          P4: '< 2 business days',
        },
      },
    });
  } catch (err) {
    console.error('[/trust-center] error:', err);
    return res.status(500).json({ error: 'trust_center_failed' });
  }
});

if (STATUS_PAGE_URL && STATUS_PAGE_URL !== '/status' && STATUS_PAGE_URL.startsWith('/')) {
  app.get(STATUS_PAGE_URL, (_req, res) => {
    return res.redirect(307, '/status');
  });
}

app.get('/super-admin/ops', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [
      orgActive,
      orgSuspended,
      orgInactive,
      licActive,
      licSuspended,
      licExpired,
      pendingApprovals,
      openTickets,
      incidents,
      inProgressTickets,
      healthAlerts,
      reliabilityEvents,
    ] =
      await Promise.all([
        listOrgsByStatus('ACTIVE', 250).catch(() => ({ items: [] })),
        listOrgsByStatus('SUSPENDED', 250).catch(() => ({ items: [] })),
        listOrgsByStatus('INACTIVE', 250).catch(() => ({ items: [] })),
        listLicensesByStatus('ACTIVE', 250).catch(() => ({ items: [] })),
        listLicensesByStatus('SUSPENDED', 250).catch(() => ({ items: [] })),
        listLicensesByStatus('EXPIRED', 250).catch(() => ({ items: [] })),
        listApprovalsByStatus('PENDING', 250).catch(() => ({ items: [] })),
        listSupportTicketsByStatus('OPEN', 250).catch(() => ({ items: [] })),
        listStatusEvents('GLOBAL', 120).catch(() => []),
        listSupportTicketsByStatus('IN_PROGRESS', 250).catch(() => ({ items: [] })),
        buildOperationalHealthAlerts({ maxAlerts: 20 }).catch(() => []),
        listReliabilityEvents(120).catch(() => []),
      ]);

    const incidentRows = incidents.map(mapStatusEventRow);
    const unresolvedIncidents = incidentRows.filter((event) => {
      const incidentState = normalizeIncidentState(
        event.payload?.incidentState || event.payload?.state || event.payload?.status
      );
      return incidentState === 'OPEN' || incidentState === 'MONITORING';
    });
    const reliability = buildReliabilityProgramSnapshot(reliabilityEvents);
    const openTicketRows = (openTickets.items || []).map(mapSupportTicketRow);
    const inProgressTicketRows = (inProgressTickets.items || []).map(mapSupportTicketRow);
    const supportRows = [...openTicketRows, ...inProgressTicketRows];
    const overdueSupportCount = supportRows.filter(
      (ticket) => ticket.slaBreached && ticket.ticketStatus !== 'RESOLVED'
    ).length;

    await writeAuditEvent({
      action: 'SUPER_ADMIN_OPS_READ',
      actor: req.user,
      target: { resourceType: 'SUPER_ADMIN_DASHBOARD', resourceId: 'ops' },
      details: {
        orgsActive: (orgActive.items || []).length,
        licensesActive: (licActive.items || []).length,
      },
    });

    return res.json({
      health: {
        apiOk: true,
        region: AWS_REGION,
        openaiEnabled: (() => {
          try {
            getOpenAI();
            return true;
          } catch {
            return false;
          }
        })(),
        statusPageUrl: STATUS_PAGE_URL,
        supportEscalationEmail: SUPPORT_ESCALATION_EMAIL,
        requestsTotal: runtimeMetrics.requestsTotal,
        errors5xx: runtimeMetrics.errors5xx,
        emittedAt: nowIso(),
      },
      counts: {
        orgsActive: (orgActive.items || []).length,
        orgsSuspended: (orgSuspended.items || []).length,
        orgsInactive: (orgInactive.items || []).length,
        licensesActive: (licActive.items || []).length,
        licensesSuspended: (licSuspended.items || []).length,
        licensesExpired: (licExpired.items || []).length,
        approvalsPending: (pendingApprovals.items || []).length,
        ticketsOpen: (openTickets.items || []).length,
        ticketsInProgress: (inProgressTickets.items || []).length,
        incidentsOpen: unresolvedIncidents.length,
        healthAlerts: healthAlerts.length,
        overdueSupport: overdueSupportCount,
      },
      pendingApprovals: (pendingApprovals.items || []).slice(0, 50),
      openTickets: openTicketRows.slice(0, 50),
      inProgressTickets: inProgressTicketRows.slice(0, 50),
      incidents: unresolvedIncidents.slice(0, 50),
      healthAlerts,
      reliability,
    });
  } catch (err) {
    console.error('[/super-admin/ops] error:', err);
    return res.status(500).json({ error: 'super_admin_ops_failed' });
  }
});

app.get('/super-admin/health/alerts', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 40, { min: 1, max: 200 });
    const alerts = await buildOperationalHealthAlerts({ maxAlerts: limit });
    await writeAuditEvent({
      action: 'SUPER_ADMIN_HEALTH_ALERTS_READ',
      actor: req.user,
      target: {
        resourceType: 'HEALTH_ALERTS',
        resourceId: 'GLOBAL',
      },
      details: {
        count: alerts.length,
      },
    });
    return res.json({
      alerts,
      generatedAt: nowIso(),
      count: alerts.length,
    });
  } catch (err) {
    console.error('[/super-admin/health/alerts GET] error:', err);
    return res.status(500).json({ error: 'super_admin_health_alerts_failed' });
  }
});

app.get('/super-admin/orgs', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const status = normalizeOrgStatus(req.query?.status || 'ACTIVE');
    const limit = toPositiveInt(req.query?.limit, 120, { min: 1, max: 500 });
    const orgIdFilter = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (orgIdFilter) {
      const org = await getOrgRecord(orgIdFilter);
      return res.json({ orgs: org ? [org] : [], nextCursor: null });
    }
    const cursor = decodeCursor(req.query?.cursor);
    const page = await listOrgsByStatus(
      status,
      limit,
      cursor && cursor.kind === 'org_status' && cursor.status === status ? cursor.lastKey : undefined
    );
    const nextCursor = page.lastKey
      ? encodeCursor({ kind: 'org_status', status, lastKey: page.lastKey })
      : null;
    return res.json({ orgs: page.items || [], nextCursor });
  } catch (err) {
    console.error('[/super-admin/orgs GET] error:', err);
    return res.status(500).json({ error: 'super_admin_orgs_fetch_failed' });
  }
});

app.put('/super-admin/orgs/:orgId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.params.orgId || '', req.body?.licenseId || '');
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const org = await saveOrgRecord(orgId, req.body || {}, req.user);
    await writeAuditEvent({
      action: 'SUPER_ADMIN_ORG_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'ORG',
        resourceId: orgId,
        orgId,
      },
      details: {
        status: org.status,
        tier: org.tier,
        supportPlan: org.supportPlan,
      },
    });
    return res.json({ ok: true, org });
  } catch (err) {
    console.error('[/super-admin/orgs/:orgId PUT] error:', err);
    return res.status(500).json({ error: 'super_admin_org_update_failed' });
  }
});

app.get('/super-admin/licenses', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 160, { min: 1, max: 500 });
    const licenseIdFilter = normalizedLicenseId(req.query?.licenseId || '');
    if (licenseIdFilter) {
      const license = await getLicenseRecord(licenseIdFilter);
      return res.json({ licenses: license ? [license] : [], nextCursor: null });
    }
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    const status = normalizeLicenseState(req.query?.status || 'ACTIVE');
    const cursor = decodeCursor(req.query?.cursor);

    let page = { items: [], lastKey: null };
    let nextCursor = null;
    if (orgId) {
      page = await listLicensesByOrg(
        orgId,
        limit,
        cursor && cursor.kind === 'license_org' && cursor.orgId === orgId ? cursor.lastKey : undefined
      );
      nextCursor = page.lastKey
        ? encodeCursor({ kind: 'license_org', orgId, lastKey: page.lastKey })
        : null;
    } else {
      page = await listLicensesByStatus(
        status,
        limit,
        cursor && cursor.kind === 'license_status' && cursor.status === status
          ? cursor.lastKey
          : undefined
      );
      nextCursor = page.lastKey
        ? encodeCursor({ kind: 'license_status', status, lastKey: page.lastKey })
        : null;
    }
    return res.json({ licenses: page.items || [], nextCursor });
  } catch (err) {
    console.error('[/super-admin/licenses GET] error:', err);
    return res.status(500).json({ error: 'super_admin_licenses_fetch_failed' });
  }
});

app.post('/super-admin/licenses/provision', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.body?.orgId || '', req.body?.licenseId || '');
    const licenseId = normalizedLicenseId(req.body?.licenseId || '');
    if (!orgId || !licenseId) {
      return res.status(400).json({ error: 'orgId_and_licenseId_required' });
    }
    const siteIds = parseSiteIdsInput(req.body?.siteIds, req.body?.siteId ? [req.body.siteId] : []);
    if (!siteIds.length) {
      return res.status(400).json({ error: 'siteIds_required' });
    }

    const org = await ensureOrgRecord({
      orgId,
      licenseId,
      siteIds,
      tier: req.body?.tier || 'STARTER',
    });
    const license = await saveLicenseRecord(
      licenseId,
      {
        orgId,
        status: req.body?.status || 'ACTIVE',
        tier: req.body?.tier || org.tier || 'STARTER',
        seatCap: req.body?.seatCap || req.body?.expectedUsers || 30,
        activeUserCap: req.body?.activeUserCap || req.body?.expectedUsers || 30,
        usageCap: req.body?.usageCap,
        startsAt: req.body?.startsAt || Date.now(),
        expiresAt: req.body?.expiresAt || 0,
        renewalAt: req.body?.renewalAt || 0,
        overagePolicy: req.body?.overagePolicy,
        billingMode: req.body?.billingMode,
        billingAccountId: req.body?.billingAccountId,
        notes: req.body?.notes,
      },
      req.user
    );
    const workshop = await saveWorkshopConfig(licenseId, {
      orgId,
      mode: req.body?.mode || DEFAULT_WORKSHOP_MODE,
      siteIds,
      expectedUsers: license.seatCap,
      activeUserCap: license.activeUserCap,
      licenseStatus: license.status,
      licenseExpiresAt: Number(license.expiresAt || 0) || null,
      seatLimitPerRoom: req.body?.seatLimitPerRoom,
      aiBehavior: req.body?.aiBehavior,
      phaseCount: req.body?.phaseCount,
      phases: Array.isArray(req.body?.phases) ? req.body.phases : undefined,
      topicCatalog: Array.isArray(req.body?.topicCatalog) ? req.body.topicCatalog : undefined,
      assistantPersona: req.body?.assistantPersona,
      name: req.body?.name,
      description: req.body?.description,
    });
    clearWorkshopTenantCache(licenseId);

    const adminCodeCount = toPositiveInt(req.body?.adminCodeCount, 0, { min: 0, max: 50 });
    const generatedCodes = [];
    for (let i = 0; i < adminCodeCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      const code = await createCodeRecord({
        role: 'ADMIN',
        siteId: siteIds[0],
        siteIds,
        licenseId,
        orgId,
        defaultMode: workshop.mode,
        createdBy: req.user.email || req.user.uid,
      });
      generatedCodes.push(code);
    }

    await writeAuditEvent({
      action: 'SUPER_ADMIN_LICENSE_PROVISION',
      actor: req.user,
      target: {
        resourceType: 'LICENSE',
        resourceId: licenseId,
        orgId,
        licenseId,
        siteId: siteIds[0] || '',
      },
      details: {
        status: license.status,
        tier: license.tier,
        siteCount: siteIds.length,
        adminCodeCount: generatedCodes.length,
      },
    });

    return res.json({
      ok: true,
      org,
      license,
      workshop,
      generatedCodes,
    });
  } catch (err) {
    console.error('[/super-admin/licenses/provision] error:', err);
    return res.status(500).json({ error: 'super_admin_license_provision_failed' });
  }
});

app.put('/super-admin/licenses/:licenseId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.params.licenseId || '');
    if (!licenseId) return res.status(400).json({ error: 'licenseId_required' });
    const current = await getLicenseRecord(licenseId);
    if (!current) return res.status(404).json({ error: 'license_not_found' });
    const orgId = normalizedOrgId(req.body?.orgId || current.orgId || '', licenseId);

    const license = await saveLicenseRecord(
      licenseId,
      {
        ...req.body,
        orgId,
      },
      req.user
    );
    const workshop = await saveWorkshopConfig(licenseId, {
      orgId,
      expectedUsers: license.seatCap,
      activeUserCap: license.activeUserCap,
      licenseStatus: license.status,
      licenseExpiresAt: Number(license.expiresAt || 0) || null,
      siteIds: parseSiteIdsInput(req.body?.siteIds, []),
      mode: req.body?.mode,
      name: req.body?.name,
      description: req.body?.description,
      aiBehavior: req.body?.aiBehavior,
      phaseCount: req.body?.phaseCount,
      phases: Array.isArray(req.body?.phases) ? req.body.phases : undefined,
      topicCatalog: Array.isArray(req.body?.topicCatalog) ? req.body.topicCatalog : undefined,
      assistantPersona: req.body?.assistantPersona,
    });
    clearWorkshopTenantCache(licenseId);

    await writeAuditEvent({
      action: 'SUPER_ADMIN_LICENSE_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'LICENSE',
        resourceId: licenseId,
        orgId,
        licenseId,
      },
      details: {
        status: license.status,
        tier: license.tier,
        seatCap: license.seatCap,
        activeUserCap: license.activeUserCap,
      },
    });
    return res.json({ ok: true, license, workshop });
  } catch (err) {
    console.error('[/super-admin/licenses/:licenseId PUT] error:', err);
    return res.status(500).json({ error: 'super_admin_license_update_failed' });
  }
});

app.get('/super-admin/approvals', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 200, { min: 1, max: 500 });
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (orgId) {
      const approvals = await listApprovalsForOrg(orgId, limit);
      approvals.sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
      return res.json({ approvals, nextCursor: null });
    }

    const status = normalizeApprovalState(req.query?.status || 'PENDING');
    const cursor = decodeCursor(req.query?.cursor);
    const page = await listApprovalsByStatus(
      status,
      limit,
      cursor && cursor.kind === 'approvals_status' && cursor.status === status
        ? cursor.lastKey
        : undefined
    );
    const nextCursor = page.lastKey
      ? encodeCursor({ kind: 'approvals_status', status, lastKey: page.lastKey })
      : null;
    return res.json({ approvals: page.items || [], nextCursor });
  } catch (err) {
    console.error('[/super-admin/approvals GET] error:', err);
    return res.status(500).json({ error: 'super_admin_approvals_fetch_failed' });
  }
});

app.post('/super-admin/approvals/:orgId/:approvalId/decide', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.params.orgId || '', req.body?.licenseId || '');
    const approvalId = String(req.params.approvalId || '').trim();
    const decision = normalizeApprovalState(req.body?.decision || '');
    if (!orgId || !approvalId) return res.status(400).json({ error: 'orgId_and_approvalId_required' });
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      return res.status(400).json({ error: 'decision_must_be_approved_or_rejected' });
    }

    const approval = await decideApproval({
      orgId,
      approvalId,
      decision,
      note: req.body?.note || '',
      actor: req.user,
    });
    await writeAuditEvent({
      action: decision === 'APPROVED' ? 'SUPER_ADMIN_APPROVAL_APPROVE' : 'SUPER_ADMIN_APPROVAL_REJECT',
      actor: req.user,
      target: {
        resourceType: 'APPROVAL',
        resourceId: approvalId,
        orgId,
        licenseId: approval?.licenseId || '',
      },
      details: {
        decision,
        note: String(req.body?.note || '').trim().slice(0, 1000),
      },
    });
    return res.json({ ok: true, approval });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: 'approval_already_decided' });
    }
    console.error('[/super-admin/approvals/:orgId/:approvalId/decide] error:', err);
    return res.status(500).json({ error: 'super_admin_approval_decide_failed' });
  }
});

app.get('/super-admin/billing', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const licenseId = normalizedLicenseId(req.query?.licenseId || '');
    const includeSummary = String(req.query?.includeSummary || '').trim().toLowerCase() === 'true';
    const events = await listBillingEventsByOrg(orgId, toPositiveInt(req.query?.limit, 300, { min: 1, max: 500 }));
    const filtered = licenseId
      ? events.filter((event) => normalizedLicenseId(event.licenseId || '') === licenseId)
      : events;
    let summary = null;
    if (includeSummary && licenseId) {
      const workshop = await getWorkshopByLicenseCached(licenseId).catch(() => null);
      const license = await getLicenseRecord(licenseId).catch(() => null);
      const usage = await getLicenseUsageSnapshot({
        licenseId,
        orgId,
        siteIds: sanitizeSiteIds(workshop?.siteIds, []),
      }).catch(() => ({
        activeUsers: 0,
        assignedSeats: 0,
        activeRooms: 0,
        aiUsageCostCents30d: 0,
      }));
      summary = await buildBillingTransparencySummary({
        orgId,
        licenseId,
        workshop,
        license,
        usage,
        siteIds: sanitizeSiteIds(workshop?.siteIds, []),
        billingRows: filtered,
        actor: req.user,
        automate: false,
      }).catch(() => null);
    }
    return res.json({ events: filtered.map(mapBillingEventRow), summary });
  } catch (err) {
    console.error('[/super-admin/billing GET] error:', err);
    return res.status(500).json({ error: 'super_admin_billing_fetch_failed' });
  }
});

app.get('/super-admin/outcomes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const licenseId = normalizedLicenseId(req.query?.licenseId || '');
    const orgId = normalizedOrgId(req.query?.orgId || '', licenseId);
    if (!licenseId && !orgId) {
      return res.status(400).json({ error: 'orgId_or_licenseId_required' });
    }
    let resolvedLicenseId = licenseId;
    let resolvedOrgId = orgId;
    let workshop = null;
    if (resolvedLicenseId) {
      workshop = await getWorkshopByLicenseCached(resolvedLicenseId).catch(() => null);
      if (!resolvedOrgId) {
        resolvedOrgId = normalizedOrgId(workshop?.orgId || '', resolvedLicenseId);
      }
    }
    if (!resolvedLicenseId && resolvedOrgId) {
      const licPage = await listLicensesByOrg(resolvedOrgId, 1).catch(() => ({ items: [] }));
      const firstLicense = Array.isArray(licPage.items) ? licPage.items[0] : null;
      resolvedLicenseId = normalizedLicenseId(firstLicense?.licenseId || '');
      if (resolvedLicenseId) {
        workshop = await getWorkshopByLicenseCached(resolvedLicenseId).catch(() => null);
      }
    }
    if (!resolvedLicenseId || !resolvedOrgId) {
      return res.status(404).json({ error: 'tenant_not_found' });
    }
    const usage = await getLicenseUsageSnapshot({
      licenseId: resolvedLicenseId,
      orgId: resolvedOrgId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, []),
    }).catch(() => ({
      activeUsers: 0,
      assignedSeats: 0,
      activeRooms: 0,
      aiUsageCostCents30d: 0,
    }));
    const outcomes = await buildOutcomesAnalytics({
      orgId: resolvedOrgId,
      licenseId: resolvedLicenseId,
      siteIds: sanitizeSiteIds(workshop?.siteIds, []),
      usage,
      windowDays: toPositiveInt(req.query?.windowDays, OUTCOMES_WINDOW_DAYS, {
        min: 7,
        max: 180,
      }),
    });
    return res.json({
      orgId: resolvedOrgId,
      licenseId: resolvedLicenseId,
      outcomes,
    });
  } catch (err) {
    console.error('[/super-admin/outcomes GET] error:', err);
    return res.status(500).json({ error: 'super_admin_outcomes_failed' });
  }
});

app.get('/super-admin/reliability', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 160, { min: 1, max: 500 });
    const events = await listReliabilityEvents(limit);
    const reliability = buildReliabilityProgramSnapshot(events);
    const alerts = await buildOperationalHealthAlerts({ maxAlerts: 60 });
    const reliabilityAlerts = alerts.filter((alert) => alert.category === 'reliability');
    await writeAuditEvent({
      action: 'SUPER_ADMIN_RELIABILITY_READ',
      actor: req.user,
      target: {
        resourceType: 'RELIABILITY_PROGRAM',
        resourceId: RELIABILITY_SCOPE_ID,
      },
      details: {
        events: events.length,
        alerts: reliabilityAlerts.length,
      },
    });
    return res.json({
      reliability,
      alerts: reliabilityAlerts,
      automation: {
        enabled: RELIABILITY_AUTO_BACKUP_ENABLED,
        intervalMs: RELIABILITY_AUTO_BACKUP_INTERVAL_MS,
        mode: RELIABILITY_BACKUP_EXECUTION_MODE,
      },
      generatedAt: nowIso(),
    });
  } catch (err) {
    console.error('[/super-admin/reliability GET] error:', err);
    return res.status(500).json({ error: 'super_admin_reliability_fetch_failed' });
  }
});

app.post('/super-admin/reliability/backup', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const force = String(req.body?.force || '').trim().toLowerCase() === 'true' || req.body?.force === true;
    const source = String(req.body?.source || '').trim() || 'super-admin';
    let event = null;
    if (force) {
      event = await recordReliabilityEvent({
        eventType: 'BACKUP_RUN',
        status: req.body?.status || 'SUCCESS',
        summary: String(req.body?.summary || '').trim() || 'Manual backup run logged by super admin.',
        notes: req.body?.notes || '',
        automated: false,
        source: source || 'manual',
        runbook: 'scripts/backupDynamo.mjs',
        metadata: parseJsonObject(req.body?.metadata, {}),
        actor: req.user,
        audit: true,
      });
    } else {
      const result = await runAutomatedReliabilityBackup({
        actor: req.user,
        force: false,
        source,
      });
      if (!result.ok) {
        return res.status(500).json({ error: 'reliability_backup_failed' });
      }
      if (!result.event) {
        return res.status(202).json({
          ok: true,
          skipped: true,
          reason: result.reason || 'in_flight',
          automation: {
            enabled: RELIABILITY_AUTO_BACKUP_ENABLED,
            intervalMs: RELIABILITY_AUTO_BACKUP_INTERVAL_MS,
            mode: RELIABILITY_BACKUP_EXECUTION_MODE,
          },
        });
      }
      event = result.event;
    }
    return res.json({
      ok: true,
      event,
      automation: {
        enabled: RELIABILITY_AUTO_BACKUP_ENABLED,
        intervalMs: RELIABILITY_AUTO_BACKUP_INTERVAL_MS,
        mode: RELIABILITY_BACKUP_EXECUTION_MODE,
      },
    });
  } catch (err) {
    console.error('[/super-admin/reliability/backup POST] error:', err);
    return res.status(500).json({ error: 'super_admin_reliability_backup_failed' });
  }
});

app.post('/super-admin/reliability/restore-drill', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const observedRtoMinutes = Math.max(0, Number(req.body?.observedRtoMinutes || 0));
    const observedRpoMinutes = Math.max(0, Number(req.body?.observedRpoMinutes || 0));
    if (!Number.isFinite(observedRtoMinutes) || !Number.isFinite(observedRpoMinutes)) {
      return res.status(400).json({ error: 'observed_rto_rpo_required' });
    }
    const event = await recordReliabilityEvent({
      eventType: 'RESTORE_DRILL',
      status: req.body?.status || 'SUCCESS',
      summary:
        String(req.body?.summary || '').trim() ||
        'Restore drill completed and captured observed RTO/RPO metrics.',
      notes: req.body?.notes || '',
      observedRtoMinutes,
      observedRpoMinutes,
      automated: false,
      source: String(req.body?.source || '').trim() || 'super-admin',
      runbook: 'scripts/restoreDynamo.mjs',
      metadata: parseJsonObject(req.body?.metadata, {}),
      actor: req.user,
      audit: true,
    });
    const events = await listReliabilityEvents(120).catch(() => []);
    const reliability = buildReliabilityProgramSnapshot(events);
    return res.json({
      ok: true,
      event,
      reliability,
    });
  } catch (err) {
    console.error('[/super-admin/reliability/restore-drill POST] error:', err);
    return res.status(500).json({ error: 'super_admin_restore_drill_failed' });
  }
});

app.get('/super-admin/support', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 200, { min: 1, max: 500 });
    const orgId = normalizedOrgId(req.query?.orgId || '', req.query?.licenseId || '');
    if (orgId) {
      const tickets = await listSupportTicketsByOrg(orgId, limit);
      return res.json({ tickets: tickets.map(mapSupportTicketRow), nextCursor: null });
    }
    const status = normalizeTicketStatus(req.query?.status || 'OPEN');
    const cursor = decodeCursor(req.query?.cursor);
    const page = await listSupportTicketsByStatus(
      status,
      limit,
      cursor && cursor.kind === 'support_status' && cursor.status === status
        ? cursor.lastKey
        : undefined
    );
    const nextCursor = page.lastKey
      ? encodeCursor({ kind: 'support_status', status, lastKey: page.lastKey })
      : null;
    return res.json({ tickets: (page.items || []).map(mapSupportTicketRow), nextCursor });
  } catch (err) {
    console.error('[/super-admin/support GET] error:', err);
    return res.status(500).json({ error: 'super_admin_support_fetch_failed' });
  }
});

app.post('/super-admin/support/:orgId/:ticketId/update', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = normalizedOrgId(req.params.orgId || '', req.body?.licenseId || '');
    const ticketId = String(req.params.ticketId || '').trim();
    if (!orgId || !ticketId) return res.status(400).json({ error: 'orgId_and_ticketId_required' });
    const ticket = await updateSupportTicket({
      orgId,
      ticketId,
      ticketStatus: req.body?.ticketStatus || 'IN_PROGRESS',
      owner: req.body?.owner || '',
      note: req.body?.note || '',
      actor: req.user,
    });
    await writeAuditEvent({
      action: 'SUPER_ADMIN_SUPPORT_UPDATE',
      actor: req.user,
      target: {
        resourceType: 'SUPPORT_TICKET',
        resourceId: ticketId,
        orgId,
        licenseId: ticket?.licenseId || '',
      },
      details: {
        ticketStatus: ticket?.ticketStatus || '',
        owner: ticket?.owner || '',
      },
    });
    return res.json({ ok: true, ticket: mapSupportTicketRow(ticket || {}) });
  } catch (err) {
    console.error('[/super-admin/support/:orgId/:ticketId/update] error:', err);
    return res.status(500).json({ error: 'super_admin_support_update_failed' });
  }
});

app.post('/super-admin/support/escalate-overdue', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const maxPerStatus = toPositiveInt(req.body?.maxPerStatus, 200, { min: 1, max: 500 });
    const result = await runSupportEscalationCycle({
      actor: req.user,
      maxPerStatus,
      force: true,
    });
    if (!result.ok) {
      return res.status(500).json({ error: result.reason || 'support_escalation_failed' });
    }
    await writeAuditEvent({
      action: 'SUPER_ADMIN_SUPPORT_ESCALATE_OVERDUE',
      actor: req.user,
      target: {
        resourceType: 'SUPPORT_TICKET',
        resourceId: 'OVERDUE_BATCH',
      },
      details: {
        escalatedCount: Array.isArray(result.escalated) ? result.escalated.length : 0,
      },
    });
    return res.json({
      ok: true,
      skipped: !!result.skipped,
      reason: result.reason || '',
      escalatedCount: Array.isArray(result.escalated) ? result.escalated.length : 0,
      escalated: Array.isArray(result.escalated) ? result.escalated : [],
    });
  } catch (err) {
    console.error('[/super-admin/support/escalate-overdue POST] error:', err);
    return res.status(500).json({ error: 'super_admin_support_escalation_failed' });
  }
});

app.get('/super-admin/status/events', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const scopeId = String(req.query?.scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
    const limit = toPositiveInt(req.query?.limit, 200, { min: 1, max: 500 });
    const events = await listStatusEvents(scopeId, limit);
    return res.json({ events: events.map(mapStatusEventRow) });
  } catch (err) {
    console.error('[/super-admin/status/events GET] error:', err);
    return res.status(500).json({ error: 'super_admin_status_events_fetch_failed' });
  }
});

app.post('/super-admin/status/events', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const scopeId = String(req.body?.scopeId || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';
    const now = Date.now();
    const statusKey =
      String(req.body?.statusKey || '').trim() ||
      `${String(now).padStart(13, '0')}#${crypto.randomUUID()}`;
    const payload = {
      component: String(req.body?.component || '').trim() || 'platform',
      message: String(req.body?.message || '').trim(),
      severity: String(req.body?.severity || 'INFO').trim().toUpperCase(),
      state: String(req.body?.state || 'OPEN').trim().toUpperCase(),
      incidentState: normalizeIncidentState(req.body?.incidentState || req.body?.state || 'OPEN'),
      link: String(req.body?.link || '').trim(),
      createdBy: req.user.uid,
      createdAt: Number(req.body?.createdAt || now) || now,
      resolvedAt: Number(req.body?.resolvedAt || 0) || 0,
      metadata: parseJsonObject(req.body?.metadata, {}),
    };
    const event = await saveStatusEvent(scopeId, statusKey, payload);
    await writeAuditEvent({
      action: 'SUPER_ADMIN_STATUS_EVENT_WRITE',
      actor: req.user,
      target: {
        resourceType: 'STATUS_EVENT',
        resourceId: `${scopeId}:${statusKey}`,
      },
      details: payload,
    });
    return res.json({ ok: true, event: mapStatusEventRow(event) });
  } catch (err) {
    console.error('[/super-admin/status/events POST] error:', err);
    return res.status(500).json({ error: 'super_admin_status_event_write_failed' });
  }
});

// ---------- Codes: consume ----------
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }
    const normalizedCode = code.trim().toUpperCase();
    const item = await getCodeRecordByInput(normalizedCode);
    if (!item) {
      return res.status(404).json({ error: 'Code not found or invalid' });
    }
    const unusableReason = classifyCodeUnusable(item);
    if (unusableReason) {
      const status = unusableReason === 'code_revoked' || unusableReason === 'code_expired' ? 410 : 400;
      return res.status(status).json({ error: unusableReason });
    }

    const role = String(item.role || 'PARTICIPANT').toUpperCase();
    if (role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'super_admin_requires_email_login' });
    }

    const consumeRes = await consumeCodeForUser(item, req.user.uid);
    if (consumeRes.conflict) {
      return res
        .status(409)
        .json({ error: consumeRes.reason || 'code_already_consumed' });
    }
    if (!consumeRes.ok && consumeRes.error) {
      return res.status(500).json({ error: 'code_consume_failed' });
    }

    const siteId = normalizedSiteId(item.siteId || normalizeCodeSiteIds(item)[0] || 'E1');
    const licenseId = normalizeLicenseFromCode(item, normalizedCode);
    const orgId = normalizeOrgFromCode(item, licenseId);
    const codeSiteIds = normalizeCodeSiteIds(item);
    const defaultMode = normalizeMode(item.defaultMode || DEFAULT_WORKSHOP_MODE);
    const workshop = await ensureWorkshopConfig({
      licenseId,
      orgId,
      siteIds: codeSiteIds.length ? codeSiteIds : [siteId],
      mode: defaultMode,
    });
    const licenseState = evaluateWorkshopLicenseState(workshop);
    if (!licenseState.ok) {
      return res.status(licenseState.statusCode || 403).json({ error: licenseState.error });
    }
    const activeCapCheck = await enforceLicenseActiveUserCap({
      licenseId,
      activeUserCap:
        Number(workshop?.activeUserCap || workshop?.expectedUsers || 0) || 0,
      uid: req.user.uid,
    });
    if (!activeCapCheck.ok) {
      return res.status(429).json({
        error: activeCapCheck.error,
        activeUsers: activeCapCheck.activeUsers,
        activeUserCap: activeCapCheck.cap,
      });
    }
    const entitlementCheck = await enforceRuntimeLicenseEntitlements({
      role,
      licenseId,
      orgId,
      siteId,
      workshop,
      automate: true,
      bypassAdmin: true,
    });
    if (!entitlementCheck.ok) {
      return res.status(entitlementCheck.statusCode || 403).json({
        error: entitlementCheck.error || 'license_forbidden',
        usageCap: Number(entitlementCheck.usageCap || 0) || undefined,
        meteredUnits: Number(entitlementCheck.meteredUnits || 0) || undefined,
        overageUnits: Number(entitlementCheck.overageUnits || 0) || undefined,
      });
    }

    const pair = await issueTokenPair(
      {
        uid: req.user.uid,
        role,
        siteId,
        licenseId,
        orgId,
      },
      req
    );

    const roomsPerSite = toPositiveInt(workshop?.roomsPerSite, 5, {
      min: 1,
      max: MAX_ROOMS_PER_SITE,
    });
    const sitesToEnsure = sanitizeSiteIds(
      workshop?.siteIds,
      codeSiteIds.length ? codeSiteIds : [siteId]
    );
    if (!sitesToEnsure.length) sitesToEnsure.push(siteId);

    for (const sid of sitesToEnsure) {
      for (let i = 1; i <= roomsPerSite; i++) {
        const rid = `${sid}-${i}`;
        await syncRoomWorkshopConfig(rid, workshop);
        if (stageEngine?.touch) stageEngine.touch(rid);
      }
    }

    await writeAuditEvent({
      action: 'CODE_CONSUME',
      actor: req.user,
      target: {
        resourceType: 'CODE',
        resourceId: normalizedCode,
        orgId,
        licenseId,
        siteId,
      },
      details: {
        upgradedRole: role,
      },
    });
    publishSuperAdminStreamEvent({
      source: 'code_consume',
      role,
      siteId,
      licenseId,
      orgId,
    });

    return res.json({
      siteId,
      role,
      token: pair.accessToken,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: pair.sessionId,
      expiresIn: pair.accessTtlSeconds,
      userId: req.user.uid,
      licenseId,
      orgId,
      workshop,
    });
  } catch (err) {
    console.error('[/codes/consume] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Server-Sent Events ----------
app.get('/rooms/:roomId/events', requireAuth, requireRoomAccess, async (req, res) => {
  const roomId = req.params.roomId;
  const stopHeartbeat = setupSseResponse(res);
  const detach = attachSseClient(roomEventStreams, roomId, res);

  const room = await advanceRoomTimeline(roomId, { room: req.room });
  writeSseEvent(res, 'ready', {
    roomId,
    siteId: room.siteId || parseRoomId(roomId).siteId,
    event: 'ready',
    at: Date.now(),
  });

  const roomTick = setInterval(() => {
    advanceRoomTimeline(roomId).catch((err) => {
      console.error('[rooms events] room tick error:', roomId, err?.message || err);
    });
  }, 1_000);
  if (typeof roomTick.unref === 'function') roomTick.unref();

  req.on('close', () => {
    stopHeartbeat();
    detach();
    clearInterval(roomTick);
  });
});

app.get(
  '/presenter/events',
  requireAuth,
  requirePresenter,
  requirePresenterSiteMatchFromQuery,
  async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) {
    return res.status(400).json({ error: 'siteId required' });
  }

  const stopHeartbeat = setupSseResponse(res);
  const detach = attachSseClient(presenterEventStreams, siteId, res, {
    upperCase: true,
  });

  writeSseEvent(res, 'ready', {
    siteId,
    event: 'ready',
    at: Date.now(),
  });

  const siteTick = setInterval(() => {
    advanceSiteTimeline(siteId, req.user?.licenseId, req.user?.orgId).catch((err) => {
      console.error('[presenter events] site tick error:', siteId, err?.message || err);
    });
  }, 2_000);
  if (typeof siteTick.unref === 'function') siteTick.unref();

  req.on('close', () => {
    stopHeartbeat();
    detach();
    clearInterval(siteTick);
  });
  }
);

app.get('/status/events/stream', async (_req, res) => {
  const stopHeartbeat = setupSseResponse(res);
  const detach = attachSseClient(statusEventStreams, 'GLOBAL', res);

  try {
    const events = await listStatusEvents('GLOBAL', 120);
    const snapshot = buildStatusSnapshot(events);
    writeSseEvent(res, 'ready', {
      event: 'ready',
      at: Date.now(),
      status: snapshot.status || 'OPERATIONAL',
      unresolvedIncidents: Number(snapshot.unresolvedIncidents || 0),
    });
  } catch {
    writeSseEvent(res, 'ready', {
      event: 'ready',
      at: Date.now(),
      status: 'UNKNOWN',
      unresolvedIncidents: 0,
    });
  }

  req.on('close', () => {
    stopHeartbeat();
    detach();
  });
});

app.get('/super-admin/events', requireAuth, requireSuperAdmin, async (req, res) => {
  const stopHeartbeat = setupSseResponse(res);
  const detach = attachSseClient(superAdminEventStreams, 'GLOBAL', res);

  writeSseEvent(res, 'ready', {
    event: 'ready',
    at: Date.now(),
    uid: req.user?.uid || '',
  });

  req.on('close', () => {
    stopHeartbeat();
    detach();
  });
});

// ---------- Static (optional SPA) ----------
function hasIndex(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}

const distDir = WEB_DIST_DIR;
const distHasIndex = hasIndex(distDir);

if (distHasIndex) {
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
  app.use(
    '/app/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
}

app.get('/', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /] index error', err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

app.get('/app', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /app] index error', err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[static fallback /app/*] error', err);
        res.status(404).send(`Error: index.html not found at '${indexPath}'`);
      }
    });
  });

  app.get(
    /^\/(?!api|health|version|rooms|codes|assets|presenter).*/,
    (_req, res, next) => {
      const indexPath = path.join(distDir, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error('[static fallback /*] error', err);
          next();
        }
      });
    }
  );
}

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------- 404 & Error handlers ----------
app.use((req, res) =>
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method })
);

app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(`[env] endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`);
  console.log(
    `[env] CORS_ORIGINS=${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'}`
  );
  console.log(`[env] SPA=${ENABLE_SPA} dist=${WEB_DIST_DIR} present=${distHasIndex}`);

  if (SUPPORT_AUTO_ESCALATE_ENABLED) {
    console.log(
      `[support] overdue escalation automation enabled (interval=${SUPPORT_AUTO_ESCALATE_INTERVAL_MS}ms)`
    );
    runSupportEscalationCycle({
      actor: { uid: 'support-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
      maxPerStatus: 200,
      force: false,
    })
      .then((out) => {
        if (Array.isArray(out?.escalated) && out.escalated.length > 0) {
          console.log(`[support] auto-escalated ${out.escalated.length} overdue ticket(s)`);
        }
      })
      .catch((err) =>
        console.warn('[support] initial escalation cycle failed:', err?.message || err)
      );
    const supportEscalationTimer = setInterval(() => {
      runSupportEscalationCycle({
        actor: { uid: 'support-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
        maxPerStatus: 200,
        force: false,
      })
        .then((out) => {
          if (Array.isArray(out?.escalated) && out.escalated.length > 0) {
            console.log(`[support] auto-escalated ${out.escalated.length} overdue ticket(s)`);
          }
        })
        .catch((err) =>
          console.warn('[support] escalation cycle failed:', err?.message || err)
        );
    }, SUPPORT_AUTO_ESCALATE_INTERVAL_MS);
    if (typeof supportEscalationTimer.unref === 'function') supportEscalationTimer.unref();
  } else {
    console.log('[support] overdue escalation automation disabled');
  }

  if (RELIABILITY_AUTO_BACKUP_ENABLED) {
    console.log(
      `[reliability] auto backup enabled (interval=${RELIABILITY_AUTO_BACKUP_INTERVAL_MS}ms mode=${RELIABILITY_BACKUP_EXECUTION_MODE})`
    );
    runAutomatedReliabilityBackup({
      actor: { uid: 'reliability-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
      force: false,
      source: 'scheduler',
    }).catch((err) =>
      console.warn('[reliability] initial backup checkpoint failed:', err?.message || err)
    );
    const reliabilityBackupTimer = setInterval(() => {
      runAutomatedReliabilityBackup({
        actor: { uid: 'reliability-bot', role: 'SYSTEM', email: SUPPORT_ESCALATION_EMAIL },
        force: false,
        source: 'scheduler',
      }).catch((err) =>
        console.warn('[reliability] backup checkpoint failed:', err?.message || err)
      );
    }, RELIABILITY_AUTO_BACKUP_INTERVAL_MS);
    if (typeof reliabilityBackupTimer.unref === 'function') reliabilityBackupTimer.unref();
  } else {
    console.log('[reliability] auto backup checkpoint disabled');
  }
});
