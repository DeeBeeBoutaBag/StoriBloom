import { getAuth } from 'firebase/auth';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function authHeader() {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken(false);
  return { Authorization: `Bearer ${token}` };
}

export async function apiGet(path) {
  const headers = await authHeader();
  const res = await fetch(`${BASE_URL}${path}`, { method: 'GET', headers });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function apiPost(path, body) {
  const headers = await authHeader();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}
