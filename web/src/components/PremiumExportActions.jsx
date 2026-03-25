import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../api.js';

function safeFilename(input, fallback = 'story') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const EXPORT_THEMES = {
  heritage: {
    id: 'heritage',
    label: 'Heritage',
    bg: '#f8f1df',
    surface: '#fff8ea',
    border: '#c9b394',
    accent: '#5f7f37',
    heading: '#2e2316',
    subheading: '#7c5223',
  },
  sunrise: {
    id: 'sunrise',
    label: 'Sunrise',
    bg: '#fff4df',
    surface: '#fff8ee',
    border: '#d9aa72',
    accent: '#db5a32',
    heading: '#3b2115',
    subheading: '#7b3b1d',
  },
  meadow: {
    id: 'meadow',
    label: 'Meadow',
    bg: '#edf6df',
    surface: '#f5faeb',
    border: '#9cb87c',
    accent: '#4f6e31',
    heading: '#1f2a16',
    subheading: '#3e5b2a',
  },
};

function buildBrandedHtml({ title, topic, content, orgLabel, theme, template }) {
  const safeTitle = title || 'Workshop Story';
  const safeTopic = topic || 'Untitled Topic';
  const safeOrg = orgLabel || 'StoryBloom';
  const safeBody = String(content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const selectedTheme = EXPORT_THEMES[theme] || EXPORT_THEMES.heritage;
  const templateLabel =
    template === 'brief'
      ? 'Executive Brief'
      : template === 'storyboard'
      ? 'Storyboard'
      : 'Narrative Story';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body { margin: 0; background: ${selectedTheme.bg}; font-family: Georgia, serif; color: ${selectedTheme.heading}; }
      .shell { max-width: 920px; margin: 0 auto; padding: 36px 24px 60px; }
      .hero { border: 1px solid ${selectedTheme.border}; border-radius: 20px; background: ${selectedTheme.surface}; padding: 24px; }
      .brand { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: ${selectedTheme.accent}; }
      h1 { margin: 12px 0 6px; font-size: 36px; line-height: 1.1; }
      h2 { margin: 0; font-size: 18px; color: ${selectedTheme.subheading}; }
      h3 { margin: 16px 0 6px; font-size: 14px; letter-spacing: 0.1em; text-transform: uppercase; color: ${selectedTheme.accent}; }
      .body { margin-top: 18px; white-space: pre-wrap; line-height: 1.6; font-size: 17px; }
      .foot { margin-top: 24px; font-size: 12px; color: #6a5f52; }
      @media print {
        body { background: #fff; }
        .hero { border-color: #b7a48a; box-shadow: none; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="brand">${safeOrg}</div>
        <h1>${safeTitle}</h1>
        <h2>${safeTopic}</h2>
        <h3>${templateLabel}</h3>
        <div class="body">${safeBody}</div>
        <div class="foot">Generated from StoryBloom premium export.</div>
      </section>
    </main>
  </body>
</html>`;
}

export default function PremiumExportActions({
  title = 'Workshop Story',
  topic = '',
  content = '',
  orgLabel = '',
  defaultTemplate = 'story',
  defaultTheme = 'heritage',
  className = '',
  roomId = '',
}) {
  const [template, setTemplate] = useState(defaultTemplate);
  const [theme, setTheme] = useState(defaultTheme);
  const [shareLinks, setShareLinks] = useState([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [expiresHours, setExpiresHours] = useState(168);
  const [maxViews, setMaxViews] = useState(0);
  const templateLabel = useMemo(() => {
    if (template === 'brief') return 'Executive Brief';
    if (template === 'storyboard') return 'Storyboard';
    return 'Narrative Story';
  }, [template]);
  const base = safeFilename(`${title}-${topic}`, 'story');
  const canShare = !!String(roomId || '').trim() && !!String(content || '').trim();

  const loadShareLinks = useCallback(async () => {
    if (!roomId) {
      setShareLinks([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/share-links`, {
        ...(await authHeaders()),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `share links fetch failed (${res.status})`);
      }
      const body = await res.json().catch(() => ({}));
      setShareLinks(Array.isArray(body.links) ? body.links : []);
    } catch (err) {
      setShareError(err.message || 'Failed to load share links.');
    }
  }, [roomId]);

  useEffect(() => {
    setShareError('');
    setShareNotice('');
    if (!roomId) {
      setShareLinks([]);
      return;
    }
    void loadShareLinks();
  }, [roomId, loadShareLinks]);

  function exportWebStory() {
    const html = buildBrandedHtml({ title, topic, content, orgLabel, theme, template });
    downloadBlob(`${base}.html`, 'text/html;charset=utf-8', html);
  }

  function exportSlides() {
    const slideSections = [
      `# ${title}`,
      `## ${topic || 'Untitled Topic'}`,
      `### Template: ${templateLabel}`,
      '---',
      content,
      '---',
      '## Credits',
      `Generated in StoryBloom • Theme: ${(EXPORT_THEMES[theme] || EXPORT_THEMES.heritage).label}`,
    ];
    const md = slideSections.join('\n\n');
    downloadBlob(`${base}.md`, 'text/markdown;charset=utf-8', md);
  }

  function exportPdf() {
    const html = buildBrandedHtml({ title, topic, content, orgLabel, theme, template });
    const popup = window.open('', '_blank', 'noopener,noreferrer,width=980,height=740');
    if (!popup) return;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  async function createShareLink() {
    if (!canShare) return;
    setShareBusy(true);
    setShareError('');
    setShareNotice('');
    try {
      const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/share-links`, {
        method: 'POST',
        ...(await authHeaders()),
        body: JSON.stringify({
          title,
          topic,
          content,
          orgLabel,
          template,
          theme,
          expiresHours: Number(expiresHours || 168),
          maxViews: Number(maxViews || 0),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `share link create failed (${res.status})`);
      }
      const url = String(body?.link?.url || '').trim();
      if (url) {
        const copied = await copyText(url);
        setShareNotice(copied ? 'Share link created and copied.' : 'Share link created.');
      } else {
        setShareNotice('Share link created.');
      }
      await loadShareLinks();
    } catch (err) {
      setShareError(err.message || 'Failed to create share link.');
    } finally {
      setShareBusy(false);
    }
  }

  async function toggleRevoke(linkId, revoked) {
    if (!roomId || !linkId) return;
    setShareBusy(true);
    setShareError('');
    setShareNotice('');
    try {
      const res = await fetch(
        `${API_BASE}/rooms/${encodeURIComponent(roomId)}/share-links/${encodeURIComponent(linkId)}/revoke`,
        {
          method: 'POST',
          ...(await authHeaders()),
          body: JSON.stringify({ revoked }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `share link update failed (${res.status})`);
      }
      setShareLinks(Array.isArray(body.links) ? body.links : []);
      setShareNotice(revoked ? 'Share link revoked.' : 'Share link restored.');
    } catch (err) {
      setShareError(err.message || 'Failed to update share link.');
    } finally {
      setShareBusy(false);
    }
  }

  return (
    <div className={`premium-exports ${className}`.trim()}>
      <div className="premium-export-studio">
        <label>
          Template
          <select className="select" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="story">Narrative Story</option>
            <option value="brief">Executive Brief</option>
            <option value="storyboard">Storyboard</option>
          </select>
        </label>
        <label>
          Theme
          <select className="select" value={theme} onChange={(e) => setTheme(e.target.value)}>
            {Object.values(EXPORT_THEMES).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className="btn" onClick={exportPdf} disabled={!content.trim()}>
        Export PDF
      </button>
      <button type="button" className="btn" onClick={exportSlides} disabled={!content.trim()}>
        Export Slides
      </button>
      <button type="button" className="btn" onClick={exportWebStory} disabled={!content.trim()}>
        Export Web Story
      </button>

      {roomId ? (
        <div className="premium-share-wrap">
          <div className="premium-share-head">
            <span>Hosted Share Links</span>
            <span className="premium-share-meta">Permissioned + expiring</span>
          </div>
          <div className="premium-share-controls">
            <label>
              Expires (hours)
              <input
                className="input"
                type="number"
                min="1"
                max="8760"
                value={expiresHours}
                onChange={(e) => setExpiresHours(e.target.value)}
              />
            </label>
            <label>
              Max Views (0 = unlimited)
              <input
                className="input"
                type="number"
                min="0"
                max="100000"
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
              />
            </label>
          </div>
          <div className="premium-share-actions">
            <button type="button" className="btn primary" onClick={createShareLink} disabled={!canShare || shareBusy}>
              {shareBusy ? 'Working…' : 'Create Share Link'}
            </button>
            <button type="button" className="btn" onClick={loadShareLinks} disabled={!roomId || shareBusy}>
              Refresh Links
            </button>
          </div>
          {shareError ? <div className="premium-share-error">{shareError}</div> : null}
          {shareNotice ? <div className="premium-share-notice">{shareNotice}</div> : null}
          <div className="premium-share-list">
            {shareLinks.map((link) => (
              <div key={link.linkId} className="premium-share-item">
                <div className="premium-share-item-main">
                  <div className="premium-share-item-title">{link.title || 'Story Link'}</div>
                  <div className="premium-share-item-meta">
                    <span>{link.revoked ? 'Revoked' : 'Active'}</span>
                    <span>Views: {Number(link.viewCount || 0)}</span>
                    <span>
                      Expires:{' '}
                      {Number(link.expiresAt || 0)
                        ? new Date(Number(link.expiresAt)).toLocaleString()
                        : 'Never'}
                    </span>
                  </div>
                </div>
                <div className="premium-share-item-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => copyText(link.url || '')}
                    disabled={!link.url}
                  >
                    Copy Link
                  </button>
                  <a className="btn" href={link.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => toggleRevoke(link.linkId, !link.revoked)}
                  >
                    {link.revoked ? 'Restore' : 'Revoke'}
                  </button>
                </div>
              </div>
            ))}
            {!shareLinks.length ? (
              <div className="premium-share-empty">No hosted links yet.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
