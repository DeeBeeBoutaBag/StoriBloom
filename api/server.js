// /opt/StoriBloom/api/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'; // top of file (you likely already have QueryCommand)

// ---------- Optional deps (don’t crash if missing) ----------
let compression = null;
let morgan = null;
try { ({ default: compression } = await import('compression')); } catch { console.warn('[warn] compression not installed'); }
try { ({ default: morgan } = await import('morgan')); } catch { console.warn('[warn] morgan not installed'); }

// ---------- AWS SDK v3 (DynamoDB) ----------
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

// ---------- ENV ----------
/*
Example .env (local dev; use Render env vars in prod):

PORT=4000
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DYNAMO_ENDPOINT=http://localhost:8000   # optional (DynamoDB Local)
CORS_ORIGINS=http://localhost:5173
STATIC_INDEX=0
# Tables (override if your names differ)
DDB_TABLE_CODES=storibloom_codes
DDB_TABLE_ROOMS=storibloom_rooms
DDB_TABLE_MESSAGES=storibloom_messages
DDB_TABLE_DRAFTS=storibloom_drafts
DDB_TABLE_PERSONAS=storibloom_personas
DDB_TABLE_SESSIONS=storibloom_sessions
*/
const PORT = Number(process.env.PORT || 4000);
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const AWS_DYNAMO_ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// We default to your table names if envs aren’t set:
const TABLES = {
  codes: process.env.DDB_TABLE_CODES || process.env.TABLE_CODES || 'storibloom_codes',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  personas: process.env.DDB_TABLE_PERSONAS || 'storibloom_personas',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
};

// Serving SPA from this service is OFF by default (you’re on Render Static)
const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const ENABLE_SPA = String(process.env.STATIC_INDEX || '0') === '1';

// ---------- AWS ----------
const ddb = new DynamoDBClient({
  region: AWS_REGION,
  ...(AWS_DYNAMO_ENDPOINT ? { endpoint: AWS_DYNAMO_ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

// Early logs (cred/region) to diagnose issues quickly
(async () => {
  try {
    const creds = await ddb.config.credentials();
    if (creds?.accessKeyId) console.log('[aws] Credentials resolved');
    else console.error('[aws] No AWS credentials resolved');
  } catch (e) {
    console.error('[aws] Failed resolving credentials:', e?.message || e);
  }
  console.log(`[aws] region=${AWS_REGION} endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'} tables=${JSON.stringify(TABLES)}`);
})();

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// ---------- CORS ----------
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  })
);
app.options('*', cors());

// ---------- Body parsing ----------
app.use(express.json({ limit: '1mb' }));

// ---------- Optional middleware ----------
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

// ---------- Tiny logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Auth Helpers ----------
function handleGuestAuth(_req, res) {
  try {
    const id = crypto.randomUUID();
    const token = `guest-${id}`;
    res.json({ token, userId: id });
  } catch (e) {
    console.error('[auth/guest] error:', e);
    res.status(500).json({ error: 'guest auth failed' });
  }
}
app.post('/auth/guest', handleGuestAuth);
app.post('/api/auth/guest', handleGuestAuth); // alias if proxy doesn’t strip /api

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !token.startsWith('guest-')) {
      return res.status(401).json({ error: 'Missing or invalid token' });
    }
    const uid = token.replace('guest-', '');
    if (!uid) return res.status(401).json({ error: 'Invalid uid' });
    req.user = { uid };
    req.userToken = token;
    return next();
  } catch (err) {
    console.error('[requireAuth] error:', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ---------- Health / Version ----------
const healthPayload = () => ({ ok: true, region: AWS_REGION, time: new Date().toISOString() });
app.get('/health', (_req, res) => res.json(healthPayload()));
app.get('/api/health', (_req, res) => res.json(healthPayload())); // alias
app.get('/version', (_req, res) => {
  res.json({
    commit: process.env.GIT_COMMIT || null,
    build: process.env.BUILD_ID || null,
    time: new Date().toISOString(),
  });
});

// ---------- Helpers: Rooms / Messages / Drafts ----------
const DEFAULT_STAGE = 'LOBBY';
const ROOM_ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL','CLOSED'];

function parseRoomId(roomId) {
  const [siteId, idxStr] = String(roomId).split('-');
  return { siteId: (siteId || 'E1').toUpperCase(), index: Number(idxStr || 1) };
}

async function getRoom(roomId) {
  const { Item } = await ddbDoc.send(new GetCommand({ TableName: TABLES.rooms, Key: { roomId } }));
  return Item || null;
}

async function ensureRoom(roomId) {
  let r = await getRoom(roomId);
  if (r) return r;
  const { siteId, index } = parseRoomId(roomId);
  // Create with defaults
  r = {
    roomId,
    siteId,
    index,
    stage: DEFAULT_STAGE,
    stageEndsAt: Date.now() + 60_000,
    inputLocked: false,
    topic: '',
    ideaSummary: '',
    voteOpen: false,
    voteTotal: 0,
    voteTallies: {}, // map num -> count
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await ddbDoc.send(new PutCommand({ TableName: TABLES.rooms, Item: r }));
  return r;
}

async function updateRoom(roomId, patch) {
  const next = { ...(await getRoom(roomId)) || {}, roomId, ...patch, updatedAt: Date.now() };
  await ddbDoc.send(new PutCommand({ TableName: TABLES.rooms, Item: next }));
  return next;
}

function advanceStageVal(stage) {
  const i = ROOM_ORDER.indexOf(stage || DEFAULT_STAGE);
  return i >= 0 && i < ROOM_ORDER.length - 1 ? ROOM_ORDER[i + 1] : (stage || DEFAULT_STAGE);
}

// ---------- Presenter: list rooms for a site ----------
app.get('/presenter/rooms', requireAuth, async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) return res.json({ rooms: [] });

  // Create/ensure 4 rooms per site by default (no GSI needed)
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const id = `${siteId}-${i}`;
    const r = await ensureRoom(id);
    out.push({
      id: r.roomId,
      index: r.index,
      stage: r.stage,
      inputLocked: !!r.inputLocked,
      topic: r.topic || '',
      seats: r.seats || null,
      vote: {
        open: !!r.voteOpen,
        total: Number(r.voteTotal || 0),
        tallies: r.voteTallies || {},
      },
    });
  }
  res.json({ rooms: out });
});

