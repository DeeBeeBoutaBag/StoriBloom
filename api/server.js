// server.js (FULL FILE — NO OMISSIONS)

try {
  await import('dotenv/config');
} catch (err) {
  console.warn(
    '[dotenv] not loaded (probably running on AWS with real env vars):',
    err?.message || err
  );
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
try {
  ({ default: compression } = await import('compression'));
} catch {}
try {
  ({ default: morgan } = await import('morgan'));
} catch {}

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
  codes:
    process.env.DDB_TABLE_CODES ||
    process.env.TABLE_CODES ||
    'storibloom_codes',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  personas: process.env.DDB_TABLE_PERSONAS || 'storibloom_personas',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',

  // Optional gallery table (if not provisioned, gallery endpoint falls back to room records)
  gallery: process.env.DDB_TABLE_GALLERY || 'storibloom_gallery',
};

const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const ENABLE_SPA = String(process.env.STATIC_INDEX || '0') === '1';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-user-role'],
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );
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

// Presenter gating (front-end should pass x-user-role: PRESENTER)
function isPresenterReq(req) {
  const h = String(req.headers['x-user-role'] || '').trim().toUpperCase();
  return h === 'PRESENTER';
}
function requirePresenter(req, res, next) {
  if (!isPresenterReq(req)) {
    return res.status(403).json({ error: 'presenter_only' });
  }
  return next();
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

// Align durations with UI (Room.jsx TOTAL_BY_STAGE) — milliseconds
const STAGE_DURATIONS = {
  LOBBY: 1200 * 1000, // 10 min (adjust if desired)
  DISCOVERY: 600 * 1000, // 10 min
  IDEA_DUMP: 600 * 1000, // 10 min
  PLANNING: 600 * 1000, // 10 min
  ROUGH_DRAFT: 240 * 1000, // 4 min
  EDITING: 600 * 1000, // 10 min
  FINAL: 360 * 1000, // 6 min
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
    : stage || DEFAULT_STAGE;
}

function getSeatCount(room) {
  return Array.isArray(room.seats) ? room.seats.length : 0;
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
    if (!Array.isArray(r.seats)) r.seats = [];

    // Living draft defaults
    if (typeof r.draftText !== 'string') r.draftText = '';
    if (!Number.isFinite(Number(r.draftVersion))) r.draftVersion = 0;
    if (!r.draftUpdatedAt) r.draftUpdatedAt = null;

    // Final / gallery defaults
    if (typeof r.finalAbstract !== 'string') r.finalAbstract = '';
    if (!r.closedReason) r.closedReason = null;
    if (!r.closedAt) r.closedAt = null;

    // FINAL readiness defaults
    if (!Array.isArray(r.finalReadyUids)) r.finalReadyUids = [];
    if (!Number.isFinite(Number(r.finalReadyCount))) r.finalReadyCount = 0;

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
    seats: [],

    // voting readiness + submitted tracking
    voteReadyUids: [],
    voteReadyCount: 0,
    voteSubmittedUids: [],
    voteSubmittedCount: 0,

    // final-stage tracking
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,

    // NEW: living draft (single source of truth)
    draftText: '',
    draftVersion: 0,
    draftUpdatedAt: null,

    // NEW: closure/gallery
    finalAbstract: '',
    closedReason: null,
    closedAt: null,

    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await ddbDoc.send(new PutCommand({ TableName: TABLES.rooms, Item: r }));
  return r;
}

async function updateRoom(roomId, patch) {
  const next = {
    ...((await getRoom(roomId)) || {}),
    roomId,
    ...patch,
    updatedAt: Date.now(),
  };
  if (!Array.isArray(next.seats)) next.seats = [];
  if (typeof next.draftText !== 'string') next.draftText = '';
  if (!Number.isFinite(Number(next.draftVersion))) next.draftVersion = 0;
  if (!Array.isArray(next.finalReadyUids)) next.finalReadyUids = [];
  if (!Number.isFinite(Number(next.finalReadyCount))) next.finalReadyCount = 0;

  await ddbDoc.send(new PutCommand({ TableName: TABLES.rooms, Item: next }));
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
      Limit: Math.min(800, limit),
    })
  );
  return Items || [];
}

