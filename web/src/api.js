// web/src/api.js
const VITE_ENV =
  typeof import.meta !== 'undefined' && import.meta?.env
    ? import.meta.env
    : {};

const RAW_BASE =
  VITE_ENV.VITE_API_BASE ||
  VITE_ENV.VITE_API_URL ||
  '/api';

// remove any trailing slash so we don't get `//auth/guest`
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export function getToken() {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem('token') || '';
}

export function getRefreshToken() {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem('refreshToken') || '';
}

function parseJwtExpiry(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp || 0);
  } catch {
    return 0;
  }
}

export function setAuthSession({
  token,
  accessToken,
  refreshToken,
  sessionId,
  userId,
  role,
  licenseId,
  siteId,
  orgId,
  email,
}) {
  if (typeof sessionStorage === 'undefined') return;
  const resolvedAccess = accessToken || token;
  if (resolvedAccess) sessionStorage.setItem('token', resolvedAccess);
  if (refreshToken) sessionStorage.setItem('refreshToken', refreshToken);
  if (sessionId) sessionStorage.setItem('sessionId', sessionId);
  if (userId) sessionStorage.setItem('userId', userId);
  if (role) sessionStorage.setItem('role', role);
  if (licenseId) sessionStorage.setItem('licenseId', licenseId);
  if (siteId) sessionStorage.setItem('siteId', siteId);
  if (orgId) sessionStorage.setItem('orgId', orgId);
  if (email) sessionStorage.setItem('superAdminEmail', String(email).toLowerCase());
}

export async function refreshSession() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  setAuthSession({
    token: json.token,
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    sessionId: json.sessionId,
  });
  return json;
}

export async function authHeaders() {
  let token = getToken();
  const exp = parseJwtExpiry(token);
  const now = Math.floor(Date.now() / 1000);
  if (token && exp && exp - now < 30) {
    const refreshed = await refreshSession().catch(() => null);
    if (refreshed?.accessToken || refreshed?.token) {
      token = refreshed.accessToken || refreshed.token;
    }
  }
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return { headers };
}

export function buildSseUrl(path) {
  const token = getToken();
  if (!token) return `${API_BASE}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}token=${encodeURIComponent(token)}`;
}

export async function ensureGuest() {
  let token = getToken();
  let userId = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem('userId');
  if (token && userId) return { token, userId };

  const res = await fetch(`${API_BASE}/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`guest auth failed: ${text || res.status}`);
  }

  const json = await res.json();
  token = json.token;
  userId = json.userId;
  setAuthSession({
    token,
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    sessionId: json.sessionId,
    userId,
    role: json.role || 'PARTICIPANT',
    orgId: json.orgId || '',
    licenseId: json.licenseId || '',
    siteId: json.siteId || '',
  });

  return { token, userId };
}
