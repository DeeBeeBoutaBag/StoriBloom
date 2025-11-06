// web/src/api.js

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const TOKEN_KEY = 'guestToken';

export { API_BASE };

/**
 * Get existing guest token or fetch a new one.
 * Stores token in sessionStorage.
 */
export async function ensureGuest() {
  const existing = sessionStorage.getItem(TOKEN_KEY);
  if (existing) return existing;

  const res = await fetch(`${API_BASE}/auth/guest`, { method: 'POST' });
  if (!res.ok) throw new Error('guest auth failed');
  const json = await res.json();
  if (!json?.token) throw new Error('guest auth: no token');
  sessionStorage.setItem(TOKEN_KEY, json.token);
  return json.token;
}

/** Return headers with Authorization bearer + JSON content-type */
export async function authHeaders() {
  const token = await ensureGuest();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}