// ---------- Stage Instructions ----------
function stageInstructionText(stage) {
  switch (stage) {
    case 'LOBBY':
      return [
        '👋 **LOBBY (Orientation)**',
        '• Pick your emoji persona (top-right).',
        '• Send one test message: “Hello + one sentence about your day.”',
        '• To ask me for help, start with: **Asema, ...**',
      ].join('\n');

    case 'DISCOVERY':
      return [
        '🧭 **DISCOVERY**',
        '• Share a short story, memory, or observation about the issue.',
        '• When you feel ready, click **I’m ready to vote**.',
        '• Ask me: “Asema, ask us 3 deeper questions.”',
      ].join('\n');

    case 'IDEA_DUMP':
      return [
        '⚡ **IDEA DUMP**',
        '• Drop fast bullets: characters, setting, conflict, turning point, what changes.',
        '• Volume > perfection. No debating yet.',
      ].join('\n');

    case 'PLANNING':
      return [
        '🧩 **PLANNING**',
        '• Use the Planning Board to choose 1 focus + 1 structure + 3 key beats.',
        '• Click **Share plan with room** when it’s solid.',
      ].join('\n');

    case 'ROUGH_DRAFT':
      return [
        '📝 **ROUGH DRAFT**',
        '• Click **Generate Rough Draft** (or say: “Asema, generate rough draft”).',
        '• This becomes your living draft we will edit — not a one-off.',
      ].join('\n');

    case 'EDITING':
      return [
        '✂️ **EDITING**',
        '• Give edit instructions like: “Replace the first sentence with…”',
        '• Say “show what we have so far” anytime to see the latest version.',
        '• I will apply edits to the SAME draft (versioned).',
      ].join('\n');

    case 'FINAL':
      return [
        '🏁 **FINAL**',
        '• I’ll paste the latest draft. Make final tiny changes (clarity, punch, ending).',
        '• When YOU are finished, type **done** (or **submit**).',
        '• When time runs out, I’ll close automatically and post the final abstract.',
      ].join('\n');

    case 'CLOSED':
      return [
        '🔒 **CLOSED**',
        '• Session is read-only now. Copy/screenshot the final abstract above.',
      ].join('\n');

    default:
      return `⏱️ Moving into **${stage}**.`;
  }
}

// ---------- Draft helpers (legacy drafts table kept as audit trail) ----------
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

async function saveDraftSnapshot(roomId, content, version) {
  const createdAt = Date.now();
  await ddbDoc.send(
    new PutCommand({
      TableName: TABLES.drafts,
      Item: {
        roomId,
        createdAt,
        content: (content || '').trim(),
        version: Number(version || 1),
      },
    })
  );
  return { createdAt };
}

async function generateRoughDraftForRoom(room, { force = false } = {}) {
  // NEW: generate into living draft (draftText); regen overwrites with new version
  if (!force && room.draftText && room.draftText.trim()) {
    return {
      roomId: room.roomId,
      createdAt: room.draftUpdatedAt || Date.now(),
      content: room.draftText,
      version: Number(room.draftVersion || 0),
      reused: true,
    };
  }

  try {
    const text = await Asema.generateRoughDraft(
      room.topic || '',
      room.ideaSummary || '',
      room.roomId
    );
    const draft = (text || '').trim();

    const nextVersion = Number(room.draftVersion || 0) + 1;
    const updated = await updateRoom(room.roomId, {
      draftText: draft,
      draftVersion: nextVersion,
      draftUpdatedAt: Date.now(),
    });

    await saveDraftSnapshot(room.roomId, draft, nextVersion);

    await addMessage(room.roomId, {
      text: `📝 **Rough Draft (v${nextVersion})**\n\n${draft}`,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
    });

    console.log(
      `[rough] generated for ${room.roomId}, ~${draft.split(/\s+/).length} words`
    );

    return {
      roomId: room.roomId,
      createdAt: updated.draftUpdatedAt,
      content: draft,
      version: nextVersion,
    };
  } catch (e) {
    console.error('[rough] generation failed:', e?.message || e);
    const fallback =
      'Draft unavailable due to an AI error. Continue discussing your 250-word abstract together.';

    const nextVersion = Number(room.draftVersion || 0) + 1;
    const updated = await updateRoom(room.roomId, {
      draftText: fallback,
      draftVersion: nextVersion,
      draftUpdatedAt: Date.now(),
    });

    await saveDraftSnapshot(room.roomId, fallback, nextVersion);

    await addMessage(room.roomId, {
      text: `📝 **Rough Draft (v${nextVersion})**\n\n${fallback}`,
      phase: 'ROUGH_DRAFT',
      authorType: 'asema',
      personaIndex: 0,
    });

    return {
      roomId: room.roomId,
      createdAt: updated.draftUpdatedAt,
      content: fallback,
      version: nextVersion,
    };
  }
}

