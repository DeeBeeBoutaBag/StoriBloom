try {
  await import('dotenv/config');
} catch (err) {
  console.warn('[dotenv] not loaded (probably running on AWS with real env vars):', err?.message || err);
}
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Optional deps
let compression = null;
let morgan = null;
try { ({ default: compression } = await import('compression')); } catch {}
try { ({ default: morgan } = await import('morgan')); } catch {}

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import { getOpenAI } from './openaiClient.js';
import { Asema } from './asemaPersona.js';
import { createStageEngine } from './stageEngine.js';

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 8080);
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const AWS_DYNAMO_ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TABLES = {
  codes: process.env.DDB_TABLE_CODES || process.env.TABLE_CODES || 'storibloom_codes',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  personas: process.env.DDB_TABLE_PERSONAS || 'storibloom_personas',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
};

const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const ENABLE_SPA = String(process.env.STATIC_INDEX || '0') === '1';

// ---------- AWS ----------
const ddb = new DynamoDBClient({
  region: AWS_REGION,
  ...(AWS_DYNAMO_ENDPOINT ? { endpoint: AWS_DYNAMO_ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

// Log AWS + OpenAI
(async () => {
  try {
    const creds = await ddb.config.credentials();
    if (creds?.accessKeyId) console.log('[aws] credentials resolved');
    else console.warn('[aws] credentials not resolved');
  } catch (e) {
    console.warn('[aws] credentials error:', e?.message || e);
  }

  try {
    getOpenAI();
    console.log('[openai] enabled');
  } catch (e) {
    console.warn('[openai] disabled:', e?.message || e);
  }

  console.log('[env] tables', TABLES);
})();

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// CORS
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

app.use(express.json({ limit: '1mb' }));
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Auth ----------
function handleGuestAuth(_req, res) {
  try {
    const id = crypto.randomUUID();
    const token = `guest-${id}`;
    res.json({ token, userId: id });
  } catch (e) {
    console.error('[auth/guest] error', e);
    res.status(500).json({ error: 'guest auth failed' });
  }
}
app.post('/auth/guest', handleGuestAuth);
app.post('/api/auth/guest', handleGuestAuth);

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token?.startsWith('guest-')) {
      return res.status(401).json({ error: 'Missing or invalid token' });
    }
    const uid = token.replace('guest-', '');
    if (!uid) return res.status(401).json({ error: 'Invalid uid' });
    req.user = { uid };
    req.userToken = token;
    next();
  } catch (err) {
    console.error('[requireAuth] error', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ---------- Helpers ----------
const DEFAULT_STAGE = 'LOBBY';
const ROOM_ORDER = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
];

// Align durations more closely with UI (Room.jsx TOTAL_BY_STAGE)
const STAGE_DURATIONS = {
  LOBBY: 10 * 60_000,       // 10 min
  DISCOVERY: 10 * 60_000,   // 10 min
  IDEA_DUMP: 3 * 60_000,    // 3 min
  PLANNING: 10 * 60_000,    // 10 min
  ROUGH_DRAFT: 4 * 60_000,  // 4 min
  EDITING: 10 * 60_000,     // 10 min
  FINAL: 6 * 60_000,        // 6 min
};
function getStageDuration(stage) {
  return STAGE_DURATIONS[stage] || 6 * 60_000;
}

function parseRoomId(roomId) {
  const [siteId, idxStr] = String(roomId).split('-');
  return { siteId: (siteId || 'E1').toUpperCase(), index: Number(idxStr || 1) };
}

function advanceStageVal(stage) {
  const i = ROOM_ORDER.indexOf(stage || DEFAULT_STAGE);
  return i >= 0 && i < ROOM_ORDER.length - 1
    ? ROOM_ORDER[i + 1]
    : (stage || DEFAULT_STAGE);
}

async function getRoom(roomId) {
  const { Item } = await ddbDoc.send(
    new GetCommand({ TableName: TABLES.rooms, Key: { roomId } })
  );
  return Item || null;
}

async function ensureRoom(roomId) {
  let r = await getRoom(roomId);
  if (r) {
    if (!Array.isArray(r.seats)) r.seats = []; // ensure seats exists
    return r;
  }

  const { siteId, index } = parseRoomId(roomId);
  r = {
    roomId,
    siteId,
    index,
    stage: DEFAULT_STAGE,
    stageEndsAt: Date.now() + getStageDuration('LOBBY'),
    inputLocked: false,
    topic: '',
    ideaSummary: '',
    voteOpen: false,
    voteTotal: 0,
    voteTallies: {},
    greetedForStage: {},
    seats: [], // track occupancy

    // NEW: final-stage tracking
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,

    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await ddbDoc.send(
    new PutCommand({ TableName: TABLES.rooms, Item: r })
  );
  return r;
}

async function updateRoom(roomId, patch) {
  const next = {
    ...(await getRoom(roomId)) || {},
    roomId,
    ...patch,
    updatedAt: Date.now(),
  };
  if (!Array.isArray(next.seats)) next.seats = [];
  await ddbDoc.send(
    new PutCommand({ TableName: TABLES.rooms, Item: next })
  );
  stageEngine.touch(roomId);
  return next;
}

async function addMessage(
  roomId,
  {
    text,
    phase,
    authorType = 'user',
    personaIndex = 0,
    uid = null,
    emoji = null,
  }
) {
  const createdAt = Date.now();
  await ddbDoc.send(
    new PutCommand({
      TableName: TABLES.messages,
      Item: {
        roomId,
        createdAt,
        uid: uid || '(system)',
        personaIndex,
        emoji: emoji || null,
        authorType,
        phase: phase || 'LOBBY',
        text,
      },
    })
  );
  stageEngine.touch(roomId);
  return { createdAt };
}

async function getMessagesForRoom(roomId, limit = 200) {
  const { Items } = await ddbDoc.send(
    new QueryCommand({
      TableName: TABLES.messages,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': roomId },
      ScanIndexForward: true,
      Limit: Math.min(500, limit),
    })
  );
  return Items || [];
}

// Draft helpers
async function getLatestDraft(roomId) {
  const { Items } = await ddbDoc.send(
    new QueryCommand({
      TableName: TABLES.drafts,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': roomId },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  return (Items && Items[0]) || null;
}

async function generateRoughDraftForRoom(room, { force = false } = {}) {
  if (!force) {
    const existing = await getLatestDraft(room.roomId);
    if (existing) return existing;
  }

  try {
    const text = await Asema.generateRoughDraft(
      room.topic || '',
      room.ideaSummary || '',
      room.roomId
    );
    const draft = (text || '').trim();
    const createdAt = Date.now();

    const prev = await getLatestDraft(room.roomId);

    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.drafts,
        Item: {
          roomId: room.roomId,
          createdAt,
          content: draft,
          version: prev ? (prev.version || 1) + 1 : 1,
        },
      })
    );

    await addMessage(room.roomId, {
      text: draft,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
    });

    console.log(
      `[rough] generated for ${room.roomId}, ~${draft.split(/\s+/).length} words`
    );
    return { roomId: room.roomId, createdAt, content: draft };
  } catch (e) {
    console.error('[rough] generation failed:', e?.message || e);
    const fallback =
      'Draft unavailable due to an AI error. Continue discussing your 250-word abstract together.';
    const createdAt = Date.now();

    const prev = await getLatestDraft(room.roomId);

    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.drafts,
        Item: {
          roomId: room.roomId,
          createdAt,
          content: fallback,
          version: prev ? (prev.version || 1) + 1 : 1,
        },
      })
    );
    await addMessage(room.roomId, {
      text: fallback,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
    });

    return { roomId: room.roomId, createdAt, content: fallback };
  }
}

// ---------- Room Assignment (6 per room, up to 5 rooms) ----------
async function assignRoomForUser(siteIdRaw, uid) {
  const siteId = String(siteIdRaw || '').trim().toUpperCase();
  if (!siteId) throw new Error('siteId required');

  const MAX_ROOMS = 5;
  const MAX_SEATS = 6;

  const rooms = [];

  // Ensure rooms, normalize seats, and check if already assigned
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const roomId = `${siteId}-${i}`;
    let r = await ensureRoom(roomId);

    let seats = Array.isArray(r.seats) ? r.seats.filter((s) => s && s.uid) : [];
    const seen = new Set();
    seats = seats.filter((s) => {
      if (!s.uid || seen.has(s.uid)) return false;
      seen.add(s.uid);
      return true;
    });

    // Already seated in this room
    if (seats.some((s) => s.uid === uid)) {
      if (seats.length !== (r.seats || []).length) {
        r = await updateRoom(roomId, { seats });
      }
      return {
        roomId,
        index: r.index,
        siteId,
        seats: seats.length,
      };
    }

    // Persist cleaned seats if changed
    if (seats.length !== (r.seats || []).length) {
      r = await updateRoom(roomId, { seats });
    }

    rooms.push({ roomId, index: r.index, seats });
  }

  // Pick first room with < 6 seats, else last room as overflow
  let target = rooms.find((r) => r.seats.length < MAX_SEATS);
  if (!target) {
    target = rooms[rooms.length - 1];
  }

  const newSeats = [...target.seats, { uid }];
  await updateRoom(target.roomId, { seats: newSeats });

  return {
    roomId: target.roomId,
    index: target.index,
    siteId,
    seats: newSeats.length,
  };
}

