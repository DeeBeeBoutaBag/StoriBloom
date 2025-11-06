// web/src/api.js
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Keep the name `bearer` for backwards-compat with your imports
export async function bearer() {
  const token = await ensureGuest();
  return {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
}

// Same as bearer, but exported under a clearer name if you want to switch later
export const authHeaders = bearer;

// Issue or reuse a guest token from the API
export async function ensureGuest() {
  let token = sessionStorage.getItem('guest_token');
  if (token) return token;

  // GET or POST are fine; using POST to avoid caches
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

export { API_BASE };
