import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { OpenAI } from 'openai';
import {
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

// -----------------------------
// Config & Clients
// -----------------------------
const {
  PORT = 4000,
  NODE_ENV = 'development',
  AWS_REGION = 'us-west-2',
  JWT_SECRET = 'dev-secret',
  OPENAI_API_KEY,
  CORS_ORIGINS = 'http://localhost:5173',
} = process.env;

if (!OPENAI_API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY missing — endpoints that call LLM will fail.');
}

const app = express();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const ddb = new DynamoDBClient({ region: AWS_REGION });
const db = DynamoDBDocumentClient.from(ddb);

// DynamoDB table names (must exist)
const T_SITES = 'storibloom_sites';
const T_ROOMS = 'storibloom_rooms';
const T_CODES = 'storibloom_codes';
const T_MESSAGES = 'storibloom_messages';
const T_DRAFTS = 'storibloom_drafts';
const T_SUBMISSIONS = 'storibloom_submissions';

// -----------------------------
// CORS & middleware
// -----------------------------
const allowedOrigins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl/postman
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: ${origin} not allowed`), false);
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// -----------------------------
// Constants
// -----------------------------
const ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL'];
const DUR = { // seconds per stage
  LOBBY: 60,
  DISCOVERY: 600,
  IDEA_DUMP: 180,
  PLANNING: 600,
  ROUGH_DRAFT: 240,
  EDITING: 600,
  FINAL: 360,
};

const ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap'
];

// -----------------------------
// Utils
// -----------------------------
function nowMs() { return Date.now(); }
function msFromNow(seconds) { return nowMs() + seconds * 1000; }

function safeWordCount(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean).length;
}

// Ask model to EXACTLY 250 words; if not, do a second pass to fix length.
async function toExactly250Words(text, systemTone) {
  const target = 250;

  async function ask(n, content) {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: systemTone },
        { role: 'user', content }
      ],
      max_tokens: 800
    });
    return r.choices?.[0]?.message?.content?.trim() || '';
  }

  let out = await ask(1,
    `Rewrite the following as a single cohesive abstract of exactly ${target} words, no more or less. 
     Make it concise, vivid, and complete. Return ONLY the abstract text. 
     Text:\n${text}`
  );

  let wc = safeWordCount(out);
  if (wc !== target) {
    out = await ask(2,
      `Your last output had ${wc} words. Rewrite to EXACTLY ${target} words, preserving coherence and flow. 
       Return ONLY the abstract text.\n\n${out}`
    );
    wc = safeWordCount(out);
  }
  return out;
}

function personaSystemPrompt({ roomTopic }) {
  return `You are **Asema**, a sharp, supportive Black woman in her 30s with a modern game-show-host vibe. 
Stay upbeat, concise, and keep the team on-task. 
Topic: ${roomTopic || '(not chosen yet)'}.
Answer ONLY if it's about the session, abstract, or the listed community issues. Otherwise, decline politely and redirect.`;
}

function greetScript({ roomTopic }) {
  return `Welcome team! I’m **Asema**—your host and collaborator for StoriBloom.AI.
You’ll work together to craft a tight 250-word abstract on our chosen community issue. 
We’ll start with Discovery, then gather key ideas, plan, draft, edit, and finalize. 
If you need me—just say “Asema, …”. Let’s do this!${roomTopic ? ` (Topic: ${roomTopic})` : ''}`;
}

// Debounce worker (per-room key)
class DebounceWorker {
  constructor({ runFn, delayMs = 10000, maxWaitMs = 30000 }) {
    this.runFn = runFn;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.timers = new Map(); // roomId -> {timeout, firstAt}
  }
  trigger(roomId) {
    const e = this.timers.get(roomId) || { timeout: null, firstAt: nowMs() };
    if (!e.firstAt) e.firstAt = nowMs();
    if (e.timeout) clearTimeout(e.timeout);
    const elapsed = nowMs() - e.firstAt;
    const delay = Math.max(0, Math.min(this.delayMs, this.maxWaitMs - elapsed));
    e.timeout = setTimeout(async () => {
      this.timers.delete(roomId);
      try { await this.runFn(roomId); } catch (err) { console.error('[DebounceWorker] runFn error for', roomId, err); }
    }, delay);
    this.timers.set(roomId, e);
  }
}