app.post('/rooms/assign', requireAuth, async (req, res) => {
  try {
    const { siteId } = req.body || {};
    if (!siteId) {
      return res.status(400).json({ error: 'siteId required' });
    }
    const assigned = await assignRoomForUser(siteId, req.user.uid);
    return res.json(assigned);
  } catch (e) {
    console.error('[/rooms/assign] error', e);
    return res.status(500).json({ error: 'assign_failed' });
  }
});

// ---------- Stage Engine ----------
const stageEngine = createStageEngine({
  getRoom,
  updateRoom,
  advanceStageVal,
  onStageAdvanced: async (room) => {
    try {
      const stage = room.stage || 'LOBBY';

      // 1) Always drop a short nudge from Asema on stage change
      await addMessage(room.roomId, {
        text: `⏱️ Moving into **${stage}**. Keep building together and call on me when you’re ready.`,
        phase: stage,
        authorType: 'asema',
        personaIndex: 0,
      });

      // 2) Special handling for EDITING:
      //    - Re-post the latest rough draft into this stage so people can edit it in context.
      if (stage === 'EDITING') {
        try {
          const latestDraft = await getLatestDraft(room.roomId);
          if (latestDraft && latestDraft.content) {
            // Small intro line so they know what it is
            await addMessage(room.roomId, {
              text: '✂️ Here’s your rough draft again — copy lines, rewrite them, and ask me for tighter versions.',
              phase: 'EDITING',
              authorType: 'asema',
              personaIndex: 0,
            });

            // The actual draft text as the main editing reference
            await addMessage(room.roomId, {
              text: latestDraft.content,
              phase: 'EDITING',
              authorType: 'asema',
              personaIndex: 0,
            });
          } else {
            // No saved draft (edge case)
            await addMessage(room.roomId, {
              text: 'I don’t see a rough draft saved yet — generate one in the ROUGH_DRAFT stage first, then we’ll polish it here.',
              phase: 'EDITING',
              authorType: 'asema',
              personaIndex: 0,
            });
          }
        } catch (err) {
          console.error('[stageEngine EDITING] failed to load draft', err);
        }
      }

      // 3) Reset greetedForStage so the /welcome endpoint
      //    can give a fresh, stage-specific greeting if called.
      const greeted = { ...(room.greetedForStage || {}) };
      greeted[stage] = false;
      await updateRoom(room.roomId, { greetedForStage: greeted });
    } catch (e) {
      console.error('[stageEngine onStageAdvanced] error', e);
    }
  },
});
stageEngine.start();


