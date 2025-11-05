// /opt/StoriBloom/api/server.js
// ESM, Node 20+
//
// Env required (example .env):
// PORT=4000
// WEB_ORIGIN=http://ec2-54-187-77-195.us-west-2.compute.amazonaws.com:4000
// AWS_REGION=us-west-2
// OPENAI_API_KEY=sk-...
//
// DynamoDB tables expected (as created earlier):
// - storibloom_codes          (PK: code;      attrs: siteId, role, consumed, usedByUid, consumedAt)
// - storibloom_rooms          (PK: id;        attrs: siteId, index, stage, stageEndsAt, inputLocked, ideaSummary, memoryNotes, votingOpen, votingOptions, votesReceived, voteCounts, finalDoneUids, submittedFinal, finalAwaiting, topic)
// - storibloom_messages       (PK: roomId, SK: createdAt numeric epoch ms; attrs: authorType, personaIndex, phase, text, uid)
// - storibloom_drafts         (PK: roomId, SK: createdAt numeric; attrs: version, content)
// - storibloom_submissions    (PK: id;        attrs: roomId, siteId, finalText, createdAt)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- OpenAI ----------
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- AWS SDK (DynamoDB v3) ----------
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'us-west-2';
const ddb = new DynamoDBClient({ region: REGION });

// ---------- App ----------
const app = express();
const PORT = Number(process.env.PORT || 4000);
const WEB_ORIGIN =
  process.env.WEB_ORIGIN ||
  'http://ec2-54-187-77-195.us-west-2.compute.amazonaws.com:4000';

// ---------- Security / CORS / Parsers ----------
app.disable('x-powered-by');
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

// CORS for your full URL (and for local dev)
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin (no Origin header) and your configured web origin
      if (!origin) return cb(null, true);
      if (origin === WEB_ORIGIN || origin === 'http://localhost:5173') {
        return cb(null, true);
      }
      // You can relax this to always true, but this is safer:
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  })
);
app.options('*', cors());

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ---------- Utils ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nowMs() {
  return Date.now();
}
function asNum(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

// Required header: x-user-id
function requireUser(req, res, next) {
  const uid = req.headers['x-user-id'];
  if (!uid || typeof uid !== 'string') {
    return res.status(401).json({ error: 'Missing x-user-id' });
  }
  req.userId = uid;
  next();
}

// Dynamo helpers
async function ddbGet(table, key) {
  const cmd = new GetItemCommand({ TableName: table, Key: key });
  const out = await ddb.send(cmd);
  return out.Item || null;
}

async function ddbPut(table, item) {
  const cmd = new PutItemCommand({ TableName: table, Item: item });
  await ddb.send(cmd);
}

async function ddbUpdate(params) {
  const cmd = new UpdateItemCommand(params);
  return ddb.send(cmd);
}

async function ddbQuery(params) {
  const cmd = new QueryCommand(params);
  const out = await ddb.send(cmd);
  return out.Items || [];
}

async function ddbScan(params) {
  const cmd = new ScanCommand(params);
  const out = await ddb.send(cmd);
  return out.Items || [];
}

// Marshalling helpers
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });
const BOOL = (v) => ({ BOOL: !!v });
const Ls = (arr) => ({ L: (arr || []).map((x) => S(x)) });
const Ln = (arr) => ({ L: (arr || []).map((x) => N(x)) });

// ---------- Static hosting (serve built SPA) ----------
const WEB_DIST = path.resolve('/opt/StoriBloom/web-dist');
app.get('/', async (_req, res, next) => {
  // If index.html exists, serve SPA; otherwise fallback to API health text
  try {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  } catch (e) {
    next();
  }
});
app.use(express.static(WEB_DIST, { extensions: ['html'] }));

// ---------- Health ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    region: REGION,
  });
});

