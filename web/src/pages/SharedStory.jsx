import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { API_BASE } from '../api.js';

const THEME_LOOKUP = {
  heritage: {
    bg: '#f8f1df',
    surface: '#fff8ea',
    border: '#c9b394',
    accent: '#5f7f37',
    heading: '#2e2316',
    subheading: '#7c5223',
  },
  sunrise: {
    bg: '#fff4df',
    surface: '#fff8ee',
    border: '#d9aa72',
    accent: '#db5a32',
    heading: '#3b2115',
    subheading: '#7b3b1d',
  },
  meadow: {
    bg: '#edf6df',
    surface: '#f5faeb',
    border: '#9cb87c',
    accent: '#4f6e31',
    heading: '#1f2a16',
    subheading: '#3e5b2a',
  },
};

function useShareKey() {
  const location = useLocation();
  return useMemo(() => {
    const q = new URLSearchParams(location.search || '');
    return String(q.get('k') || '').trim();
  }, [location.search]);
}

function formatDate(ms) {
  const n = Number(ms || 0);
  if (!n) return '—';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '—';
  }
}

export default function SharedStory() {
  const { roomId, linkId } = useParams();
  const key = useShareKey();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [share, setShare] = useState(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!roomId || !linkId || !key) {
        setError('This link is missing access credentials.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const url = `${API_BASE}/shared/${encodeURIComponent(roomId)}/${encodeURIComponent(linkId)}?k=${encodeURIComponent(key)}`;
        const res = await fetch(url);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `share read failed (${res.status})`);
        }
        if (active) {
          setShare(body.share || null);
        }
      } catch (err) {
        if (active) {
          setError(err.message || 'Unable to load shared story.');
          setShare(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [roomId, linkId, key]);

  const theme = THEME_LOOKUP[String(share?.theme || 'heritage').toLowerCase()] || THEME_LOOKUP.heritage;

  if (loading) {
    return (
      <main className="page-reveal" style={{ maxWidth: 900, margin: '0 auto', padding: '30px 16px' }}>
        <article className="glass" style={{ padding: 18 }}>
          <div className="skeleton-line" style={{ width: '30%', height: 14 }} />
          <div className="skeleton-line mt8" style={{ width: '60%', height: 26 }} />
          <div className="skeleton-line mt8" style={{ width: '50%' }} />
          <div className="skeleton-line mt12" style={{ width: '94%' }} />
          <div className="skeleton-line" style={{ width: '96%' }} />
          <div className="skeleton-line" style={{ width: '82%' }} />
        </article>
      </main>
    );
  }

  if (error || !share) {
    return (
      <main className="page-reveal" style={{ maxWidth: 860, margin: '0 auto', padding: '30px 16px' }}>
        <article className="glass" style={{ padding: 18 }}>
          <h2 style={{ marginTop: 0 }}>Shared Story Unavailable</h2>
          <p style={{ marginBottom: 0 }}>{error || 'This story link is unavailable.'}</p>
        </article>
      </main>
    );
  }

  return (
    <main
      className="page-reveal"
      style={{
        maxWidth: 920,
        margin: '0 auto',
        padding: '28px 16px 40px',
      }}
    >
      <article
        style={{
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 20,
          padding: 22,
          boxShadow: '0 18px 40px rgba(50,30,10,.14)',
          color: theme.heading,
        }}
      >
        <div
          style={{
            display: 'inline-block',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: theme.accent,
            marginBottom: 10,
          }}
        >
          {share.orgLabel || 'StoryBloom'}
        </div>
        <h1 style={{ margin: '0 0 6px', fontSize: 34, lineHeight: 1.12 }}>{share.title || 'Workshop Story'}</h1>
        <h2 style={{ margin: 0, fontSize: 18, color: theme.subheading }}>{share.topic || 'Untitled Topic'}</h2>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.subheading, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>Room: {share.roomId || '—'}</span>
          <span>Views: {Number(share.viewCount || 0)}</span>
          <span>Expires: {formatDate(share.expiresAt)}</span>
        </div>
        <div
          style={{
            marginTop: 18,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.62,
            fontSize: 17,
            background: theme.bg,
            border: `1px solid ${theme.border}`,
            borderRadius: 14,
            padding: 14,
          }}
        >
          {String(share.content || '').trim() || 'No content available.'}
        </div>
      </article>
    </main>
  );
}