// ---------- Health ----------
app.get('/health', (_req, res) =>
  res.json({ ok: true, region: AWS_REGION, time: new Date().toISOString() })
);
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, region: AWS_REGION, time: new Date().toISOString() })
);
app.get('/version', (_req, res) =>
  res.json({
    commit: process.env.GIT_COMMIT || null,
    build: process.env.BUILD_ID || null,
    time: new Date().toISOString(),
  })
);

// ---------- Presenter: list rooms ----------
app.get('/presenter/rooms', requireAuth, async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) return res.json({ rooms: [] });

  const out = [];
  const MAX_ROOMS = 5;
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const id = `${siteId}-${i}`;
    const r = await ensureRoom(id);
    out.push({
      id: r.roomId,
      index: r.index,
      stage: r.stage,
      inputLocked: !!r.inputLocked,
      topic: r.topic || '',
      seats: Array.isArray(r.seats) ? r.seats.length : 0,
      vote: {
        open: !!r.voteOpen,
        total: Number(r.voteTotal || 0),
        tallies: r.voteTallies || {},
      },
    });
    stageEngine.touch(id);
  }
  res.json({ rooms: out });
});

// ---------- Room state & messages ----------
app.get('/rooms/:roomId/state', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  let r = await ensureRoom(roomId);
  const now = Date.now();

  const toMs = (val) => {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };

  let stage = r.stage || 'LOBBY';
  let endsAtMs = toMs(r.stageEndsAt);

  if (stage === 'LOBBY' && !endsAtMs) {
    endsAtMs = now + getStageDuration('LOBBY');
    r = await updateRoom(roomId, {
      stage: 'LOBBY',
      stageEndsAt: endsAtMs,
    });
    stage = r.stage || 'LOBBY';
  }

  stageEngine.touch(roomId);

  res.json({
    id: r.roomId,
    siteId: r.siteId,
    index: r.index,
    stage,
    stageEndsAt: endsAtMs,
    inputLocked: !!r.inputLocked,
    topic: r.topic || '',
    ideaSummary: r.ideaSummary || '',

    // NEW
    seats: Array.isArray(r.seats) ? r.seats.length : 0,
    finalReadyCount: Number(r.finalReadyCount || 0),
    finalCompletedAt: r.finalCompletedAt || null,
  });
});