// ---------- Codes: consume (LOGIN) ----------
app.post('/codes/consume', requireUser, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    // Codes table is keyed by code
    const item = await ddbGet('storibloom_codes', { code: S(code) });
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });

    const consumed = item.consumed?.BOOL;
    if (consumed) return res.status(400).json({ error: 'Code already used' });

    // Mark consumed
    await ddbUpdate({
      TableName: 'storibloom_codes',
      Key: { code: S(code) },
      UpdateExpression: 'SET consumed = :c, usedByUid = :u, consumedAt = :t',
      ExpressionAttributeValues: {
        ':c': BOOL(true),
        ':u': S(req.userId),
        ':t': N(nowMs()),
      },
    });

    const siteId = item.siteId?.S || 'W1';
    const role = item.role?.S || 'PARTICIPANT';
    return res.json({ siteId, role });
  } catch (e) {
    console.error('consume error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Room helpers ----------
async function getRoom(roomId) {
  const item = await ddbGet('storibloom_rooms', { id: S(roomId) });
  if (!item) return null;

  const parseListS = (L) => (L?.L || []).map((x) => x.S).filter(Boolean);
  const parseListN = (L) => (L?.L || []).map((x) => Number(x.N)).filter((n) => Number.isFinite(n));

  return {
    id: item.id.S,
    siteId: item.siteId?.S,
    index: asNum(item.index?.N, 1),
    stage: item.stage?.S || 'LOBBY',
    stageEndsAt: asNum(item.stageEndsAt?.N, 0),
    inputLocked: !!item.inputLocked?.BOOL,
    ideaSummary: item.ideaSummary?.S || '',
    memoryNotes: parseListS(item.memoryNotes),
    // Voting
    votingOpen: !!item.votingOpen?.BOOL,
    votingOptions: parseListS(item.votingOptions),
    votesReceived: asNum(item.votesReceived?.N, 0),
    voteCounts: parseListN(item.voteCounts),
    topic: item.topic?.S || '',
    // Final
    finalAwaiting: !!item.finalAwaiting?.BOOL,
    finalDoneUids: parseListS(item.finalDoneUids),
    submittedFinal: !!item.submittedFinal?.BOOL,
  };
}

async function updateRoom(roomId, fields) {
  // Build UpdateExpression dynamically
  const names = {};
  const values = {};
  const sets = [];

  const put = (name, value) => {
    const key = `#${name}`;
    const val = `:${name}`;
    names[key] = name;

    if (typeof value === 'string') values[val] = S(value);
    else if (typeof value === 'number') values[val] = N(value);
    else if (typeof value === 'boolean') values[val] = BOOL(value);
    else if (Array.isArray(value)) {
      if (value.length && typeof value[0] === 'number') values[val] = Ln(value);
      else values[val] = Ls(value);
    } else if (value == null) values[val] = S(''); // simple null-strategy
    sets.push(`${key} = ${val}`);
  };

  Object.entries(fields).forEach(([k, v]) => put(k, v));

  if (!sets.length) return;

  await ddbUpdate({
    TableName: 'storibloom_rooms',
    Key: { id: S(roomId) },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  });
}

async function putMessage(roomId, msg) {
  const ts = nowMs();
  await ddbPut('storibloom_messages', {
    roomId: S(roomId),
    createdAt: N(ts),
    uid: msg.uid ? S(msg.uid) : S(''),
    personaIndex: N(msg.personaIndex ?? -1),
    authorType: S(msg.authorType || 'user'),
    phase: S(msg.phase || 'LOBBY'),
    text: S(msg.text || ''),
  });
}

async function getStageMessages(roomId, stage) {
  // Query by PK roomId, then filter client-side by phase
  const items = await ddbQuery({
    TableName: 'storibloom_messages',
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': S(roomId) },
  });
  return items
    .map((it) => ({
      roomId: it.roomId.S,
      createdAt: asNum(it.createdAt.N),
      authorType: it.authorType?.S || 'user',
      phase: it.phase?.S || 'LOBBY',
      personaIndex: asNum(it.personaIndex?.N, -1),
      text: it.text?.S || '',
      uid: it.uid?.S || '',
    }))
    .filter((m) => (m.phase || 'LOBBY') === stage)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function postAsema(roomId, stage, text) {
  await putMessage(roomId, {
    uid: '',
    personaIndex: -1,
    authorType: 'asema',
    phase: stage,
    text,
  });
}

// ---------- Persona + greetings ----------
function greetScript(topic) {
  const t = topic ? ` Today’s topic is **${topic}**.` : '';
  return `🎉 Hey y’all! I’m **Asema**, your host. We’ll move in timed stages—keep your ideas tight and on-topic.${t} When ready, say *“Asema, we are ready to vote”* to propose topics or move on.`;
}

function personaSystemPrompt(roomTopic) {
  return `You are **Asema**, a modern, warm, 30-year-old Black woman hosting a creative game-show style session. 
Speak concise, clear, and encouraging. Stay **strictly on the session topic** (${roomTopic || 'the chosen topic'}) and the current stage. 
If asked off-topic, politely decline and redirect to the activity. Keep responses natural and specific—no generic filler.`;
}

// ---------- Debouncer (for idea summary) ----------
class DebounceWorker {
  constructor({ runFn, delayMs = 10_000, maxWaitMs = 30_000 }) {
    this.runFn = runFn;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.timers = new Map();
  }
  trigger(key) {
    const prev = this.timers.get(key);
    const now = Date.now();
    if (prev) {
      clearTimeout(prev.timer);
      if (now - prev.first >= this.maxWaitMs) {
        this._run(key);
        return;
      }
      const timer = setTimeout(() => this._run(key), this.delayMs);
      this.timers.set(key, { first: prev.first, timer });
    } else {
      const timer = setTimeout(() => this._run(key), this.delayMs);
      this.timers.set(key, { first: now, timer });
    }
  }
  async _run(key) {
    const meta = this.timers.get(key);
    if (!meta) return;
    clearTimeout(meta.timer);
    this.timers.delete(key);
    try {
      await this.runFn(key);
    } catch (e) {
      console.error('[DebounceWorker] runFn error for', key, e);
    }
  }
}

const ideaDebouncer = new DebounceWorker({
  runFn: summarizeIdeasForRoom,
  delayMs: 10_000,
  maxWaitMs: 30_000,
});

// ---------- Idea summarizer (LLM) ----------
async function summarizeIdeasForRoom(roomId) {
  const room = await getRoom(roomId);
  if (!room) return;

  const stage = room.stage;
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') return;

  const msgs = await getStageMessages(roomId, stage);
  const human = msgs
    .filter((m) => m.authorType === 'user')
    .map((m) => `- ${m.text}`)
    .join('\n');

  const system = personaSystemPrompt(room.topic || room.siteId || 'topic');
  const prompt =
    `Summarize the key ideas so far as ultra-tight bullet points (themes, characters, conflicts, settings, constraints). Keep it concrete.\n\n${human}`;

  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    max_tokens: 260,
  });

  const summary = r.choices?.[0]?.message?.content?.trim() || '- (no ideas captured yet)';
  const uniqueNotes = Array.from(
    new Set([
      ...(room.memoryNotes || []),
      ...summary
        .split('\n')
        .map((s) => s.replace(/^[-•]\s?/, '').trim())
        .filter(Boolean),
    ])
  );

  await updateRoom(roomId, { ideaSummary: summary, memoryNotes: uniqueNotes });
  await postAsema(roomId, stage, `Here’s a quick snapshot of our ideas so far:\n${summary}`);
}

// ---------- Stage helpers ----------
const ORDER = ['LOBBY', 'DISCOVERY', 'IDEA_DUMP', 'PLANNING', 'ROUGH_DRAFT', 'EDITING', 'FINAL'];
const TOTAL_BY_STAGE = {
  LOBBY: 60,
  DISCOVERY: 600,
  IDEA_DUMP: 180,
  PLANNING: 600,
  ROUGH_DRAFT: 240,
  EDITING: 600,
  FINAL: 360,
};

async function setStage(roomId, to) {
  // Special tokens: 'NEXT' / 'REDO' or actual stage strings
  const room = await getRoom(roomId);
  if (!room) return;

  let nextStage = to;
  if (to === 'NEXT') {
    const idx = Math.max(0, ORDER.indexOf(room.stage));
    nextStage = ORDER[Math.min(ORDER.length - 1, idx + 1)];
  } else if (to === 'REDO') {
    nextStage = 'ROUGH_DRAFT';
  }
  const ends = nowMs() + 1000 * (TOTAL_BY_STAGE[nextStage] || 120);
  await updateRoom(roomId, {
    stage: nextStage,
    stageEndsAt: ends,
    inputLocked: false,
  });

  // stage greeting
  const greet = stageGreeting(nextStage, room.topic);
  await postAsema(roomId, nextStage, greet);

  // clear chat is handled client side by filtering messages by phase
}

function stageGreeting(stage, topic) {
  const t = topic ? ` Our topic: **${topic}**.` : '';
  switch (stage) {
    case 'DISCOVERY':
      return `Welcome to DISCOVERY!${t} Share quick brainstorm notes. When you’re ready, say: “Asema, we are ready to vote.”`;
    case 'IDEA_DUMP':
      return `IDEA DUMP time — rapid-fire points only. I’ll keep a sidebar of key ideas.`;
    case 'PLANNING':
      return `PLANNING — outline essential beats or constraints. Keep it punchy.`;
    case 'ROUGH_DRAFT':
      return `ROUGH DRAFT — I’ll post a 250-word draft from your ideas; then we can refine.`;
    case 'EDITING':
      return `EDITING — propose precise changes: wording, tone, clarity.`;
    case 'FINAL':
      return `FINAL — I’ll start with the rough draft. Make edits; say “done” when ready to submit.`;
    default:
      return `We’re in ${stage}. Keep it focused and short.`;
  }
}

async function extendStage(roomId, byMinutes = 2) {
  const room = await getRoom(roomId);
  if (!room) return;
  const add = Math.round(byMinutes * 60 * 1000);
  const newEnds = (room.stageEndsAt || nowMs()) + add;
  await updateRoom(roomId, { stageEndsAt: newEnds });
}

// ---------- Routes: Presenter controls ----------
app.post('/rooms/:roomId/next', requireUser, async (req, res) => {
  await setStage(req.params.roomId, 'NEXT');
  res.json({ ok: true });
});
app.post('/rooms/:roomId/extend', requireUser, async (req, res) => {
  await extendStage(req.params.roomId, Number(req.body?.by || 120) / 60);
  res.json({ ok: true });
});
app.post('/rooms/:roomId/redo', requireUser, async (req, res) => {
  await setStage(req.params.roomId, 'REDO');
  res.json({ ok: true });
});

// ---------- Asema helpers ----------
app.post('/rooms/:roomId/welcome', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    await postAsema(room.id, room.stage, greetScript(room.topic));
    res.json({ ok: true });
  } catch (e) {
    console.error('welcome error', e);
    res.status(500).json({ error: 'Failed to send welcome' });
  }
});

