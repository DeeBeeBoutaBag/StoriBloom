// web/App.jsx
import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export default function App() {
  const [health, setHealth] = useState(null);

  // simple health check on mount to confirm API connectivity
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((res) => res.json())
      .then(setHealth)
      .catch((err) => {
        console.error('[App] API health check failed:', err);
        setHealth({ ok: false, error: err.message });
      });
  }, []);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ textAlign: 'center', marginBottom: 24 }}>AsemaCollab Lite</h1>

      {/* Show quick API status */}
      {health ? (
        <div
          style={{
            background: health.ok ? '#d1fae5' : '#fee2e2',
            color: health.ok ? '#065f46' : '#991b1b',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 24,
            fontSize: 14,
          }}
        >
          {health.ok
            ? `✅ API connected (region: ${health.region})`
            : `❌ API unreachable — check console`}
        </div>
      ) : (
        <p style={{ color: '#6b7280', fontSize: 14 }}>Checking API health...</p>
      )}

      {/* Nested routes */}
      <Outlet />
    </div>
  );
}