app.post('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { text, phase, personaIndex = 0, emoji } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  const r = await ensureRoom(roomId);

  // Keep ROUGH_DRAFT open; respect lock elsewhere except FINAL
  if (
    r.inputLocked &&
    (r.stage || 'LOBBY') !== 'FINAL' &&
    r.stage !== 'ROUGH_DRAFT'
  ) {
    return res.status(403).json({ error: 'input_locked' });
  }

  const saved = await addMessage(roomId, {
    text,
    phase: phase || r.stage || 'LOBBY',
    authorType: 'user',
    personaIndex,
    uid: req.user.uid,
    emoji: emoji || null,
  });

  res.json({ ok: true, createdAt: saved.createdAt });
});

app.get('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const limit = Math.min(200, Number(req.query.limit || 100));
  const items = await getMessagesForRoom(roomId, limit);
  stageEngine.touch(roomId);
  res.json({ messages: items });
});

// ---------- Stage controls ----------
app.post('/rooms/:roomId/next', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const cur = await ensureRoom(roomId);
  const nextStage = advanceStageVal(cur.stage);
  const dur = getStageDuration(nextStage);
  const updated = await updateRoom(roomId, {
    stage: nextStage,
    stageEndsAt: Date.now() + dur,
  });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/extend', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const by = Math.max(1, Number((req.body && req.body.by) || 120));
  const cur = await ensureRoom(roomId);
  const updated = await updateRoom(roomId, {
    stageEndsAt: (cur.stageEndsAt || Date.now()) + by * 1000,
  });
  res.json({ ok: true, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const updated = await updateRoom(roomId, {
    stage: 'ROUGH_DRAFT',
    stageEndsAt: Date.now() + 10 * 60_000,
    inputLocked: false,
  });
  res.json({
    ok: true,
    stage: updated.stage,
    stageEndsAt: updated.stageEndsAt,
  });
});

app.post('/rooms/:roomId/lock', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const inputLocked = !!(req.body && req.body.inputLocked);
  const updated = await updateRoom(roomId, { inputLocked });
  res.json({ ok: true, inputLocked: !!updated.inputLocked });
});