// ---------- Room state ----------
app.get('/rooms/:roomId/state', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const r = await ensureRoom(roomId);
  res.json({
    id: r.roomId,
    siteId: r.siteId,
    index: r.index,
    stage: r.stage,
    stageEndsAt: r.stageEndsAt,
    inputLocked: !!r.inputLocked,
    topic: r.topic || '',
    ideaSummary: r.ideaSummary || '',
  });
});

app.post('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { text, phase, personaIndex = 0 } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const createdAt = Date.now();
  await ddbDoc.send(new PutCommand({
    TableName: TABLES.messages || process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
    Item: {
      roomId,
      createdAt,
      uid: req.user.uid,
      personaIndex,
      authorType: 'user',
      phase: phase || 'LOBBY',
      text,
    },
  }));
  res.json({ ok: true, createdAt });
});

// ---------- Messages (read latest) ----------
app.get('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  // We assume PK: roomId, SK: createdAt (Number) in your storibloom_messages
  // If you have a different key schema, adjust Query accordingly.
  const limit = Math.min(200, Number(req.query.limit || 100));
  const { Items } = await ddbDoc.send(new QueryCommand({
    TableName: TABLES.messages,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
    ScanIndexForward: true, // oldest first
    Limit: limit,
  }));
  res.json({ messages: Items || [] });
});

// ---------- Stage controls ----------
app.post('/rooms/:roomId/next', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const cur = await ensureRoom(roomId);
  const nextStage = advanceStageVal(cur.stage);
  const updated = await updateRoom(roomId, { stage: nextStage, stageEndsAt: Date.now() + 10 * 60_000 });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/extend', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const by = Math.max(1, Number((req.body && req.body.by) || 120));
  const cur = await ensureRoom(roomId);
  const updated = await updateRoom(roomId, { stageEndsAt: (cur.stageEndsAt || Date.now()) + by * 1000 });
  res.json({ ok: true, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const updated = await updateRoom(roomId, { stage: 'ROUGH_DRAFT', stageEndsAt: Date.now() + 10 * 60_000 });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/lock', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const inputLocked = !!(req.body && req.body.inputLocked);
  const updated = await updateRoom(roomId, { inputLocked });
  res.json({ ok: true, inputLocked: !!updated.inputLocked });
});

// ---------- Voting ----------
app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  const r = await ensureRoom(req.params.roomId);
  res.json({
    votingOpen: !!r.voteOpen,
    options: [], // client shows defaults if empty
    votesReceived: Number(r.voteTotal || 0),
    counts: Object.values(r.voteTallies || {}),
    topic: r.topic || '',
  });
});

app.post('/rooms/:roomId/vote/start', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  await updateRoom(roomId, { voteOpen: true, voteTotal: 0, voteTallies: {} });
  res.json({ ok: true, started: true });
});

app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { choice } = req.body || {};
  if (typeof choice !== 'number') return res.status(400).json({ error: 'choice must be a number' });
  const r = await ensureRoom(roomId);
  if (!r.voteOpen) return res.status(400).json({ error: 'voting_closed' });

  const tallies = { ...(r.voteTallies || {}) };
  tallies[choice] = (tallies[choice] || 0) + 1;
  await updateRoom(roomId, { voteTallies: tallies, voteTotal: Number(r.voteTotal || 0) + 1 });
  res.json({ ok: true });
});