// Small helpers around Dynamo
async function getRoom(roomId) {
  const r = await db.send(new GetCommand({ TableName: T_ROOMS, Key: { roomId } }));
  return r.Item || null;
}
async function putRoom(room) {
  await db.send(new PutCommand({ TableName: T_ROOMS, Item: room }));
}
async function updateRoom(roomId, expression, values, names) {
  await db.send(new UpdateCommand({
    TableName: T_ROOMS,
    Key: { roomId },
    UpdateExpression: expression,
    ExpressionAttributeValues: values || undefined,
    ExpressionAttributeNames: names || undefined
  }));
}
async function addMessage({ roomId, phase, authorType, text, uid = null, personaIndex = -1 }) {
  const createdAt = nowMs();
  await db.send(new PutCommand({
    TableName: T_MESSAGES,
    Item: { roomId, createdAt, phase, authorType, text, uid, personaIndex }
  }));
  return createdAt;
}
async function queryMessagesByPhase(roomId, phase, sinceTs) {
  // Prefer GSI "byRoomPhase" if created; otherwise filter client-side after query by createdAt
  const params = sinceTs
    ? {
        TableName: T_MESSAGES,
        KeyConditionExpression: 'roomId = :r AND createdAt > :t',
        ExpressionAttributeValues: { ':r': roomId, ':t': sinceTs }
      }
    : {
        TableName: T_MESSAGES,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: { ':r': roomId }
      };
  const out = await db.send(new QueryCommand(params));
  const all = out.Items || [];
  return phase ? all.filter(m => (m.phase || 'LOBBY') === phase) : all;
}

// Stage control
async function setStage(roomId, stage) {
  const ends = msFromNow(DUR[stage] || 60);
  await updateRoom(
    roomId,
    'SET stage = :s, stageEndsAt = :e, inputLocked = :l',
    { ':s': stage, ':e': ends, ':l': false }
  );
}
async function extendStage(roomId, seconds) {
  const room = await getRoom(roomId);
  const old = room?.stageEndsAt || nowMs();
  const ends = old + (seconds * 1000);
  await updateRoom(roomId, 'SET stageEndsAt = :e', { ':e': ends });
}

// -----------------------------
// Debounced idea summarizer (AWS)
// -----------------------------
const ideaDebouncer = new DebounceWorker({
  runFn: summarizeIdeas,
  delayMs: 10_000,
  maxWaitMs: 30_000
});