// ---------- Voting ----------
// Default set of issues (shared with UI conceptually)
const ISSUE_MAP = {
  1: 'Law Enforcement Profiling',
  2: 'Food Deserts',
  3: 'Red Lining',
  4: 'Homelessness',
  5: 'Wealth Gap',
};

app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  const r = await ensureRoom(req.params.roomId);
  stageEngine.touch(r.roomId);

  const tallies = r.voteTallies || {};
  const optionEntries = Object.entries(ISSUE_MAP).map(([num, label]) => ({
    num: Number(num),
    label,
  }));
  const counts = optionEntries.map(({ num }) =>
    Number.isFinite(Number(tallies[num]))
      ? Number(tallies[num])
      : 0
  );

  const votesReceived = counts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  res.json({
    votingOpen: !!r.voteOpen,
    options: optionEntries,
    votesReceived,
    counts,
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
  if (typeof choice !== 'number') {
    return res.status(400).json({ error: 'choice must be a number' });
  }
  const r = await ensureRoom(roomId);
  if (!r.voteOpen) return res.status(400).json({ error: 'voting_closed' });

  const tallies = { ...(r.voteTallies || {}) };
  const key = Number(choice);
  tallies[key] = (tallies[key] || 0) + 1;

  await updateRoom(roomId, {
    voteTallies: tallies,
    voteTotal: Number(r.voteTotal || 0) + 1,
  });
  res.json({ ok: true });
});

app.post('/rooms/:roomId/vote/close', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const r = await ensureRoom(roomId);
  const tallies = r.voteTallies || {};
  let topic = r.topic || '';

  const entries = Object.entries(tallies);
  if (entries.length) {
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
    const [winningNum] = entries[0];
    const label = ISSUE_MAP[Number(winningNum)];
    topic = label || `#${winningNum}`;
  }

  await updateRoom(roomId, { voteOpen: false, topic });
  res.json({ ok: true, closed: true, topic });
});

// ---------- Idea summarization (Discovery + Idea Dump + Planning) ----------
// Throttle summaries so OpenAI isn't hammered when lots of people type.
const IDEA_MIN_INTERVAL_MS = 20_000; // 20s per room
const ideaLastRun = new Map(); // roomId -> timestamp

function shouldRunIdeaSummary(roomId) {
  const now = Date.now();
  const last = ideaLastRun.get(roomId) || 0;
  if (now - last < IDEA_MIN_INTERVAL_MS) return false;
  ideaLastRun.set(roomId, now);
  return true;
}

async function summarizeIdeas(roomId) {
  const r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';
  if (!['DISCOVERY', 'IDEA_DUMP', 'PLANNING'].includes(stage)) return;

  const all = await getMessagesForRoom(roomId, 800);
  const phases = ['DISCOVERY', 'IDEA_DUMP', 'PLANNING'];
  const humanLines = all
    .filter(
      (m) =>
        phases.includes(m.phase || '') &&
        (m.authorType || 'user') === 'user'
    )
    .map((m) => m.text);

  if (humanLines.length === 0) {
    await updateRoom(roomId, {
      ideaSummary: '',
      lastIdeaSummaryAt: Date.now(),
    });
    return;
  }

  try {
    const summary = await Asema.summarizeIdeas(
      stage,
      r.topic || '',
      humanLines
    );
    await updateRoom(roomId, {
      ideaSummary: summary,
      lastIdeaSummaryAt: Date.now(),
    });
  } catch (e) {
    console.error('[ideas] summarize failed', e?.message || e);
  }
}

app.post('/rooms/:roomId/ideas/trigger', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  try {
    if (shouldRunIdeaSummary(roomId)) {
      await summarizeIdeas(roomId);
      return res.json({ ok: true, ran: true });
    }
    return res.json({ ok: true, skipped: true });
  } catch (e) {
    console.error('[ideas/trigger] error', e);
    return res.status(500).json({ error: 'summarize_failed' });
  }
});

// ---------- AI Greeting & Ask ----------
// Ask throttle so one excited teen can't spam your OpenAI key
const ASK_MIN_INTERVAL_MS = 4_000; // 4s per room
const askLastRun = new Map(); // roomId -> timestamp