// ---------- Editing: apply edits to the SAME living draft ----------
function clipText(s, max = 9000) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n[...clipped...]';
}

async function callOpenAIForEdit({ topic, stage, baseDraft, instructions }) {
  const client = getOpenAI();
  const sys = `
You are Asema — a warm, witty, clear workshop host helping a small group craft a ~250-word story abstract.

IMPORTANT:
- You are editing ONE existing draft.
- Preserve the same protagonist/setting/plot unless the user explicitly asks to change them.
- Do NOT generate a totally new draft.
- Keep length close to ~250 words.
- Output ONLY the updated abstract text (no headings, no bullets, no commentary).
`.trim();

  const user = `
Stage: ${stage}
Topic: ${topic || '(not locked)'}
User edit request:
${instructions}

Current draft:
${baseDraft}

Return the updated draft now.
`.trim();

  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.35,
    max_tokens: 700,
  });

  return (res.choices?.[0]?.message?.content || '').trim();
}

async function applyDraftEdits(room, instructions) {
  const baseDraft = (room.draftText || '').trim();

  const updatedText = await callOpenAIForEdit({
    topic: room.topic || '',
    stage: room.stage || 'EDITING',
    baseDraft: clipText(baseDraft || '(empty draft)', 9000),
    instructions: String(instructions || ''),
  });

  const next = (updatedText || '').trim();
  const nextVersion = Number(room.draftVersion || 0) + 1;

  const updatedRoom = await updateRoom(room.roomId, {
    draftText: next,
    draftVersion: nextVersion,
    draftUpdatedAt: Date.now(),
  });

  await saveDraftSnapshot(room.roomId, next, nextVersion);

  return { updatedRoom, draftText: next, version: nextVersion };
}

// ---------- Intent helpers ----------
function wantsShowDraft(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('show what we have') ||
    t.includes('show the draft') ||
    t.includes('show latest') ||
    t.includes('paste the draft') ||
    t.includes('what do we have so far') ||
    t.includes('latest version') ||
    t.includes('current version')
  );
}

function looksLikeEditInstruction(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const patterns = [
    'replace',
    'change',
    'rewrite',
    'revise',
    'tighten',
    'shorten',
    'expand',
    'remove',
    'cut',
    'fix',
    'edit',
    'swap',
    'update',
    'clarify',
    'make it',
    'make this',
  ];
  return patterns.some((p) => t.includes(p));
}

function isDoneWord(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === 'done' || t === 'submit';
}