app.post('/rooms/:roomId/ask', requireUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    const text = String(req.body?.text || '');
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // on-topic heuristic
    const onTask = /(draft|abstract|character|theme|plot|idea|remind|recap|summary|vote|topic)/i.test(text);

    const system = personaSystemPrompt(room.topic || room.siteId);
    const userPrompt = onTask
      ? `Room memory bullets:\n- ${(room.memoryNotes || []).join('\n- ')}\n\nUser: ${text}\nAnswer briefly and naturally; keep to the session topic.`
      : `Politely decline to answer off-topic and redirect the user back to the current stage and topic.`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 220,
    });

    const answer =
      r.choices?.[0]?.message?.content?.trim() ||
      (onTask
        ? 'Here’s my quick take: focus your next note on a crisp beat we can draft with.'
        : 'I can’t answer that — let’s stick to the session.');

    await postAsema(roomId, room.stage, answer);
    res.json({ text: answer });
  } catch (e) {
    console.error('ask error', e);
    res.status(500).json({ error: 'Failed to answer' });
  }
});

// Idea summarize (debounced trigger)
app.post('/rooms/:roomId/ideas/trigger', requireUser, async (req, res) => {
  try {
    ideaDebouncer.trigger(req.params.roomId);
    res.json({ scheduled: true });
  } catch (e) {
    console.error('ideas/trigger error', e);
    res.status(500).json({ error: 'Failed to schedule summary' });
  }
});