async function summarizeIdeas(roomId) {
  const room = await getRoom(roomId);
  if (!room) return;

  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') return;

  const msgs = await queryMessagesByPhase(roomId, stage);
  const human = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

  const system = personaSystemPrompt({ roomTopic: room.topic });
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Summarize the key ideas so far as short bullets: themes, characters, conflicts, settings, constraints.\n\n${human}` }
    ],
    max_tokens: 260
  });
  const summary = r.choices?.[0]?.message?.content?.trim() || '- (no ideas captured yet)';

  const newNotesSet = new Set([...(room.memoryNotes || [])]);
  summary.split('\n').forEach(line => {
    const s = String(line).replace(/^[-•]\s?/, '').trim();
    if (s) newNotesSet.add(s);
  });

  await updateRoom(
    roomId,
    'SET ideaSummary = :sum, memoryNotes = :mem',
    { ':sum': summary, ':mem': Array.from(newNotesSet) }
  );

  await addMessage({ roomId, phase: stage, authorType: 'asema', text: `Quick snapshot of our ideas so far:\n${summary}` });
}

// -----------------------------
// Auth
// -----------------------------
function signGuest(uid) {
  return jwt.sign(
    { uid, role: 'GUEST', iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}
function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// -----------------------------
// Routes
// -----------------------------
app.get('/', (_req, res) => res.send('StoriBloom API ✅'));

app.post('/auth/guest', (req, res) => {
  // random uid-like
  const uid = 'g_' + Math.random().toString(36).slice(2);
  const token = signGuest(uid);
  res.json({ token });
});

// Consume a session code (Presenter or Participant)
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const got = await db.send(new GetCommand({ TableName: T_CODES, Key: { code } }));
    const item = got.Item;
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });
    if (item.consumed) return res.status(400).json({ error: 'Code already used' });

    // Mark consumed
    await db.send(new UpdateCommand({
      TableName: T_CODES,
      Key: { code },
      UpdateExpression: 'SET consumed = :c, usedBy = :u, consumedAt = :t',
      ExpressionAttributeValues: { ':c': true, ':u': req.user.uid, ':t': nowMs() }
    }));

    res.json({ siteId: item.siteId, role: item.role });
  } catch (e) {
    console.error('consume error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// -------------- Room state & messages --------------
app.get('/rooms/:roomId/state', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const {
      siteId, index, stage, stageEndsAt, inputLocked = false,
      topic = null, ideaSummary = '', vote = null
    } = room;
    res.json({ siteId, index, stage, stageEndsAt, inputLocked, topic, ideaSummary, vote });
  } catch (e) {
    console.error('state error', e);
    res.status(500).json({ error: 'Failed to fetch state' });
  }
});

app.get('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  try {
    const since = req.query.since ? Number(req.query.since) : null;
    const phase = req.query.phase ? String(req.query.phase) : null;
    const items = await queryMessagesByPhase(req.params.roomId, null, since);
    // client filters by current stage anyway
    const lastTs = items.length ? Math.max(...items.map(m => m.createdAt)) : (since || 0);
    res.json({ items, lastTs });
  } catch (e) {
    console.error('messages error', e);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// -------------- Presenter controls --------------
app.post('/rooms/:roomId/next', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const idx = ORDER.indexOf(room.stage || 'LOBBY');
    const nextStage = ORDER[Math.min(idx + 1, ORDER.length - 1)];
    await setStage(roomId, nextStage);

    // greet at stage (once)
    await maybeStageGreeting(roomId, nextStage, room.topic);

    res.json({ ok: true, to: nextStage });
  } catch (e) {
    console.error('next error', e);
    res.status(500).json({ error: 'Failed to advance stage' });
  }
});

app.post('/rooms/:roomId/extend', requireAuth, async (req, res) => {
  try {
    const seconds = Number(req.body?.by || 120);
    await extendStage(req.params.roomId, seconds);
    res.json({ ok: true });
  } catch (e) {
    console.error('extend error', e);
    res.status(500).json({ error: 'Failed to extend stage' });
  }
});

app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  try {
    // Re-open drafting (EDITING -> ROUGH_DRAFT)
    await setStage(req.params.roomId, 'ROUGH_DRAFT');
    // unlock input to allow quick edits pre-draft regen if needed
    await updateRoom(req.params.roomId, 'SET inputLocked = :l', { ':l': false });
    res.json({ ok: true });
  } catch (e) {
    console.error('redo error', e);
    res.status(500).json({ error: 'Failed to redo' });
  }
});

// ---------------- Asema: greeting & Q/A ----------------
async function maybeStageGreeting(roomId, stage, topic) {
  const room = await getRoom(roomId);
  const greetingsSent = room?.greetingsSent || {};
  if (greetingsSent[stage]) return; // already greeted

  let text = '';
  if (stage === 'DISCOVERY') {
    text = greetScript({ roomTopic: topic });
  } else if (stage === 'IDEA_DUMP') {
    text = `Let’s capture raw ideas fast. Short lines are perfect—facts, feelings, images. I’ll keep a running summary on the right.`;
  } else if (stage === 'PLANNING') {
    text = `Great—now shape those fragments. What’s the angle, the POV, the emotional turn? Decide the spine in 3–4 bullets.`;
  } else if (stage === 'ROUGH_DRAFT') {
    text = `I’ll generate a tight 250-word rough draft first, then I’ll ask a couple of focused questions for quick improvements.`;
  } else if (stage === 'EDITING') {
    text = `Surgical edits: clarify, cut, sharpen. Ping me with “Asema,” if you want a quick rephrase of a sentence.`;
  } else if (stage === 'FINAL') {
    text = `Post your final tweaks. When satisfied, type “done” or “submit”. I’ll compile a clean final abstract (exactly 250 words).`;
  }

  if (text) await addMessage({ roomId, phase: stage, authorType: 'asema', text });

  greetingsSent[stage] = true;
  await updateRoom(roomId, 'SET greetingsSent = :g', { ':g': greetingsSent });
}

app.post('/rooms/:roomId/welcome', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    await maybeStageGreeting(req.params.roomId, room.stage || 'LOBBY', room.topic);
    res.json({ ok: true });
  } catch (e) {
    console.error('welcome error', e);
    res.status(500).json({ error: 'Failed to send welcome' });
  }
});

app.post('/rooms/:roomId/ask', requireAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';
    const system = personaSystemPrompt({ roomTopic: room.topic });

    const allowedTopics = ISSUES.map(s => s.toLowerCase());
    const onTask = allowedTopics.some(t => (text||'').toLowerCase().includes(t))
      || /(draft|abstract|character|theme|plot|idea|remind|recap|what did we say|summary|stage|vot(e|ing)|topic)/i.test(text||'');

    const userPrompt = onTask
      ? `Room memory:\n- ${(room.memoryNotes||[]).join('\n- ')}\n\nUser: ${text}\nAnswer briefly, keep it practical.`
      : `Politely decline and redirect to the activity and approved topics (${ISSUES.join(', ')}).`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.55,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 220
    });

    const answer = r.choices?.[0]?.message?.content?.trim()
      || 'I can’t answer that—let’s stick to our abstract and topic.';
    await addMessage({ roomId, phase: stage, authorType: 'asema', text: answer });
    res.json({ text: answer });
  } catch (e) {
    console.error('ask error', e);
    res.status(500).json({ error: 'Failed to answer' });
  }
});

// -------------- Ideas debounce trigger --------------
app.post('/rooms/:roomId/ideas/trigger', requireAuth, async (req, res) => {
  try {
    ideaDebouncer.trigger(req.params.roomId);
    res.json({ scheduled: true });
  } catch (e) {
    console.error('ideas/trigger error', e);
    res.status(500).json({ error: 'Failed to schedule summary' });
  }
});

// -------------- Rough Draft (250 words first), then guiding Qs --------------
app.post('/rooms/:roomId/draft/generate', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body || {}; // 'draft' | 'ask'
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';
    if (stage !== 'ROUGH_DRAFT') return res.status(400).json({ error: 'Not in rough draft stage' });

    const system = personaSystemPrompt({ roomTopic: room.topic });

    if (mode === 'draft') {
      // build source from planning + ideas
      const msgsPlan = await queryMessagesByPhase(roomId, 'PLANNING');
      const plan = msgsPlan.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

      const ideas = room.ideaSummary || '';
      const base = `Ideas:\n${ideas}\n\nPlan notes:\n${plan}\n\nCompose a complete, cohesive abstract.`;

      // First: generate 250 exactly
      const draft = await toExactly250Words(base, system);

      // Post the rough draft
      await db.send(new PutCommand({
        TableName: T_DRAFTS,
        Item: { roomId, createdAt: nowMs(), version: 'rough', content: draft }
      }));
      await addMessage({ roomId, phase: stage, authorType: 'asema', text: `Here’s a 250-word rough draft:\n\n${draft}` });

      // IMPORTANT: keep input UNLOCKED for quick reactions; we only lock briefly for posting
      await updateRoom(roomId, 'SET inputLocked = :l', { ':l': false });

      // After a short beat, post guiding questions ONCE (if not already asked)
      const qsPosted = (room.qsPostedAt || 0) > 0;
      if (!qsPosted) {
        setTimeout(async () => {
          try {
            const r2 = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              temperature: 0.6,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: `Ask 2–3 crisp questions to quickly improve the rough draft. Keep them specific and practical.` }
              ],
              max_tokens: 160
            });
            const qtxt = r2.choices?.[0]?.message?.content?.trim()
              || 'What tiny changes would sharpen clarity, stakes, or flow?';
            await addMessage({ roomId, phase: 'ROUGH_DRAFT', authorType: 'asema', text: qtxt });
            await updateRoom(roomId, 'SET qsPostedAt = :t', { ':t': nowMs() });
          } catch (e) { console.error('guiding q error', e); }
        }, 2000);
      }

      return res.json({ draft });
    }

    // mode === 'ask'
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.6, messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Ask 2–3 crisp questions to quickly improve the rough draft. Keep them specific and practical.` }
      ], max_tokens: 160
    });
    const qtxt = r.choices?.[0]?.message?.content?.trim()
      || 'What tiny changes would sharpen clarity, stakes, or flow?';
    await addMessage({ roomId, phase: 'ROUGH_DRAFT', authorType: 'asema', text: qtxt });
    res.json({ text: qtxt });
  } catch (e) {
    console.error('draft/generate error', e);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

// -------------- Final flow (exactly 250 words) --------------
app.post('/rooms/:roomId/final/start', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // fetch latest rough
    const drafts = await db.send(new QueryCommand({
      TableName: T_DRAFTS,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': roomId },
      ScanIndexForward: false, // newest first
      Limit: 1
    }));
    const rough = drafts.Items?.[0]?.content || '(no rough draft)';

    await addMessage({
      roomId,
      phase: 'FINAL',
      authorType: 'asema',
      text: `Starting from this rough draft—suggest edits. When satisfied, type **done** or **submit**:\n\n${rough}`
    });
    await updateRoom(roomId, 'SET finalAwaiting = :a, inputLocked = :l, finalDone = :d', {
      ':a': true, ':l': false, ':d': []
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('final/start error', e);
    res.status(500).json({ error: 'Failed to start final stage' });
  }
});

app.post('/rooms/:roomId/final/ready', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const uid = req.user.uid;
    const set = new Set([...(room.finalDone || [])]);
    set.add(uid);
    await updateRoom(roomId, 'SET finalDone = :d', { ':d': Array.from(set) });
    res.json({ count: set.size });
  } catch (e) {
    console.error('final/ready error', e);
    res.status(500).json({ error: 'Failed to mark ready' });
  }
});

