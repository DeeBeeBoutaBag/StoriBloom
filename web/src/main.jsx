// web/main.jsx
import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import App from './App.jsx';
import './styles.css';

const Login = lazy(() => import('./pages/Login.jsx'));
const Room = lazy(() => import('./pages/Room.jsx'));
const Presenter = lazy(() => import('./pages/Presenter.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const SuperAdmin = lazy(() => import('./pages/SuperAdmin.jsx'));
const Status = lazy(() => import('./pages/Status.jsx'));
const SharedStory = lazy(() => import('./pages/SharedStory.jsx'));

const routeFallback = (
  <div className="center-wrap">
    <div className="glass">
      <div className="empty-state mini">Loading workspace…</div>
    </div>
  </div>
);

function lazyRoute(element) {
  return <Suspense fallback={routeFallback}>{element}</Suspense>;
}

// Vite entry point
const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error('Root element #root not found!');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter
      basename="/"
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        <Route path="/" element={<App />}>
          {/* landing / login */}
          <Route index element={lazyRoute(<Login />)} />

          {/* participant rooms */}
          <Route path="room/:roomId" element={lazyRoute(<Room />)} />

          {/* presenter HUD – supports /presenter and /presenter/E1 */}
          <Route path="presenter" element={lazyRoute(<Presenter />)} />
          <Route path="presenter/:siteId" element={lazyRoute(<Presenter />)} />

          {/* admin workshop console */}
          <Route path="admin" element={lazyRoute(<Admin />)} />

          {/* super admin watchtower */}
          <Route path="super-admin" element={lazyRoute(<SuperAdmin />)} />

          {/* customer-facing status page */}
          <Route path="status" element={lazyRoute(<Status />)} />
          <Route path="trust-center" element={lazyRoute(<Status />)} />
          <Route path="shared/:roomId/:linkId" element={lazyRoute(<SharedStory />)} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