// ---------- Close room + post final abstract + save to room + optional gallery ----------
async function closeRoomWithFinal(
  room,
  { reason = 'manual', closedBy = '(system)' } = {}
) {
  const roomId = room.roomId;

  // Final abstract should be the latest living draft
  const finalAbstract = (room.draftText || '').trim();

  // Closing line
  await addMessage(roomId, {
    text:
      reason === 'timeout'
        ? '⏰ **Time’s up — closing the room now.**'
        : reason === 'presenter'
        ? '🧑‍🏫 **Presenter closed the room — great work.**'
        : reason === 'all_done'
        ? '✅ **Everyone is done — locking the final abstract.**'
        : '🏁 **Room closed — beautiful work.**',
    phase: 'FINAL',
    authorType: 'asema',
    personaIndex: 0,
  });

  // Paste final abstract
  if (finalAbstract) {
    await addMessage(roomId, {
      text: `**Final Abstract**\n\n${finalAbstract}`,
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });
  } else {
    await addMessage(roomId, {
      text:
        'I don’t see a saved draft yet — copy the strongest lines from your chat and keep building offline.',
      phase: 'FINAL',
      authorType: 'asema',
      personaIndex: 0,
    });
  }

  const closedAt = Date.now();

  const updated = await updateRoom(roomId, {
    stage: 'CLOSED',
    inputLocked: true,
    finalCompletedAt: closedAt,
    finalAbstract: finalAbstract || '',
    closedReason: reason,
    closedAt,
  });

  // Optional gallery write (if table exists)
  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: TABLES.gallery,
        Item: {
          siteId: updated.siteId,
          roomId: updated.roomId,
          closedAt,
          index: updated.index,
          topic: updated.topic || '',
          abstract: updated.finalAbstract || '',
          closedBy,
        },
      })
    );
  } catch (e) {
    console.warn('[gallery] put skipped (table may not exist):', e?.message || e);
  }

  return updated;
}

// ---------- FINAL: readiness + auto-close (supports typing "done" in normal chat) ----------
async function markFinalReady(roomId, uid) {
  const r = await ensureRoom(roomId);
  if ((r.stage || 'LOBBY') !== 'FINAL') {
    return { ok: false, stage: r.stage || 'LOBBY' };
  }

  let readyUids = Array.isArray(r.finalReadyUids) ? r.finalReadyUids.slice() : [];
  if (!readyUids.includes(uid)) readyUids.push(uid);

  const updated = await updateRoom(roomId, {
    finalReadyUids: readyUids,
    finalReadyCount: readyUids.length,
  });

  const seats = getSeatCount(updated);
  const readyCount = Number(updated.finalReadyCount || 0);

  let autoClosed = false;
  if (seats > 0 && readyCount >= seats) {
    try {
      await closeRoomWithFinal(updated, { reason: 'all_done', closedBy: '(all_done)' });
      autoClosed = true;
    } catch (e) {
      console.error('[final ready] auto-close error', e);
    }
  }

  return { ok: true, readyCount, seats, autoClosed };
}

// ---------- FINAL: true auto-close even if nobody polls /state ----------
const finalCloseTimers = new Map(); // roomId -> Timeout

