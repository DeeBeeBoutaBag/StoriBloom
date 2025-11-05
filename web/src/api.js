// web/src/api.js

// ----- API base -----
// Prefer Vite env, then a global window var (handy for S3 static hosting), then localhost.
export const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE) ||
  (typeof window !== 'undefined' && window.API_BASE) ||
  'http://localhost:4000';

// Normalize (no trailing slash)
export const _API = String(API_BASE).replace(/\/+$/, '');

// ----- Lightweight guest auth (short-lived JWT) -----
const TOKEN_KEY = 'sb_guest_jwt';
const TOKEN_TS_KEY = 'sb_guest_jwt_ts';
// Refresh guest token every ~50 minutes by default
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

/**
 * Get the stored guest token (if present).
 */
function getStoredToken() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    const tsStr = sessionStorage.getItem(TOKEN_TS_KEY) || localStorage.getItem(TOKEN_TS_KEY);
    const ts = tsStr ? Number(tsStr) : 0;
    if (!token) return null;
    return { token, ts };
  } catch {
    return null;
  }
}

/**
 * Store the token (sessionStorage preferred; falls back to localStorage).
 */
function setStoredToken(token) {
  const now = Date.now();
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_TS_KEY, String(now));
  } catch {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_TS_KEY, String(now));
  }
}

/**
 * Clear the stored token (sign out guest).
 */
export function signOutGuest() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_TS_KEY);
  } catch {}
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_TS_KEY);
  } catch {}
}

/**
 * Ensures a valid guest token exists.
 * Calls POST /auth/guest to obtain a short-lived JWT and stores it.
 */
export async function ensureGuest() {
  const current = getStoredToken();
  if (current && Date.now() - current.ts < TOKEN_MAX_AGE_MS) {
    return current.token;
  }
  const res = await fetch(`${_API}/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}' // no payload needed; server issues a guest token
  });
  if (!res.ok) {
    throw new Error('Failed to obtain guest token');
  }
  const json = await res.json();
  const token = json?.token;
  if (!token) {
    throw new Error('Guest token missing in response');
  }
  setStoredToken(token);
  return token;
}

/**
 * Returns a standard fetch options object with Authorization header set.
 * Usage: fetch(url, await bearer())
 */
export async function bearer(extraHeaders) {
  const token = (getStoredToken() && getStoredToken().token) || (await ensureGuest());
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(extraHeaders || {}),
    },
  };
}

/**
 * Simple GET helper (authorized).
 */
export async function get(path) {
  const res = await fetch(`${_API}${path}`, await bearer());
  if (!res.ok) {
    const t = await safeJson(res);
    throw new Error(t?.error || `GET ${path} failed`);
  }
  return res.json();
}

/**
 * Simple POST helper (authorized).
 */
export async function post(path, body) {
  const res = await fetch(`${_API}${path}`, {
    method: 'POST',
    ...(await bearer()),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await safeJson(res);
    throw new Error(t?.error || `POST ${path} failed`);
  }
  return res.json();
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

// ----- Room/state polling helpers used by Room.jsx -----

/**
 * GET /rooms/:roomId/state
 * Returns { stage, stageEndsAt, siteId, index, inputLocked, topic, ideaSummary, vote? }
 */
export async function getRoomState(roomId) {
  const res = await fetch(`${_API}/rooms/${encodeURIComponent(roomId)}/state`, await bearer());
  if (!res.ok) {
    const t = await safeJson(res);
    throw new Error(t?.error || 'State fetch failed');
  }
  return res.json();
}

/**
 * GET /rooms/:roomId/messages?since=ts&phase=DISCOVERY
 * Returns { items: [...], lastTs }
 * - since: number (unix ms) — server returns messages after this ts
 * - phase: optional filter; pass null for all phases (client filters by stage in UI anyway)
 */
export async function getMessages(roomId, since, phase) {
  const url = new URL(`${_API}/rooms/${encodeURIComponent(roomId)}/messages`);
  if (since != null) url.searchParams.set('since', String(since));
  if (phase) url.searchParams.set('phase', phase);
  const res = await fetch(url, await bearer());
  if (!res.ok) {
    const t = await safeJson(res);
    throw new Error(t?.error || 'Messages fetch failed');
  }
  return res.json();
}
