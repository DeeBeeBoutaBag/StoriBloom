// web/App.jsx
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { API_BASE } from './api.js';
import CommandPalette from './components/CommandPalette.jsx';
import AccessibilityPanel from './components/AccessibilityPanel.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [trustInfo, setTrustInfo] = useState(null);
  const location = useLocation();

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

  useEffect(() => {
    let active = true;
    async function loadTrust() {
      try {
        const res = await fetch(`${API_BASE}/trust-center`);
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          if (active) {
            setTrustInfo({
              status: json.status || 'UNKNOWN',
              dataUsage: json?.security?.dataUsage || 'NO_TRAINING',
              supportEscalationEmail:
                json.supportEscalationEmail || 'support@storibloom.app',
            });
          }
          return;
        }
      } catch {}
      if (active) {
        setTrustInfo({
          status: 'UNKNOWN',
          dataUsage: 'NO_TRAINING',
          supportEscalationEmail: 'support@storibloom.app',
        });
      }
    }
    loadTrust();
    return () => {
      active = false;
    };
  }, []);

  const immersivePath =
    location.pathname.startsWith('/room/') ||
    location.pathname.startsWith('/presenter') ||
    location.pathname.startsWith('/admin') ||
    location.pathname.startsWith('/super-admin') ||
    location.pathname.startsWith('/status') ||
    location.pathname.startsWith('/trust-center') ||
    location.pathname.startsWith('/shared/');

  const routedView = (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        className="page-reveal"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        <Outlet />
      </motion.div>
    </AnimatePresence>
  );

  const trustFloating = (
    <a href="/trust-center" className="trust-floating" title="Open trust center">
      <span>System: <b>{trustInfo?.status || (health?.ok ? 'OPERATIONAL' : 'UNKNOWN')}</b></span>
      <span>Data: <b>{trustInfo?.dataUsage || 'NO_TRAINING'}</b></span>
      <span>Support: <b>{trustInfo?.supportEscalationEmail || 'support@storibloom.app'}</b></span>
    </a>
  );

  if (immersivePath) {
    return (
      <>
        <CommandPalette />
        <AccessibilityPanel />
        {trustFloating}
        {routedView}
      </>
    );
  }

  return (
    <>
      <CommandPalette />
      <AccessibilityPanel />
      {trustFloating}
      <div className="app-shell">
        <h1 className="app-title">StoriBloom Collaboration Suite</h1>

        {/* Show quick API status */}
        {health ? (
          <div className={`app-health ${health.ok ? 'app-health-ok' : 'app-health-error'}`}>
            {health.ok
              ? `API connected (region: ${health.region})`
              : 'API unreachable - check server logs'}
          </div>
        ) : (
          <p className="app-health-pending">Checking API health...</p>
        )}

        {/* Nested routes */}
        {routedView}
      </div>
    </>
  );
}