function scheduleFinalAutoClose(room) {
  try {
    const roomId = room.roomId;
    if (!roomId) return;

    // clear any existing timer
    const prev = finalCloseTimers.get(roomId);
    if (prev) {
      clearTimeout(prev);
      finalCloseTimers.delete(roomId);
    }

    // only schedule in FINAL
    if ((room.stage || 'LOBBY') !== 'FINAL') return;

    const endsAt = Number(room.stageEndsAt || 0);
    if (!endsAt) return;

    const delay = Math.max(0, endsAt - Date.now()) + 250;

    const t = setTimeout(async () => {
      try {
        const r = await ensureRoom(roomId);
        if ((r.stage || 'LOBBY') !== 'FINAL') return;
        if (r.stage === 'CLOSED') return;
        await closeRoomWithFinal(r, { reason: 'timeout', closedBy: '(timer)' });
      } catch (e) {
        console.error('[FINAL auto-close timer] error', e?.message || e);
      }
    }, delay);

    finalCloseTimers.set(roomId, t);
    if (typeof t.unref === 'function') t.unref();
  } catch (e) {
    console.error('[scheduleFinalAutoClose] error', e?.message || e);
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
  if (!target) target = rooms[rooms.length - 1];

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

      // 1) Always drop stage instructions on stage change
      await addMessage(room.roomId, {
        text: stageInstructionText(stage),
        phase: stage,
        authorType: 'asema',
        personaIndex: 0,
      });

      // 2) Optional deeper greet for DISCOVERY
      if (stage === 'DISCOVERY') {
        try {
          const text = await Asema.greet(stage, room.topic || '');
          await addMessage(room.roomId, {
            text,
            phase: stage,
            authorType: 'asema',
            personaIndex: 0,
          });
        } catch (gerr) {
          console.error('[stageEngine DISCOVERY greet] error', gerr);
        }
      }

      // 3) EDITING: paste the latest living draft as the base editing reference
      if (stage === 'EDITING') {
        const draft = (room.draftText || '').trim();
        if (draft) {
          await addMessage(room.roomId, {
            text: `🧾 **Latest Draft (v${Number(room.draftVersion || 0)})**\n\n${draft}`,
            phase: 'EDITING',
            authorType: 'asema',
            personaIndex: 0,
          });
        } else {
          await addMessage(room.roomId, {
            text: 'I don’t see a saved draft yet — generate one in ROUGH_DRAFT first.',
            phase: 'EDITING',
            authorType: 'asema',
            personaIndex: 0,
          });
        }
      }

      // 4) FINAL: greet + paste last edited living draft immediately
      if (stage === 'FINAL') {
        const draft = (room.draftText || '').trim();
        const v = Number(room.draftVersion || 0);

        await addMessage(room.roomId, {
          text:
            `🏁 **FINAL STAGE**\n` +
            `Make your last edits to the draft below. When YOU are finished, type **done** (or **submit**).\n\n` +
            `🧾 **Draft (v${v})**\n\n${draft || '(No draft saved yet.)'}`,
          phase: 'FINAL',
          authorType: 'asema',
          personaIndex: 0,
        });

        // Schedule true auto-close at FINAL end (even if nobody polls /state)
        scheduleFinalAutoClose(room);
      } else {
        // If we left FINAL, clear timer
        const prev = finalCloseTimers.get(room.roomId);
        if (prev) {
          clearTimeout(prev);
          finalCloseTimers.delete(room.roomId);
        }
      }
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
app.get('/presenter/rooms', requireAuth, requirePresenter, async (req, res) => {
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
      seats: getSeatCount(r),
      vote: {
        open: !!r.voteOpen,
        total: Number(r.voteTotal || 0),
        tallies: r.voteTallies || {},
      },

      // draft + final preview
      draftVersion: Number(r.draftVersion || 0),
      draftUpdatedAt: r.draftUpdatedAt || null,
      finalAbstract: r.finalAbstract || '',
      closedAt: r.closedAt || null,
      closedReason: r.closedReason || null,
    });

  }
  res.json({ rooms: out });
});

// Presenter gallery (all closed abstracts for site)
app.get('/presenter/gallery', requireAuth, requirePresenter, async (req, res) => {
  const siteId = String(req.query.siteId || '').trim().toUpperCase();
  if (!siteId) return res.json({ items: [] });

  // If TABLES.gallery exists with PK=siteId, query it; else fallback to rooms
  try {
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.gallery,
        KeyConditionExpression: 'siteId = :s',
        ExpressionAttributeValues: { ':s': siteId },
        ScanIndexForward: false,
        Limit: 50,
      })
    );
    return res.json({ items: Items || [] });
  } catch (e) {
    const items = [];
    for (let i = 1; i <= 5; i++) {
      const r = await ensureRoom(`${siteId}-${i}`);
      if (r.stage === 'CLOSED' && (r.finalAbstract || '').trim()) {
        items.push({
          siteId,
          roomId: r.roomId,
          closedAt: r.closedAt || r.finalCompletedAt || null,
          index: r.index,
          topic: r.topic || '',
          abstract: r.finalAbstract || '',
        });
      }
    }
    return res.json({ items });
  }
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
  r = await ensureRoom(roomId);

  res.json({
    id: r.roomId,
    siteId: r.siteId,
    index: r.index,
    stage: r.stage || 'LOBBY',
    stageEndsAt: toMs(r.stageEndsAt),
    inputLocked: !!r.inputLocked,
    topic: r.topic || '',
    ideaSummary: r.ideaSummary || '',

    seats: getSeatCount(r),
    finalReadyCount: Number(r.finalReadyCount || 0),
    finalCompletedAt: r.finalCompletedAt || null,

    // living draft meta + final abstract
    draftVersion: Number(r.draftVersion || 0),
    draftUpdatedAt: r.draftUpdatedAt || null,
    finalAbstract: r.finalAbstract || '',
    closedAt: r.closedAt || null,
    closedReason: r.closedReason || null,
  });
});

