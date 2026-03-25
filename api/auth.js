import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 12 * 60 * 60);
const TOKEN_ISSUER = 'storibloom-api';
const INSECURE_DEV_SECRET = 'dev-only-change-me';

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const normalized = String(input || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toUpperCase();
  if (normalized === 'SUPER_ADMIN') return 'SUPER_ADMIN';
  if (normalized === 'PRESENTER') return 'PRESENTER';
  if (normalized === 'ADMIN') return 'ADMIN';
  return 'PARTICIPANT';
}

function signSegment(segment, secret) {
  return toBase64Url(
    crypto.createHmac('sha256', secret).update(segment).digest()
  );
}

function assertSecret(secret) {
  const resolved = String(secret || '').trim();
  if (resolved) return resolved;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }

  console.warn('[auth] JWT_SECRET missing; using dev fallback secret');
  return INSECURE_DEV_SECRET;
}

export function resolveJwtSecret() {
  return assertSecret(process.env.JWT_SECRET);
}

export function createSessionToken(
  {
    uid,
    role = 'PARTICIPANT',
    siteId = null,
    licenseId = null,
    orgId = null,
    email = null,
    tokenType = 'access',
    sessionId = null,
    jti = null,
  } = {},
  { secret = resolveJwtSecret(), ttlSeconds = DEFAULT_TTL_SECONDS } = {}
) {
  const subject = String(uid || '').trim();
  if (!subject) throw new Error('uid is required for session token');

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(60, Number(ttlSeconds || DEFAULT_TTL_SECONDS));
  const payload = {
    sub: subject,
    role: normalizeRole(role),
    siteId: siteId ? String(siteId).toUpperCase() : null,
    licenseId: licenseId ? String(licenseId).toUpperCase() : null,
    orgId: orgId ? String(orgId).toUpperCase() : null,
    email: email ? String(email).trim().toLowerCase() : null,
    tokenType: String(tokenType || 'access').trim().toLowerCase(),
    sessionId: sessionId ? String(sessionId).trim() : null,
    jti: jti ? String(jti).trim() : null,
    iat,
    exp,
    iss: TOKEN_ISSUER,
  };

  const headerSegment = toBase64Url(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  );
  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signedPart = `${headerSegment}.${payloadSegment}`;
  const signature = signSegment(signedPart, assertSecret(secret));
  return `${signedPart}.${signature}`;
}

export function verifySessionToken(
  token,
  { secret = resolveJwtSecret(), nowSeconds = Math.floor(Date.now() / 1000) } = {}
) {
  const raw = String(token || '').trim();
  if (!raw) throw new Error('token_missing');

  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('token_malformed');

  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    throw new Error('token_malformed');
  }

  const signedPart = `${headerSegment}.${payloadSegment}`;
  const expected = signSegment(signedPart, assertSecret(secret));
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureSegment);

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error('token_invalid_signature');
  }

  let header;
  let payload;
  try {
    header = JSON.parse(fromBase64Url(headerSegment).toString('utf8'));
    payload = JSON.parse(fromBase64Url(payloadSegment).toString('utf8'));
  } catch {
    throw new Error('token_bad_json');
  }

  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') {
    throw new Error('token_bad_header');
  }

  if (payload?.iss !== TOKEN_ISSUER) {
    throw new Error('token_bad_issuer');
  }

  if (!payload?.sub || typeof payload.sub !== 'string') {
    throw new Error('token_bad_subject');
  }

  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(exp) || exp <= nowSeconds) {
    throw new Error('token_expired');
  }

  return {
    uid: payload.sub,
    role: normalizeRole(payload.role),
    siteId: payload.siteId ? String(payload.siteId).toUpperCase() : null,
    licenseId: payload.licenseId
      ? String(payload.licenseId).toUpperCase()
      : null,
    orgId: payload.orgId ? String(payload.orgId).toUpperCase() : null,
    email: payload.email ? String(payload.email).trim().toLowerCase() : null,
    tokenType: String(payload.tokenType || 'access').trim().toLowerCase(),
    sessionId: payload.sessionId ? String(payload.sessionId).trim() : null,
    jti: payload.jti ? String(payload.jti).trim() : null,
    iat: Number(payload.iat || 0),
    exp,
  };
}
