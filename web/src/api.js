// web/src/api.js
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Issue or reuse a guest token from the API
export async function ensureGuest() {
  let token = sessionStorage.getItem('guest_token');
  if (token) return token;

  const res = await fetch(`${API_BASE}/auth/guest`, { method: 'POST' });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || 'guest auth failed');
  }

  const json = await res.json();
  if (!json?.token) throw new Error('guest auth failed');

  sessionStorage.setItem('guest_token', json.token);
  sessionStorage.setItem('guest_user_id', json.userId || '');
  return json.token;
}

// Returns headers with Authorization: Bearer guest-...
export async function bearer() {
  const token = await ensureGuest();
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
}

// Alias for existing code that imports authHeaders
export const authHeaders = bearer;

export { API_BASE };