app.post('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { text, phase, personaIndex = 0, emoji } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  let r = await ensureRoom(roomId);

  // If user types "done/submit" during FINAL in normal chat, mark them ready
  if ((r.stage || 'LOBBY') === 'FINAL' && isDoneWord(text)) {
    // still store their message (so the room sees who’s done)
    const saved = await addMessage(roomId, {
      text,
      phase: phase || r.stage || 'FINAL',
      authorType: 'user',
      personaIndex,
      uid: req.user.uid,
      emoji: emoji || null,
    });

    const readyRes = await markFinalReady(roomId, req.user.uid);

    return res.json({
      ok: true,
      createdAt: saved.createdAt,
      finalReady: true,
      readyCount: readyRes.ok ? readyRes.readyCount : undefined,
      seats: readyRes.ok ? readyRes.seats : undefined,
      autoClosed: readyRes.ok ? readyRes.autoClosed : undefined,
    });
  }

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

  // If extending FINAL, reschedule the real auto-close timer
  if ((updated.stage || 'LOBBY') === 'FINAL') {
    scheduleFinalAutoClose(updated);
  }

  res.json({ ok: true, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const updated = await updateRoom(roomId, {
    stage: 'ROUGH_DRAFT',
    stageEndsAt: Date.now() + getStageDuration('ROUGH_DRAFT'),
    inputLocked: false,
    finalReadyUids: [],
    finalReadyCount: 0,
    finalCompletedAt: null,
    closedAt: null,
    closedReason: null,
    finalAbstract: '',
  });
  res.json({ ok: true, stage: updated.stage, stageEndsAt: updated.stageEndsAt });
});

app.post('/rooms/:roomId/lock', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const inputLocked = !!(req.body && req.body.inputLocked);
  const updated = await updateRoom(roomId, { inputLocked });
  res.json({ ok: true, inputLocked: !!updated.inputLocked });
});

// ---------- Voting ----------
const ISSUE_MAP = {
  1: 'Law Enforcement Profiling',
  2: 'Food Deserts',
  3: 'Red Lining',
  4: 'Homelessness',
  5: 'Wealth Gap',
};

app.post('/rooms/:roomId/vote/ready', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'no_uid' });

  const room = await ensureRoom(roomId);
  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY') {
    return res.status(400).json({ error: 'wrong_stage', stage });
  }

  let readyUids = Array.isArray(room.voteReadyUids)
    ? room.voteReadyUids.slice()
    : [];
  if (!readyUids.includes(uid)) {
    readyUids.push(uid);
  }

  const seats = getSeatCount(room);
  const voteReadyCount = readyUids.length;
  const threshold = seats > 0 ? Math.ceil(seats * 0.5) : 0;

  let patch = {
    voteReadyUids: readyUids,
    voteReadyCount,
  };

  if (!room.voteOpen && threshold > 0 && voteReadyCount >= threshold) {
    patch = {
      ...patch,
      voteOpen: true,
      voteTotal: 0,
      voteTallies: {},
      voteSubmittedUids: [],
      voteSubmittedCount: 0,
    };

    try {
      await addMessage(roomId, {
        text:
          '🗳️ At least half the room is ready — opening topic voting now. Pick one option that fits your story best.',
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
    } catch (e) {
      console.warn('[vote/ready] Asema announcement failed', e);
    }
  }

  const updated = await updateRoom(roomId, patch);

  return res.json({
    ok: true,
    votingOpen: !!updated.voteOpen,
    voteReadyCount: updated.voteReadyCount || 0,
    seats,
  });
});

app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  const r = await ensureRoom(req.params.roomId);
  stageEngine.touch(r.roomId);

  const tallies = r.voteTallies || {};
  const optionEntries = Object.entries(ISSUE_MAP).map(([num, label]) => ({
    num: Number(num),
    label,
  }));
  const counts = optionEntries.map(({ num }) =>
    Number.isFinite(Number(tallies[num])) ? Number(tallies[num]) : 0
  );

  const votesReceived = counts.reduce(
    (a, b) => a + (Number.isFinite(b) ? b : 0),
    0
  );

  const seats = getSeatCount(r);

  res.json({
    votingOpen: !!r.voteOpen,
    options: optionEntries,
    votesReceived,
    counts,
    topic: r.topic || '',
    voteReadyCount: Number(r.voteReadyCount || 0),
    voteSubmittedCount: Number(r.voteSubmittedCount || 0),
    seats,
  });
});