function shouldRunAsk(roomId) {
  const now = Date.now();
  const last = askLastRun.get(roomId) || 0;
  if (now - last < ASK_MIN_INTERVAL_MS) return false;
  askLastRun.set(roomId, now);
  return true;
}

app.post('/rooms/:roomId/welcome', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';
  const greeted = r.greetedForStage || {};
  if (greeted[stage]) return res.json({ ok: true, skipped: true });

  try {
    const text = await Asema.greet(stage, r.topic || '');
    await addMessage(roomId, {
      text,
      phase: stage,
      authorType: 'asema',
    });
    greeted[stage] = true;
    await updateRoom(roomId, { greetedForStage: greeted });
    res.json({ ok: true });
  } catch (e) {
    console.error('[welcome] error', e);
    res.json({ ok: true, fallback: true });
  }
});

app.post('/rooms/:roomId/ask', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  let r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';

  // Capture topic utterances
  const extracted = Asema.extractTopicFromUtterance(text);
  if (extracted) {
    await updateRoom(roomId, { topic: extracted });
    r = await ensureRoom(roomId);
  }

  // Throttle actual OpenAI calls per room; still respond with a small hint
  if (!shouldRunAsk(roomId)) {
    await addMessage(roomId, {
      text:
        'I’m catching up on a few questions — give the room a few seconds before calling on me again.',
      phase: stage,
      authorType: 'asema',
    });
    return res.json({ ok: true, throttled: true });
  }

  try {
    const reply = await Asema.replyToUser(stage, r.topic || '', text);
    await addMessage(roomId, {
      text: reply,
      phase: stage,
      authorType: 'asema',
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[ask] error', e);
    const fallback =
      'Nice direction — now anchor it with one clear character, place, and problem.';
    await addMessage(roomId, {
      text: fallback,
      phase: stage,
      authorType: 'asema',
    });
    res.json({ ok: true, fallback: true });
  }
});

// ---------- Draft / Final ----------
app.post('/rooms/:roomId/draft/generate', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { mode } = req.body || {};
  try {
    const room = await ensureRoom(roomId);
    if ((room.stage || 'LOBBY') !== 'ROUGH_DRAFT') {
      return res
        .status(400)
        .json({ error: 'wrong_stage', stage: room.stage });
    }

    const force =
      mode === 'regen' ||
      mode === 'regenerate' ||
      mode === 'ask';

    const draft = await generateRoughDraftForRoom(room, { force });
    res.json({ ok: true, ...draft });
  } catch (e) {
    console.error('[draft/generate] error', e);
    res.status(500).json({ error: 'draft_failed' });
  }
});

app.post('/rooms/:roomId/final/start', requireAuth, async (_req, res) =>
  res.json({ ok: true })
);
app.post('/rooms/:roomId/final/complete', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;

  try {
    const room = await ensureRoom(roomId);
    const stage = room.stage || 'LOBBY';
    if (stage !== 'FINAL') {
      return res
        .status(400)
        .json({ error: 'wrong_stage', stage });
    }

    // How many people clicked "done" vs total seats
    const readyCount = Number(room.finalReadyCount || 0);
    const seats = Array.isArray(room.seats) ? room.seats.length : 0;

    // 1) Try to get the latest rough draft as base text
    const latestDraft = await getLatestDraft(roomId);
    const baseDraft = latestDraft && latestDraft.content ? latestDraft.content.trim() : '';

    // 2) Drop a closing ceremony message from Asema
    const closingLines = [];
    closingLines.push('🏁 **Session complete.** Beautiful work, team.');
    if (seats > 0) {
      closingLines.push(
        `**${readyCount} / ${seats}** teammates clicked **done** — that’s your consensus on this abstract.`
      );
    }
    if (room.topic) {
      closingLines.push(`We just wrapped a story on **${room.topic}**.`);
    }
    closingLines.push(
      'You can screenshot or copy your final abstract below, and keep this as a seed for a full piece or performance.'
    );

    await addMessage(roomId, {
      text: closingLines.join(' '),
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });

    // 3) Re-post the final abstract clearly labeled
    if (baseDraft) {
      await addMessage(roomId, {
        text: `**Final Abstract**\n\n${baseDraft}`,
        phase: 'FINAL',
        authorType: 'asema',
        personaIndex: 0,
      });
    } else {
      await addMessage(roomId, {
        text: 'I don’t see a saved rough draft — your chat log is still full of good material. Copy what you like and keep building it offline.',
        phase: 'FINAL',
        authorType: 'asema',
        personaIndex: 0,
      });
    }

    // 4) Lock and close the room
    const finalCompletedAt = Date.now();
    const updated = await updateRoom(roomId, {
      stage: 'CLOSED',
      inputLocked: true,
      finalCompletedAt,
    });

    return res.json({
      ok: true,
      closed: true,
      stage: updated.stage,
      finalCompletedAt,
      readyCount,
      seats,
    });
  } catch (e) {
    console.error('[final/complete] error', e);
    return res.status(500).json({ error: 'final_complete_failed' });
  }
});