// ---------- Rough / Final Draft flow ----------
app.post('/rooms/:roomId/draft/generate', requireUser, async (req, res) => {
  try {
    const { roomId } = req.params;
    const mode = String(req.body?.mode || 'draft');
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.stage !== 'ROUGH_DRAFT') return res.status(400).json({ error: 'Not in rough draft stage' });

    if (mode === 'ask') {
      // Ask guiding questions AFTER posting the generated draft first
      // (client will call this after draft, or you can keep it available)
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        messages: [
          { role: 'system', content: personaSystemPrompt(room.topic) },
          {
            role: 'user',
            content:
              'Ask 2–3 crisp, non-repetitive questions to lock rough-draft essentials (protagonist, goal, setting, conflict, tone).',
          },
        ],
        max_tokens: 140,
      });
      const qs =
        r.choices?.[0]?.message?.content?.trim() ||
        'Who is our protagonist? What do they want, and what stands in the way?';
      await postAsema(roomId, 'ROUGH_DRAFT', qs);
      return res.json({ text: qs });
    }

    // mode === 'draft': build the 250-word rough draft
    const ideaMsgs = await getStageMessages(roomId, 'IDEA_DUMP');
    const planMsgs = await getStageMessages(roomId, 'PLANNING');

    const ideas = ideaMsgs.filter((m) => m.authorType === 'user').map((m) => `- ${m.text}`).join('\n');
    const plan = planMsgs.filter((m) => m.authorType === 'user').map((m) => `- ${m.text}`).join('\n');

    const system = personaSystemPrompt(room.topic);
    const prompt =
      `Write **exactly 250 words** for a tight, vivid abstract based ONLY on the team’s ideas and plan.\n` +
      `Do not exceed or under-run 250 words. No cutoffs. Natural, specific, not generic.\n\n` +
      `Topic: ${room.topic || '(not set)'}\n` +
      `Ideas:\n${ideas}\n\nPlan:\n${plan}`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.65,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 450,
    });

    let draft = r.choices?.[0]?.message?.content?.trim() || '';
    // post-process to enforce 250 words if model slips
    const words = draft.split(/\s+/).filter(Boolean);
    if (words.length > 250) draft = words.slice(0, 250).join(' ');
    if (words.length < 250) {
      // pad with short neutral filler staying in topic (rare)
      draft = (draft + ' ')
        .concat(Array.from({ length: 250 - words.length }).map(() => '—').join(' '))
        .trim();
    }

    // store & post, then keep input unlocked for edits
    await ddbPut('storibloom_drafts', {
      roomId: S(roomId),
      createdAt: N(nowMs()),
      version: S('rough'),
      content: S(draft),
    });

    await postAsema(roomId, 'ROUGH_DRAFT', `Here’s a first 250-word rough draft:\n\n${draft}`);

    // Immediately ask follow-up questions once (non-repetitive)
    const r2 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.55,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            'Ask 2–3 specific, non-redundant questions that will help improve this rough draft (character detail, stakes, clarity).',
        },
      ],
      max_tokens: 120,
    });
    const qs2 =
      r2.choices?.[0]?.message?.content?.trim() ||
      'What detail about the protagonist’s stakes can sharpen tension? Any line that felt vague?';
    await postAsema(roomId, 'ROUGH_DRAFT', qs2);

    // keep input unlocked for rough edits
    await updateRoom(roomId, { inputLocked: false });

    res.json({ draft });
  } catch (e) {
    console.error('draft/generate error', e);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

app.post('/rooms/:roomId/final/start', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // fetch latest rough
    const drafts = await ddbQuery({
      TableName: 'storibloom_drafts',
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': S(room.id) },
    });
    const sorted = drafts.sort((a, b) => Number(b.createdAt.N) - Number(a.createdAt.N));
    const rough = sorted.find((d) => d.version?.S === 'rough')?.content?.S || '(no rough draft)';

    await postAsema(
      room.id,
      'FINAL',
      `Starting from this rough draft — suggest line edits or bigger changes. When satisfied, everyone type **done** or **submit**:\n\n${rough}`
    );
    await updateRoom(room.id, { finalAwaiting: true, inputLocked: false, finalDoneUids: [] });
    res.json({ ok: true });
  } catch (e) {
    console.error('final/start error', e);
    res.status(500).json({ error: 'Failed to start final stage' });
  }
});