app.post('/rooms/:roomId/vote/start', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  await updateRoom(roomId, {
    voteOpen: true,
    voteTotal: 0,
    voteTallies: {},
    voteReadyUids: [],
    voteReadyCount: 0,
    voteSubmittedUids: [],
    voteSubmittedCount: 0,
  });
  res.json({ ok: true, started: true });
});

app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { choice } = req.body || {};
  const uid = req.user?.uid;

  if (typeof choice !== 'number') {
    return res.status(400).json({ error: 'choice must be a number' });
  }
  if (!uid) {
    return res.status(401).json({ error: 'no_uid' });
  }

  const r = await ensureRoom(roomId);
  if (!r.voteOpen) return res.status(400).json({ error: 'voting_closed' });

  const tallies = { ...(r.voteTallies || {}) };
  const key = Number(choice);
  tallies[key] = (tallies[key] || 0) + 1;

  let voteSubmittedUids = Array.isArray(r.voteSubmittedUids)
    ? r.voteSubmittedUids.slice()
    : [];
  if (!voteSubmittedUids.includes(uid)) {
    voteSubmittedUids.push(uid);
  }
  const voteSubmittedCount = voteSubmittedUids.length;

  const voteTotal = Number(r.voteTotal || 0) + 1;
  const seats = getSeatCount(r);

  let updated = await updateRoom(roomId, {
    voteTallies: tallies,
    voteTotal,
    voteSubmittedUids,
    voteSubmittedCount,
  });

  if (seats > 0 && voteSubmittedCount >= seats && updated.voteOpen) {
    const entries = Object.entries(tallies);
    let topic = updated.topic || '';

    if (entries.length) {
      entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
      const [winningNum] = entries[0];
      const label = ISSUE_MAP[Number(winningNum)];
      topic = label || `#${winningNum}`;
    }

    updated = await updateRoom(roomId, {
      voteOpen: false,
      topic,
    });

    try {
      await addMessage(roomId, {
        text: `🔒 Topic locked in: **${topic}** — keep everything focused around this issue as you move forward.`,
        phase: 'DISCOVERY',
        authorType: 'asema',
        personaIndex: 0,
      });
    } catch (e) {
      console.warn('[vote/submit] Asema topic announce failed', e);
    }
  }

  res.json({
    ok: true,
    voteSubmittedCount,
    seats,
    votingOpen: !!updated.voteOpen,
    topic: updated.topic || '',
  });
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
        phases.includes(m.phase || '') && (m.authorType || 'user') === 'user'
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
    const summary = await Asema.summarizeIdeas(stage, r.topic || '', humanLines);
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
const ASK_MIN_INTERVAL_MS = 4_000; // 4s per room
const askLastRun = new Map(); // roomId -> timestamp

function shouldRunAsk(roomId) {
  const now = Date.now();
  const last = askLastRun.get(roomId) || 0;
  if (now - last < ASK_MIN_INTERVAL_MS) return false;
  askLastRun.set(roomId, now);
  return true;
}

// Legacy welcome endpoint (no-op)
app.post('/rooms/:roomId/welcome', requireAuth, async (req, res) => {
  return res.json({ ok: true, disabled: true });
});

// GET current living draft
app.get('/rooms/:roomId/draft', requireAuth, async (req, res) => {
  const room = await ensureRoom(req.params.roomId);
  return res.json({
    ok: true,
    draftText: room.draftText || '',
    draftVersion: Number(room.draftVersion || 0),
    draftUpdatedAt: room.draftUpdatedAt || null,
  });
});