// Mark a participant as "ready" in FINAL stage (called when they type "done"/"submit")
app.post('/rooms/:roomId/final/ready', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = req.user?.uid;
  if (!uid) {
    return res.status(401).json({ error: 'no_uid' });
  }

  const r = await ensureRoom(roomId);
  const stage = r.stage || 'LOBBY';
  if (stage !== 'FINAL') {
    return res.status(400).json({ error: 'wrong_stage', stage });
  }

  let readyUids = Array.isArray(r.finalReadyUids) ? r.finalReadyUids.slice() : [];
  if (!readyUids.includes(uid)) {
    readyUids.push(uid);
  }

  const updated = await updateRoom(roomId, {
    finalReadyUids: readyUids,
    finalReadyCount: readyUids.length,
  });

  const seats = Array.isArray(updated.seats) ? updated.seats.length : 0;

  return res.json({
    ok: true,
    readyCount: updated.finalReadyCount || 0,
    seats,
  });
});


// ---------- Codes: consume ----------
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }

    const getRes = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.codes,
        Key: { code: code.trim() },
      })
    );
    const item = getRes.Item;
    if (!item) {
      return res.status(404).json({ error: 'Code not found or invalid' });
    }

    try {
      await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.codes,
          Key: { code: item.code },
          UpdateExpression:
            'SET consumed = :c, usedBy = :u, consumedAt = :t',
          ExpressionAttributeValues: {
            ':c': true,
            ':u': req.user.uid || '(unknown)',
            ':t': Date.now(),
          },
        })
      );
    } catch (e) {
      console.warn('[codes/consume] update skipped:', e?.message || e);
    }

    const siteId = (item.siteId || 'E1').toUpperCase();
    const MAX_ROOMS = 5;
    for (let i = 1; i <= MAX_ROOMS; i++) {
      const rid = `${siteId}-${i}`;
      await ensureRoom(rid);
      stageEngine.touch(rid);
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

// ---------- Static (optional SPA) ----------
function hasIndex(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}
const distDir = WEB_DIST_DIR;
const distHasIndex = hasIndex(distDir);

if (distHasIndex) {
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
  app.use(
    '/app/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
}

app.get('/', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /] index error', err);
      res
        .status(404)
        .send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

app.get('/app', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /app] index error', err);
      res
        .status(404)
        .send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[static fallback /app/*] error', err);
        res
          .status(404)
          .send(`Error: index.html not found at '${indexPath}'`);
      }
    });
  });

  app.get(
    /^\/(?!api|health|version|rooms|codes|assets|presenter).*/,
    (_req, res, next) => {
      const indexPath = path.join(distDir, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error('[static fallback /*] error', err);
          next();
        }
      });
    }
  );
}

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------- 404 & Error handlers ----------
app.use((req, res) =>
  res
    .status(404)
    .json({ error: 'Not found', path: req.path, method: req.method })
);

app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(
    `[env] endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`
  );
  console.log(
    `[env] CORS_ORIGINS=${
      CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'
    }`
  );
  console.log(
    `[env] SPA=${ENABLE_SPA} dist=${WEB_DIST_DIR} present=${distHasIndex}`
  );
});
