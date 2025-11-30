// web/src/api.js
const RAW_BASE =
  import.meta.env.VITE_API_BASE || 'http://localhost:4000';

// remove any trailing slash so we don't get `//auth/guest`
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export async function authHeaders() {
  const token = sessionStorage.getItem('token');
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return { headers };
}

export async function ensureGuest() {
  let token = sessionStorage.getItem('token');
  let userId = sessionStorage.getItem('userId');
  if (token && userId) return { token, userId };

  // 🔥 IMPORTANT: only call the API_BASE, not /api relative
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

  sessionStorage.setItem('token', token);
  sessionStorage.setItem('userId', userId);

  return { token, userId };
}