app.post('/rooms/:roomId/final/complete', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // collect FINAL edits
    const msgs = await queryMessagesByPhase(roomId, 'FINAL');
    const edits = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    // latest rough
    const drafts = await db.send(new QueryCommand({
      TableName: T_DRAFTS,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': roomId },
      ScanIndexForward: false,
      Limit: 1
    }));
    const rough = drafts.Items?.[0]?.content || '';

    const system = personaSystemPrompt({ roomTopic: room.topic });
    // Ask model to apply edits, then normalize to EXACTLY 250 words
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.55, messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Apply the following edits to produce a clean ~250-word abstract.\n\nRough:\n${rough}\n\nEdits:\n${edits}\n\nReturn abstract text only.` }
      ], max_tokens: 600
    });
    let finalText = r.choices?.[0]?.message?.content?.trim() || rough;
    finalText = await toExactly250Words(finalText, system);

    // store final
    await db.send(new PutCommand({
      TableName: T_DRAFTS,
      Item: { roomId, createdAt: nowMs(), version: 'final', content: finalText }
    }));
    await addMessage({ roomId, phase: 'FINAL', authorType: 'asema', text: `✨ Final draft ready. Submitting to your presenter now.` });

    await db.send(new PutCommand({
      TableName: T_SUBMISSIONS,
      Item: {
        roomId,
        createdAt: nowMs(),
        siteId: room.siteId,
        title: room.topic || 'Untitled',
        finalText
      }
    }));
    await updateRoom(roomId, 'SET submittedFinal = :s, inputLocked = :l', { ':s': true, ':l': true });

    res.json({ final: finalText });
  } catch (e) {
    console.error('final/complete error', e);
    res.status(500).json({ error: 'Failed to finalize' });
  }
});

// ---------------- Voting (DISCOVERY) ----------------
app.post('/rooms/:roomId/vote/start', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if ((room.stage || 'LOBBY') !== 'DISCOVERY') {
      return res.status(400).json({ error: 'Voting allowed only in DISCOVERY' });
    }

    const options = ISSUES.map((t, i) => ({ n: i + 1, text: t }));
    await updateRoom(roomId,
      'SET vote = :v, inputLocked = :l',
      { ':v': { open: true, options, votesByUid: {}, lockedAt: 0, chosen: null }, ':l': false }
    );

    await addMessage({
      roomId,
      phase: 'DISCOVERY',
      authorType: 'asema',
      text: `I’m opening topic voting.\nChoose **1–5**:\n${options.map(o => `${o.n}. ${o.text}`).join('\n')}\nType your number to cast your vote once.`
    });

    res.json({ ok: true, options });
  } catch (e) {
    console.error('vote/start error', e);
    res.status(500).json({ error: 'Failed to start voting' });
  }
});

app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { choice } = req.body || {};
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const vote = room.vote || {};
    if (!vote.open) return res.status(400).json({ error: 'Voting not open' });

    const n = Number(choice);
    const valid = vote.options?.some(o => o.n === n);
    if (!valid) return res.status(400).json({ error: 'Invalid choice' });

    const uid = req.user.uid;
    if (vote.votesByUid && vote.votesByUid[uid]) {
      return res.status(400).json({ error: 'You already voted' });
    }
    const newVotes = { ...(vote.votesByUid || {}), [uid]: n };

    await updateRoom(roomId,
      'SET vote.votesByUid = :v',
      { ':v': newVotes }
    );

    res.json({ ok: true, choice: n });
  } catch (e) {
    console.error('vote/submit error', e);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

app.post('/rooms/:roomId/vote/close', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const vote = room.vote || {};
    if (!vote.open) return res.status(400).json({ error: 'No open vote' });

    const tally = new Map();
    Object.values(vote.votesByUid || {}).forEach(n => {
      tally.set(n, (tally.get(n) || 0) + 1);
    });
    let winner = null, best = -1;
    for (const [n, cnt] of tally.entries()) {
      if (cnt > best) { best = cnt; winner = Number(n); }
    }
    const chosen = vote.options?.find(o => o.n === winner) || null;

    await updateRoom(roomId,
      'SET vote.open = :o, vote.lockedAt = :t, vote.chosen = :c, topic = if_not_exists(topic, :topic)',
      { ':o': false, ':t': nowMs(), ':c': chosen, ':topic': chosen?.text || room.topic || null }
    );

    await addMessage({
      roomId,
      phase: 'DISCOVERY',
      authorType: 'asema',
      text: chosen
        ? `Locked topic: **${chosen.text}**. Great—let’s focus all ideas there.`
        : `No clear winner—let’s pick the most discussed item and move forward.`
    });

    res.json({ ok: true, chosen });
  } catch (e) {
    console.error('vote/close error', e);
    res.status(500).json({ error: 'Failed to close vote' });
  }
});

app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ vote: room.vote || null });
  } catch (e) {
    console.error('vote status error', e);
    res.status(500).json({ error: 'Failed to fetch vote status' });
  }
});

// ---------------- 404 ----------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

// ---------------- Listen ----------------
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
