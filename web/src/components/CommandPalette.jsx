import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { API_BASE, authHeaders } from '../api.js';

function parseCsv(text) {
  return String(text || '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

async function apiRequest(path, options = {}) {
  const { method = 'POST', body } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    ...(await authHeaders()),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || json.message || `Request failed: ${res.status}`);
  }
  return json;
}

function paletteAction({ id, label, hint, keywords, run }) {
  return { id, label, hint, keywords, run };
}

export default function CommandPalette() {
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  const actions = useMemo(
    () => [
      paletteAction({
        id: 'jump-room',
        label: 'Jump to room',
        hint: 'Open any room by roomId',
        keywords: 'room jump go open participant',
        run: () => {
          const roomId = window.prompt('Room ID');
          if (!roomId) return;
          navigate(`/room/${encodeURIComponent(roomId.trim())}`);
        },
      }),
      paletteAction({
        id: 'go-presenter',
        label: 'Open presenter',
        hint: 'Go to presenter HUD',
        keywords: 'presenter hud site',
        run: () => navigate('/presenter'),
      }),
      paletteAction({
        id: 'go-admin',
        label: 'Open org admin',
        hint: 'Go to enterprise admin console',
        keywords: 'admin enterprise users licenses settings',
        run: () => navigate('/admin'),
      }),
      paletteAction({
        id: 'go-super-admin',
        label: 'Open super admin',
        hint: 'Go to operations watchtower',
        keywords: 'super admin ops health',
        run: () => navigate('/super-admin'),
      }),
      paletteAction({
        id: 'go-status',
        label: 'Open trust center',
        hint: 'Customer-facing status and security view',
        keywords: 'status trust incidents sla security',
        run: () => navigate('/trust-center'),
      }),
      paletteAction({
        id: 'refresh-screen',
        label: 'Refresh current page',
        hint: 'Hard refresh browser view',
        keywords: 'refresh reload',
        run: () => window.location.reload(),
      }),
      paletteAction({
        id: 'toggle-copilot',
        label: 'Toggle copilot panel',
        hint: 'Show or hide side AI helper',
        keywords: 'copilot ai panel assistant',
        run: () => window.dispatchEvent(new CustomEvent('copilot:toggle')),
      }),
      paletteAction({
        id: 'create-code',
        label: 'Create access code',
        hint: 'Generate codes from command palette',
        keywords: 'code generate license super admin',
        run: async () => {
          const role = (window.prompt('Role (PARTICIPANT/PRESENTER/ADMIN)', 'PARTICIPANT') || '')
            .trim()
            .toUpperCase();
          if (!role) return;
          const count = Number(window.prompt('How many codes?', '1') || 1);
          const siteId = (window.prompt('Primary site ID', 'E1') || '').trim().toUpperCase();
          const siteIds = parseCsv(window.prompt('Optional site IDs (comma separated)', siteId || ''));
          const orgId = (window.prompt('Org ID (optional)', '') || '').trim().toUpperCase();
          const licenseId = (window.prompt('License ID (optional)', '') || '')
            .trim()
            .toUpperCase();

          const data = await apiRequest('/super-admin/codes/generate', {
            method: 'POST',
            body: {
              role,
              count: Number.isFinite(count) ? Math.max(1, Math.min(500, count)) : 1,
              siteId,
              siteIds,
              orgId,
              licenseId,
            },
          });
          const generated = Array.isArray(data.codes) ? data.codes.length : 0;
          setFeedback(`Generated ${generated} code(s).`);
        },
      }),
      paletteAction({
        id: 'publish-template',
        label: 'Publish template',
        hint: 'Publish a template version now',
        keywords: 'template publish governance admin',
        run: async () => {
          const templateId = (window.prompt('Template ID to publish') || '').trim();
          if (!templateId) return;
          const versionRaw = (window.prompt('Version (optional)', '') || '').trim();
          const version = Number(versionRaw || 0);
          const body = version > 0 ? { version } : {};

          const data = await apiRequest(`/admin/templates/${encodeURIComponent(templateId)}/publish`, {
            method: 'POST',
            body,
          });

          if (data.approvalRequired && data.approval?.approvalId) {
            setFeedback(`Publish queued for approval (${data.approval.approvalId}).`);
          } else {
            setFeedback(`Template ${templateId} published.`);
          }
        },
      }),
      paletteAction({
        id: 'escalate-ticket',
        label: 'Escalate support ticket',
        hint: 'Escalate ticket to high-priority support',
        keywords: 'support escalate ticket incident',
        run: async () => {
          const orgId = (window.prompt('Org ID') || '').trim().toUpperCase();
          if (!orgId) return;
          const ticketId = (window.prompt('Ticket ID') || '').trim();
          if (!ticketId) return;
          const note = (window.prompt('Escalation note', 'Escalated from command palette.') || '').trim();

          await apiRequest(
            `/super-admin/support/${encodeURIComponent(orgId)}/${encodeURIComponent(ticketId)}/update`,
            {
              method: 'POST',
              body: {
                ticketStatus: 'ESCALATED',
                note,
              },
            }
          );

          setFeedback(`Ticket ${ticketId} escalated.`);
        },
      }),
    ],
    [navigate]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((action) => {
      const haystack = `${action.label} ${action.hint || ''} ${action.keywords || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    function onKeyDown(e) {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (cmdK) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (!open) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const action = filtered[activeIndex];
        if (action) {
          void runAction(action);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, filtered, activeIndex]);

  useEffect(() => {
    if (!feedback) return undefined;
    const id = setTimeout(() => setFeedback(''), 2400);
    return () => clearTimeout(id);
  }, [feedback]);

  useEffect(() => {
    setOpen(false);
    setQuery('');
  }, [location.pathname]);

  async function runAction(action) {
    if (!action || busy) return;
    try {
      setBusy(true);
      setFeedback('');
      await action.run();
      setOpen(false);
      setQuery('');
    } catch (err) {
      setFeedback(err.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="command-palette-trigger"
        onClick={() => setOpen(true)}
        aria-label="Open command palette"
      >
        <span>Commands</span>
        <kbd>Cmd/Ctrl + K</kbd>
      </button>

      {feedback ? <div className="command-palette-feedback">{feedback}</div> : null}

      {open ? (
        <div className="command-palette-overlay" onClick={() => setOpen(false)}>
          <div
            className="command-palette"
            role="dialog"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="command-palette-head">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search actions, pages, workflows..."
              />
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            <div className="command-palette-list">
              {filtered.map((action, index) => (
                <button
                  key={action.id}
                  type="button"
                  className={`command-item ${index === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runAction(action)}
                  disabled={busy}
                >
                  <div className="command-item-title">{action.label}</div>
                  <div className="command-item-hint">{action.hint}</div>
                </button>
              ))}

              {!filtered.length ? (
                <div className="command-palette-empty">
                  No matches for <b>{query}</b>. Try keywords like <code>room</code>,{' '}
                  <code>code</code>, <code>template</code>, or <code>ticket</code>.
                </div>
              ) : null}
            </div>

            <div className="command-palette-foot">
              <span>Use ↑ ↓ to navigate</span>
              <span>Enter to run</span>
              <span>Esc to close</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
