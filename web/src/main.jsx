// web/main.jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import App from './App.jsx';
import Login from './pages/Login.jsx';
import Room from './pages/Room.jsx';
import Presenter from './pages/Presenter.jsx';
import './styles.css';

// Vite entry point
const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error('Root element #root not found!');
}

createRoot(rootEl).render(
  <React.StrictMode>
    {/* basename ensures router works under Render Static with <base href="/"> */}
    <BrowserRouter basename="/">
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Login />} />
          <Route path="room/:roomId" element={<Room />} />
          <Route path="presenter/:siteId" element={<Presenter />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