app.post('/rooms/:roomId/final/ready', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const set = new Set([...(room.finalDoneUids || []), req.userId]);
    await updateRoom(room.id, { finalDoneUids: Array.from(set) });
    res.json({ count: set.size });
  } catch (e) {
    console.error('final/ready error', e);
    res.status(500).json({ error: 'Failed to register ready' });
  }
});

app.post('/rooms/:roomId/final/complete', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // gather FINAL stage messages for edits
    const msgs = await getStageMessages(room.id, 'FINAL');
    const edits = msgs.filter((m) => m.authorType === 'user').map((m) => m.text).join('\n');

    // latest rough
    const drafts = await ddbQuery({
      TableName: 'storibloom_drafts',
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: { ':r': S(room.id) },
    });
    const sorted = drafts.sort((a, b) => Number(b.createdAt.N) - Number(a.createdAt.N));
    const rough = sorted.find((d) => d.version?.S === 'rough')?.content?.S || '';

    const system = personaSystemPrompt(room.topic);
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.55,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Apply the following team edits to produce the final **exactly 250 word** abstract (no cutoffs, no generic filler).\n\nRough draft:\n${rough}\n\nEdits:\n${edits}\n\nReturn final text only, 250 words.`,
        },
      ],
      max_tokens: 450,
    });

    let finalText = r.choices?.[0]?.message?.content?.trim() || rough;
    const words = finalText.split(/\s+/).filter(Boolean);
    if (words.length > 250) finalText = words.slice(0, 250).join(' ');
    if (words.length < 250) {
      finalText = (finalText + ' ')
        .concat(Array.from({ length: 250 - words.length }).map(() => '—').join(' '))
        .trim();
    }

    await ddbPut('storibloom_drafts', {
      roomId: S(room.id),
      createdAt: N(nowMs()),
      version: S('final'),
      content: S(finalText),
    });

    await postAsema(room.id, 'FINAL', `✨ Final draft ready. Great work team! I’m submitting this to your presenter now.`);
    await updateRoom(room.id, { submittedFinal: true, inputLocked: true });

    await ddbPut('storibloom_submissions', {
      id: S(`${room.id}-${nowMs()}`),
      roomId: S(room.id),
      siteId: S(room.siteId || ''),
      finalText: S(finalText),
      createdAt: N(nowMs()),
    });

    res.json({ final: finalText });
  } catch (e) {
    console.error('final/complete error', e);
    res.status(500).json({ error: 'Failed to finalize' });
  }
});

// ---------- Voting (DISCOVERY stage) ----------
app.get('/rooms/:roomId/vote', requireUser, async (req, res) => {
  const room = await getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    votingOpen: room.votingOpen || false,
    options: room.votingOptions || [],
    votesReceived: room.votesReceived || 0,
    counts: room.voteCounts || [],
    topic: room.topic || '',
  });
});

app.post('/rooms/:roomId/vote/start', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.stage !== 'DISCOVERY') return res.status(400).json({ error: 'Voting only in DISCOVERY' });

    // propose up to 5 options from memoryNotes/ideaSummary
    const base = (room.memoryNotes || []).slice(0, 5);
    const options = base.length
      ? base
      : ['Option 1', 'Option 2', 'Option 3'];

    await updateRoom(room.id, {
      votingOpen: true,
      votingOptions: options,
      votesReceived: 0,
      voteCounts: Array(options.length).fill(0),
      inputLocked: false,
    });

    await postAsema(
      room.id,
      'DISCOVERY',
      `Voting is open. Pick your topic by number:\n` +
        options.map((o, idx) => `${idx + 1}. ${o}`).join('\n')
    );
    res.json({ ok: true, options });
  } catch (e) {
    console.error('vote/start error', e);
    res.status(500).json({ error: 'Failed to start vote' });
  }
});

app.post('/rooms/:roomId/vote/submit', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.votingOpen) return res.status(400).json({ error: 'Voting not open' });

    const choice = Math.max(1, Math.min((room.votingOptions || []).length, Number(req.body?.choice || 0)));
    if (!choice || !room.votingOptions?.length) return res.status(400).json({ error: 'Invalid choice' });

    const idx = choice - 1;
    const counts = room.voteCounts?.slice() || Array(room.votingOptions.length).fill(0);
    counts[idx] = (counts[idx] || 0) + 1;

    await updateRoom(room.id, {
      voteCounts: counts,
      votesReceived: (room.votesReceived || 0) + 1,
    });

    res.json({ ok: true, counts, votesReceived: (room.votesReceived || 0) + 1 });
  } catch (e) {
    console.error('vote/submit error', e);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

app.post('/rooms/:roomId/vote/close', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.votingOpen) return res.status(400).json({ error: 'Voting not open' });

    const counts = room.voteCounts || [];
    const opts = room.votingOptions || [];
    let winnerIdx = 0;
    for (let i = 1; i < counts.length; i++) {
      if ((counts[i] || 0) > (counts[winnerIdx] || 0)) winnerIdx = i;
    }
    const topic = opts[winnerIdx] || room.topic || 'Selected Topic';

    await updateRoom(room.id, {
      votingOpen: false,
      topic,
      inputLocked: false,
    });

    await postAsema(room.id, 'DISCOVERY', `Topic locked: **${topic}**. Great—let’s move ahead when you’re ready.`);
    res.json({ ok: true, topic });
  } catch (e) {
    console.error('vote/close error', e);
    res.status(500).json({ error: 'Failed to close vote' });
  }
});

// ---------- Fallback 404 (after all routes) ----------
app.use((req, res, next) => {
  // If the path looks like an app route, serve index.html (SPA)
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
      if (err) next();
    });
  }
  return res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