// Edit the living draft (EDITING / FINAL)
app.post('/rooms/:roomId/draft/edit', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { instructions } = req.body || {};
  if (!instructions || typeof instructions !== 'string') {
    return res.status(400).json({ error: 'instructions required' });
  }

  let room = await ensureRoom(roomId);
  const stage = room.stage || 'LOBBY';
  if (!['EDITING', 'FINAL'].includes(stage)) {
    return res.status(400).json({ error: 'wrong_stage', stage });
  }

  try {
    const { draftText, version } = await applyDraftEdits(room, instructions);

    await addMessage(roomId, {
      text: `✅ **Updated Draft (v${version})**\n\n${draftText}`,
      phase: stage,
      authorType: 'asema',
      personaIndex: 0,
    });

    return res.json({ ok: true, version });
  } catch (e) {
    console.error('[draft/edit] error', e?.message || e);
    return res.status(500).json({ error: 'edit_failed' });
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

  // If user asks to show latest draft, paste current living draft
  if (wantsShowDraft(text)) {
    const d = (r.draftText || '').trim();
    if (d) {
      await addMessage(roomId, {
        text: `🧾 **Latest Draft (v${Number(r.draftVersion || 0)})**\n\n${d}`,
        phase: stage,
        authorType: 'asema',
      });
    } else {
      await addMessage(roomId, {
        text: 'I don’t see a saved draft yet. Generate one in ROUGH_DRAFT first.',
        phase: stage,
        authorType: 'asema',
      });
    }
    return res.json({ ok: true, showedDraft: true });
  }

  // In EDITING/FINAL, treat edit-like messages as edit instructions (edits SAME draft)
  if (
    (stage === 'EDITING' || stage === 'FINAL') &&
    looksLikeEditInstruction(text)
  ) {
    try {
      const { draftText, version } = await applyDraftEdits(r, text);
      await addMessage(roomId, {
        text: `✅ **Updated Draft (v${version})**\n\n${draftText}`,
        phase: stage,
        authorType: 'asema',
      });
      return res.json({ ok: true, edited: true, version });
    } catch (e) {
      console.error('[ask edit flow] error', e);
      await addMessage(roomId, {
        text:
          'I had trouble applying that edit. Try specifying exactly what to replace or which paragraph to change.',
        phase: stage,
        authorType: 'asema',
      });
      return res.json({ ok: true, fallback: true });
    }
  }

  // Throttle actual OpenAI calls per room
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
      return res.status(400).json({ error: 'wrong_stage', stage: room.stage });
    }

    const force = mode === 'regen' || mode === 'regenerate' || mode === 'ask';

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

// Presenter manual close button (FINAL stage only)
app.post('/rooms/:roomId/final/close', requireAuth, requirePresenter, async (req, res) => {
  const roomId = req.params.roomId;
  const room = await ensureRoom(roomId);
  if ((room.stage || 'LOBBY') !== 'FINAL') {
    return res.status(400).json({ error: 'wrong_stage', stage: room.stage });
  }

  try {
    const updated = await closeRoomWithFinal(room, {
      reason: 'presenter',
      closedBy: req.user.uid,
    });
    return res.json({
      ok: true,
      closed: true,
      stage: updated.stage,
      closedAt: updated.closedAt,
    });
  } catch (e) {
    console.error('[final/close] error', e);
    return res.status(500).json({ error: 'close_failed' });
  }
});

// Mark a participant as "ready" in FINAL stage (called when they click done/submit)
app.post('/rooms/:roomId/final/ready', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const uid = req.user?.uid;
  if (!uid) {
    return res.status(401).json({ error: 'no_uid' });
  }

  const readyRes = await markFinalReady(roomId, uid);
  if (!readyRes.ok) {
    return res.status(400).json({ error: 'wrong_stage', stage: readyRes.stage });
  }

  return res.json({
    ok: true,
    readyCount: readyRes.readyCount,
    seats: readyRes.seats,
    autoClosed: readyRes.autoClosed,
    stage: readyRes.autoClosed ? 'CLOSED' : 'FINAL',
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
          UpdateExpression: 'SET consumed = :c, usedBy = :u, consumedAt = :t',
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
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
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
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[static fallback /app/*] error', err);
        res.status(404).send(`Error: index.html not found at '${indexPath}'`);
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
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method })
);

app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(`[env] endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`);
  console.log(
    `[env] CORS_ORIGINS=${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'}`
  );
  console.log(`[env] SPA=${ENABLE_SPA} dist=${WEB_DIST_DIR} present=${distHasIndex}`);
});
