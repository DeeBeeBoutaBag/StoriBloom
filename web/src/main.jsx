import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.jsx';
import Login from './pages/Login.jsx';
import Room from './pages/Room.jsx';
import Presenter from './pages/Presenter.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<App />}>
        <Route index element={<Login />} />
        <Route path="room/:roomId" element={<Room />} />
        <Route path="presenter/:siteId" element={<Presenter />} />
      </Route>
    </Routes>
  </BrowserRouter>
);