app.post('/rooms/:roomId/vote/close', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const r = await ensureRoom(roomId);
  const tallies = r.voteTallies || {};
  let topic = r.topic || '';

  // Pick highest tally
  const entries = Object.entries(tallies);
  if (entries.length) {
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
    const [winningNum] = entries[0];
    const ISSUE_MAP = {
      1: 'Law Enforcement Profiling',
      2: 'Food Deserts',
      3: 'Red Lining',
      4: 'Homelessness',
      5: 'Wealth Gap',
    };
    topic = ISSUE_MAP[Number(winningNum)] || `#${winningNum}`;
  }

  await updateRoom(roomId, { voteOpen: false, topic });
  res.json({ ok: true, closed: true, topic });
});

// ---------- Ideas / Draft / Final / Ask stubs (write to Dynamo where useful) ----------
app.post('/rooms/:roomId/welcome', requireAuth, async (_req, res) => res.json({ ok: true }));
app.post('/rooms/:roomId/ask', requireAuth, async (_req, res) => res.json({ ok: true }));
app.post('/rooms/:roomId/ideas/trigger', requireAuth, async (_req, res) => res.json({ ok: true }));

// Draft placeholder: write a minimal record to drafts table
app.post('/rooms/:roomId/draft/generate', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const createdAt = Date.now();
  await ddbDoc.send(new PutCommand({
    TableName: TABLES.drafts,
    Item: {
      roomId,
      createdAt,
      content: 'Draft generated (placeholder)',
      version: 1,
    },
  }));
  // Also stash a small hint into room.ideaSummary for the sidebar
  const r = await ensureRoom(roomId);
  const merged = (r.ideaSummary ? `${r.ideaSummary}\n` : '') + '• Draft generated (placeholder)';
  await updateRoom(roomId, { ideaSummary: merged });
  res.json({ ok: true, createdAt });
});

app.post('/rooms/:roomId/final/start', requireAuth, async (_req, res) => res.json({ ok: true }));
app.post('/rooms/:roomId/final/complete', requireAuth, async (_req, res) => res.json({ ok: true }));

// ---------- Codes: consume (DynamoDB-backed) ----------
/**
 * Body: { code: "P-1234" | "U-ABCD" }
 * Table: TABLES.codes (PK: code)
 * Returns: { siteId, role }
 * (Optional) marks consumed if attributes exist.
 */
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }

    const getRes = await ddbDoc.send(new GetCommand({
      TableName: TABLES.codes,
      Key: { code: code.trim() },
    }));

    const item = getRes.Item;
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });

    try {
      await ddbDoc.send(new UpdateCommand({
        TableName: TABLES.codes,
        Key: { code: item.code },
        UpdateExpression: 'SET consumed = :c, usedBy = :u, consumedAt = :t',
        ExpressionAttributeValues: {
          ':c': true,
          ':u': req.user.uid || '(unknown)',
          ':t': Date.now(),
        },
      }));
    } catch (e) {
      console.warn('[codes/consume] update skipped:', e?.message || e);
    }

    // Ensure initial rooms for this site exist so presenter UI loads immediately
    const siteId = (item.siteId || 'E1').toUpperCase();
    for (let i = 1; i <= 4; i++) {
      await ensureRoom(`${siteId}-${i}`);
    }

    return res.json({
      siteId,
      role: item.role || 'PARTICIPANT',
    });
  } catch (err) {
    console.error('[/codes/consume] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Static Frontend (optional local serving) ----------
function hasIndex(dir) { try { return fs.existsSync(path.join(dir, 'index.html')); } catch { return false; } }
const distDir = WEB_DIST_DIR;
const distHasIndex = hasIndex(distDir);

if (distHasIndex) {
  app.use('/assets', express.static(path.join(distDir, 'assets'), { fallthrough: true, index: false, maxAge: '1h' }));
  app.use('/app/assets', express.static(path.join(distDir, 'assets'), { fallthrough: true, index: false, maxAge: '1h' }));
}

app.get('/', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) { console.error('[static /] index error:', err?.message || err); res.status(404).send(`Error: index.html not found at '${indexPath}'`); }
  });
});

app.get('/app', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) { console.error('[static /app] index error:', err?.message || err); res.status(404).send(`Error: index.html not found at '${indexPath}'`); }
  });
});

if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) { console.error('[static fallback /app/*] error:', err?.message || err); res.status(404).send(`Error: index.html not found at '${indexPath}'`); }
    });
  });

  app.get(/^\/(?!api|health|version|rooms|codes|assets|presenter).*/, (_req, res, next) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) { console.error('[static fallback /*] error:', err?.message || err); next(); }
    });
  });
}

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(`[env] endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`);
  console.log(`[env] CORS_ORIGINS=${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'}`);
  console.log(`[env] SPA=${ENABLE_SPA} dist=${distDir} present=${distHasIndex}`);
});
