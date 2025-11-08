// web/src/api.js

// Resolve API base. Prefer VITE_API_BASE, then VITE_API_URL, then '/api'.
export const API_BASE =
  (import.meta?.env?.VITE_API_BASE && String(import.meta.env.VITE_API_BASE)) ||
  (import.meta?.env?.VITE_API_URL && String(import.meta.env.VITE_API_URL)) ||
  '/api';

/**
 * Try a list of candidate URLs until one succeeds (2xx),
 * returning the successful Response (or the last failure).
 */
async function tryEndpoints(paths, init) {
  let lastErr;
  for (const p of paths) {
    try {
      const res = await fetch(p, init);
      if (res.ok) return res;
      lastErr = res;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof Response) return lastErr;
  throw lastErr;
}

/**
 * Issue or reuse a guest token from the API.
 * Stores:
 *  - sessionStorage.guest_token
 *  - sessionStorage.guest_user_id
 */
export async function ensureGuest() {
  let token = sessionStorage.getItem('guest_token');
  if (token) return token;

  // Try common auth endpoints in case your static proxy rewrites or not.
  const candidates = [
    `${API_BASE}/auth/guest`, // expected when /api is proxied to the API service
    `/api/auth/guest`,        // fallback if API_BASE didn't include /api
    `/auth/guest`,            // fallback when hitting API service directly (no prefix)
  ];

  const res = await tryEndpoints(candidates, { method: 'POST' });

  if (!res.ok) {
    // Try to extract a helpful error message
    let detail = '';
    try {
      const txt = await res.text();
      try {
        const j = JSON.parse(txt);
        detail = j?.error || txt;
      } catch {
        detail = txt;
      }
    } catch {}
    throw new Error(detail || `guest auth failed (${res.status})`);
  }

  // Parse JSON safely
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('guest auth failed: invalid JSON');
  }

  if (!json?.token) throw new Error('guest auth failed: missing token');

  sessionStorage.setItem('guest_token', json.token);
  if (json.userId) sessionStorage.setItem('guest_user_id', json.userId);
  return json.token;
}

/**
 * Returns headers with Authorization: Bearer guest-...
 * Use with fetch: fetch(url, await authHeaders())
 */
export async function authHeaders(extra = {}) {
  const token = await ensureGuest();
  const base = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  // Allow caller to extend/override headers if needed
  return {
    headers: { ...base, ...(extra.headers || {}) },
    ...extra,
  };
}

// Back-compat alias some files might import as `bearer`
export const bearer = authHeaders;

/* ---------------------------
   Convenience helpers (optional)
   --------------------------- */

/** GET JSON with auth */
export async function getJSON(path) {
  const res = await fetch(
    path.startsWith('http') ? path : `${API_BASE}${path}`,
    await authHeaders()
  );
  if (!res.ok) throw await buildHttpError(res);
  return res.json();
}

/** POST JSON with auth + body object */
export async function postJSON(path, body) {
  const res = await fetch(
    path.startsWith('http') ? path : `${API_BASE}${path}`,
    await authHeaders({ method: 'POST', body: JSON.stringify(body ?? {}) })
  );
  if (!res.ok) throw await buildHttpError(res);
  return res.json();
}

async function buildHttpError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      msg = j?.error ? `${msg}: ${j.error}` : `${msg}: ${txt}`;
    } catch {
      msg = `${msg}: ${txt}`;
    }
  } catch {}
  return new Error(msg);
}
