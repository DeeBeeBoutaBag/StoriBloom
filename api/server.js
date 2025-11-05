// /opt/StoriBloom/api/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAI } from 'openai';

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/* ------------------------- ENV + GLOBALS ------------------------- */
const {
  PORT = 4000,
  NODE_ENV = 'production',
  AWS_REGION = 'us-west-2',
  OPENAI_API_KEY,
} = process.env;

const TABLES = {
  codes: 'storibloom_codes',
  rooms: 'storibloom_rooms',
  messages: 'storibloom_messages',
  drafts: 'storibloom_drafts',
  submissions: 'storibloom_submissions',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPA_DIR = '/opt/StoriBloom/web-dist';

const app = express();
const db = new DynamoDBClient({ region: AWS_REGION });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ------------------------- MIDDLEWARE ---------------------------- */
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      `http://localhost:${PORT}`,
      // same-origin (served by this Express) will be fine without CORS anyway
    ],
    credentials: false,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* ------------------------- LIGHT AUTH ---------------------------- */
/** Demo-only auth: accepts any Bearer <uid>, falls back to x-demo-uid header. */
async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    let uid = null;
    if (hdr.startsWith('Bearer ') && hdr.length > 7) uid = hdr.slice(7).trim();
    if (!uid) uid = req.headers['x-demo-uid'];
    if (!uid) return res.status(401).json({ error: 'Missing Authorization Bearer <uid>' });
    req.user = { uid };
    return next();
  } catch (e) {
    console.error('Auth error', e);
    return res.status(401).json({ error: 'Invalid auth' });
  }
}

/* ------------------------- UTILS ---------------------------- */
const ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL'];
const DUR = { // seconds
  LOBBY: 60,
  DISCOVERY: 600,
  IDEA_DUMP: 180,
  PLANNING: 600,
  ROUGH_DRAFT: 240,
  EDITING: 600,
  FINAL: 360,
};

function nowMs() { return Date.now(); }
function stageIndex(stage) { return Math.max(0, ORDER.indexOf(stage || 'LOBBY')); }
function clampStage(i) { return ORDER[Math.min(Math.max(i, 0), ORDER.length-1)]; }

async function getRoom(roomId) {
  const out = await db.send(new GetItemCommand({
    TableName: TABLES.rooms,
    Key: marshall({ roomId }),
  }));
  if (!out.Item) return null;
  return unmarshall(out.Item);
}

async function putRoom(room) {
  await db.send(new PutItemCommand({
    TableName: TABLES.rooms,
    Item: marshall(room),
  }));
}

async function setRoomProps(roomId, patch) {
  const room = await getRoom(roomId);
  const updated = { ...(room || { roomId, stage: 'LOBBY' }), ...patch };
  await putRoom(updated);
  return updated;
}

async function postMessage({ roomId, authorType, phase, uid = null, personaIndex = -1, text }) {
  const createdAt = Date.now();
  await db.send(new PutItemCommand({
    TableName: TABLES.messages,
    Item: marshall({ roomId, createdAt, phase, authorType, uid, personaIndex, text }),
  }));
  return { roomId, createdAt, phase, authorType, uid, personaIndex, text };
}

async function listStageMessages(roomId, phase) {
  // Query by roomId and filter by phase via GSI "byRoomPhase" OR do client filter from main index
  // We’ll do client filter using the main range on createdAt to keep indexes minimal:
  const q = await db.send(new QueryCommand({
    TableName: TABLES.messages,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: marshall({ ':r': roomId }),
    ScanIndexForward: true,
  }));
  const all = (q.Items || []).map(unmarshall);
  return all.filter(m => (m.phase || 'LOBBY') === phase);
}

function toWords(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}
function force250Words(text) {
  const words = toWords(text);
  if (words.length === 250) return text.trim();
  if (words.length < 250) {
    // pad gently by reflecting a sentence
    const pad = words.slice(Math.max(0, words.length - Math.min(words.length, 20)));
    while (words.length < 250) words.push(...pad);
    return words.slice(0, 250).join(' ').trim();
  }
  return words.slice(0, 250).join(' ').trim();
}

/* ------------------------- DEBOUNCER ---------------------------- */
const debounceMap = new Map(); // roomId -> { timer, lastRunAt }
function scheduleDebounced(roomId, fn, delayMs = 10_000, maxWaitMs = 30_000) {
  const now = nowMs();
  const entry = debounceMap.get(roomId) || { timer: null, startAt: now, lastRunAt: 0 };
  const shouldMaxFlush = (now - entry.startAt) >= maxWaitMs;

  clearTimeout(entry.timer);
  const run = async () => {
    try { await fn(); } catch (e) { console.error('[Debounce] run error', e); }
    debounceMap.delete(roomId);
  };

  if (shouldMaxFlush) {
    run();
  } else {
    entry.timer = setTimeout(run, delayMs);
    debounceMap.set(roomId, entry);
  }
}

/* ------------------------- OPENAI PERSONA ---------------------------- */
const ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap'
];
function personaSystemPrompt(roomTopic) {
  return [
    `You are Asema — a lively, 30-year-old African American game-show-style host and expert facilitator.`,
    `You help a group collaboratively craft a concise, vivid 250-word abstract about "${roomTopic || 'a selected community issue'}".`,
    `Constraints: stay on-session, on-topic, natural tone; be specific; avoid generic filler; give helpful structure.`,
    `If asked about unrelated topics, decline and gently steer back to the activity.`,
  ].join('\n');
}
function greetScript(roomTopic) {
  return [
    `🎤 Asema here — welcome team! Today we’ll co-create a tight, punchy 250-word abstract on "${roomTopic || 'one community issue'}".`,
    `We’ll warm up, gather ideas, shape a plan, build a rough draft, then polish a final.`,
    `If you need me anytime, just say "Asema, ..." and I’ll jump in.`,
    `Let’s start by sharing quick observations, lived experiences, or big questions you want this abstract to capture.`
  ].join(' ');
}

/* ------------------------- STATIC SPA HOSTING ------------------------ */
// Serve the React bundle first so "/" is the app
app.use(express.static(SPA_DIR, { index: 'index.html' }));
app.get(['/', '/login', '/room/*', '/presenter/*'], (_req, res) => {
  res.sendFile(path.join(SPA_DIR, 'index.html'));
});

// Health check on a non-root path
app.get('/healthz', (_req, res) => res.send('StoriBloom API (DynamoDB) ✅'));

/* ------------------------- CODES: CONSUME ---------------------------- */
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const out = await db.send(new GetItemCommand({
      TableName: TABLES.codes,
      Key: marshall({ code }),
    }));
    if (!out.Item) return res.status(404).json({ error: 'Code not found or invalid' });

    const row = unmarshall(out.Item);
    if (row.consumed) return res.status(400).json({ error: 'Code already used' });

    row.consumed = true;
    row.consumedAt = Date.now();
    row.usedByUid = req.user.uid;

    await db.send(new PutItemCommand({
      TableName: TABLES.codes,
      Item: marshall(row),
    }));

    return res.json({ siteId: row.siteId, role: row.role });
  } catch (e) {
    console.error('consume error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------- PRESENTER CONTROLS ------------------------ */
async function setStage(roomId, action) {
  const room = await getRoom(roomId) || { roomId, stage: 'LOBBY' };
  let idx = stageIndex(room.stage);
  if (action === 'NEXT') idx += 1;
  if (action === 'REDO') idx = Math.max(idx - 1, 0);
  const nextStage = clampStage(idx);
  const endsAt = nowMs() + (DUR[nextStage] * 1000);
  await setRoomProps(roomId, { stage: nextStage, stageEndsAt: endsAt, inputLocked: false });
  return { stage: nextStage, stageEndsAt: endsAt };
}
async function extendStage(roomId, addSeconds = 120) {
  const room = await getRoom(roomId);
  if (!room) return null;
  const endsAt = (room.stageEndsAt || nowMs()) + (addSeconds * 1000);
  await setRoomProps(roomId, { stageEndsAt: endsAt });
  return { stage: room.stage, stageEndsAt: endsAt };
}

app.post('/rooms/:roomId/next', requireAuth, async (req, res) => {
  const st = await setStage(req.params.roomId, 'NEXT');
  res.json({ ok: true, ...st });
});
app.post('/rooms/:roomId/extend', requireAuth, async (req, res) => {
  const by = Number(req.body?.by || 120);
  const st = await extendStage(req.params.roomId, by);
  res.json({ ok: true, ...st });
});
app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  const st = await setStage(req.params.roomId, 'REDO');
  res.json({ ok: true, ...st });
});

/* ------------------------- GREET & ASK ------------------------------- */
app.post('/rooms/:roomId/welcome', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.stage || 'LOBBY';
    const msg = greetScript(room.topic);
    await postMessage({ roomId, authorType: 'asema', phase: stage, text: msg });
    res.json({ ok: true });
  } catch (e) {
    console.error('welcome error', e);
    res.status(500).json({ error: 'Failed to send welcome' });
  }
});

app.post('/rooms/:roomId/ask', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { text } = req.body || {};
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';

    const onTaskTerms = ['draft','abstract','character','theme','plot','idea','remind','recap','summary','topic','vote','deadline','timer'];
    const allowedTopics = ISSUES.map(s => s.toLowerCase());
    const isOnTopic = onTaskTerms.some(t => (text||'').toLowerCase().includes(t)) ||
      allowedTopics.some(t => (text||'').toLowerCase().includes(t)) ||
      (room.topic && (text||'').toLowerCase().includes(room.topic.toLowerCase()));

    let content;
    if (!isOnTopic) {
      content = `I can’t help with that one — let’s keep our focus on the session and "${room.topic || 'our chosen topic'}". What should we clarify for the abstract?`;
    } else {
      const sys = personaSystemPrompt(room.topic);
      const r = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.6,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `${text}` }
        ],
        max_tokens: 260
      });
      content = (r.choices?.[0]?.message?.content || '').trim() || `Here’s my quick take — what do you want to lock next?`;
    }

    await postMessage({ roomId, authorType: 'asema', phase: stage, text: content });
    res.json({ text: content });
  } catch (e) {
    console.error('ask error', e);
    res.status(500).json({ error: 'Failed to answer' });
  }
});

/* ------------------------- IDEAS (DEBOUNCED) ------------------------ */
app.post('/rooms/:roomId/ideas/trigger', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    scheduleDebounced(roomId, async () => {
      const room = await getRoom(roomId);
      if (!room) return;
      const stage = room.stage || 'LOBBY';
      if (!['DISCOVERY', 'IDEA_DUMP', 'PLANNING'].includes(stage)) return;

      const msgs = await listStageMessages(roomId, stage);
      const human = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

      const sys = personaSystemPrompt(room.topic);
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `Summarize key ideas so far as short bullets (themes, characters, conflicts, settings, constraints). Keep tight:\n\n${human}` }
        ],
        max_tokens: 260
      });
      const summary = (r.choices?.[0]?.message?.content || '').trim() || '- (no ideas captured yet)';

      await setRoomProps(roomId, {
        ideaSummary: summary,
        memoryNotes: Array.from(new Set([...(room.memoryNotes||[]),
          ...summary.split('\n').map(s => s.replace(/^[-•]\s?/, '').trim()).filter(Boolean)])),
      });

      await postMessage({ roomId, authorType: 'asema', phase: stage, text: `Snapshot of our ideas:\n${summary}` });
    }, 10_000, 30_000);

    res.json({ scheduled: true });
  } catch (e) {
    console.error('ideas/trigger error', e);
    res.status(500).json({ error: 'Failed to schedule summary' });
  }
});

/* ------------------------- ROUGH DRAFT (EXACT 250w) --------------- */
app.post('/rooms/:roomId/draft/generate', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { mode } = req.body || {}; // 'ask' | 'draft'
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';
    if (stage !== 'ROUGH_DRAFT') return res.status(400).json({ error: 'Not in rough draft stage' });

    if (mode === 'ask') {
      // First show draft, then follow-up questions (re-ordered per your request)
      const ds = await db.send(new QueryCommand({
        TableName: TABLES.drafts,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: marshall({ ':r': roomId }),
        ScanIndexForward: false,
        Limit: 1
      }));
      const latest = (ds.Items || []).map(unmarshall)[0];
      const follow = `What should we tighten or clarify? Think protagonist, goal, setting, conflict, and tone. Call me with “Asema, …” if you want a quick rewrite prompt.`;
      await postMessage({ roomId, authorType: 'asema', phase: 'ROUGH_DRAFT', text: follow });
      return res.json({ ok: true, asked: true, hadDraft: !!latest });
    }

    // Generate exactly 250 words from ideas + planning
    const ideas = room.ideaSummary || '';
    const planMsgs = await listStageMessages(roomId, 'PLANNING');
    const planText = planMsgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    const sys = personaSystemPrompt(room.topic);
    const prompt = [
      `Write a single, self-contained abstract of exactly 250 words (no headings, no bullet lists).`,
      `Be vivid, specific, and coherent. Do not exceed or fall short of 250 words.`,
      `Topic: ${room.topic || '(final topic will be set)'}\n`,
      `Ideas so far:\n${ideas}\n`,
      `Planning notes:\n${planText}\n`,
      `Return only the paragraph.`
    ].join('\n');

    const r = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.65,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500
    });

    let draft = (r.choices?.[0]?.message?.content || '').trim();
    draft = force250Words(draft);

    // Store & post
    await db.send(new PutItemCommand({
      TableName: TABLES.drafts,
      Item: marshall({ roomId, createdAt: Date.now(), version: 'rough', content: draft }),
    }));

    await postMessage({ roomId, authorType: 'asema', phase: 'ROUGH_DRAFT', text: `Here’s our rough draft:\n\n${draft}` });
    // Lock inputs briefly if you like; we leave input open per your note (it was stuck locked before)
    await setRoomProps(roomId, { inputLocked: false });

    res.json({ draft });
  } catch (e) {
    console.error('draft/generate error', e);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

/* ------------------------- FINAL FLOW ------------------------------ */
app.post('/rooms/:roomId/final/start', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const ds = await db.send(new QueryCommand({
      TableName: TABLES.drafts,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: marshall({ ':r': roomId }),
      ScanIndexForward: false,
      Limit: 1
    }));
    const rough = (ds.Items || []).map(unmarshall)[0]?.content || '(no rough draft yet)';

    const msg = `Let’s refine this draft. Suggest line edits or bigger changes. When satisfied, type **done** or **submit**:\n\n${rough}`;
    await postMessage({ roomId, authorType: 'asema', phase: 'FINAL', text: msg });
    await setRoomProps(roomId, { finalAwaiting: true, inputLocked: false, finalDoneUids: [] });

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

    const setU = new Set([...(room.finalDoneUids || [])]);
    setU.add(req.user.uid);
    await setRoomProps(roomId, { finalDoneUids: Array.from(setU) });

    res.json({ count: setU.size });
  } catch (e) {
    console.error('final/ready error', e);
    res.status(500).json({ error: 'Failed to register ready' });
  }
});

app.post('/rooms/:roomId/final/complete', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const finalMsgs = await listStageMessages(roomId, 'FINAL');
    const edits = finalMsgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    const ds = await db.send(new QueryCommand({
      TableName: TABLES.drafts,
      KeyConditionExpression: 'roomId = :r',
      ExpressionAttributeValues: marshall({ ':r': roomId }),
      ScanIndexForward: false,
      Limit: 1
    }));
    const rough = (ds.Items || []).map(unmarshall)[0]?.content || '';

    const sys = personaSystemPrompt(room.topic);
    const prompt = [
      `Integrate the following team edits into the rough draft to produce an exact 250-word final abstract.`,
      `Return exactly 250 words; no headings.\n\nRough:\n${rough}\n\nEdits:\n${edits}`
    ].join('\n');

    const r = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.55,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500
    });

    let finalText = (r.choices?.[0]?.message?.content || '').trim();
    finalText = force250Words(finalText);

    // store final
    await db.send(new PutItemCommand({
      TableName: TABLES.drafts,
      Item: marshall({ roomId, createdAt: Date.now(), version: 'final', content: finalText }),
    }));

    await postMessage({ roomId, authorType: 'asema', phase: 'FINAL', text: `✨ Final draft ready. Submitting to your presenter now.` });
    await setRoomProps(roomId, { submittedFinal: true, inputLocked: true });

    // queue submission
    await db.send(new PutItemCommand({
      TableName: TABLES.submissions,
      Item: marshall({ roomId, siteId: room.siteId, createdAt: Date.now(), finalText }),
    }));

    res.json({ final: finalText });
  } catch (e) {
    console.error('final/complete error', e);
    res.status(500).json({ error: 'Failed to finalize' });
  }
});

/* ------------------------- VOTING (DISCOVERY) ---------------------- */
/**
 * Room.voting shape:
 * {
 *   open: boolean,
 *   options: [{ n, text }], // 1..5 based on ISSUES; can be customized
 *   votesByUid: { [uid]: n },
 *   lockedAt: number,
 *   chosen: { n, text } | null
 * }
 */
app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  const room = await getRoom(req.params.roomId);
  return res.json({ vote: room?.voting || null });
});

app.post('/rooms/:roomId/vote/start', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const room = await getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.stage !== 'DISCOVERY') return res.status(400).json({ error: 'Voting only allowed in DISCOVERY' });

  const options = ISSUES.map((t, idx) => ({ n: idx + 1, text: t }));
  await setRoomProps(roomId, { voting: { open: true, options, votesByUid: {}, lockedAt: 0, chosen: null } });
  await postMessage({ roomId, authorType: 'asema', phase: 'DISCOVERY', text: `Voting is open. Choose a topic by number: ${options.map(o => `${o.n}=${o.text}`).join(' · ')}` });
  res.json({ ok: true, options });
});

app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const { choice } = req.body || {};
  const room = await getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const v = room.voting || {};
  if (!v.open) return res.status(400).json({ error: 'Voting is not open' });
  const valid = (v.options || []).some(o => o.n === Number(choice));
  if (!valid) return res.status(400).json({ error: 'Invalid option' });

  const votesByUid = { ...(v.votesByUid || {}) };
  votesByUid[req.user.uid] = Number(choice);

  await setRoomProps(roomId, { voting: { ...v, votesByUid } });
  res.json({ ok: true, choice: Number(choice) });
});

app.post('/rooms/:roomId/vote/close', requireAuth, async (req, res) => {
  const roomId = req.params.roomId;
  const room = await getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const v = room.voting || {};
  if (!v.open) return res.status(400).json({ error: 'Voting is already closed' });

  // Tally
  const counts = new Map();
  for (const n of Object.values(v.votesByUid || {})) {
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let winner = null;
  for (const opt of v.options || []) {
    const c = counts.get(opt.n) || 0;
    if (!winner || c > winner.count) winner = { ...opt, count: c };
  }
  const chosen = winner ? { n: winner.n, text: winner.text } : (v.options || [])[0] || null;

  await setRoomProps(roomId, { topic: chosen?.text || room.topic, voting: { ...v, open: false, lockedAt: nowMs(), chosen } });
  await postMessage({ roomId, authorType: 'asema', phase: 'DISCOVERY', text: `Topic locked: **${chosen?.text || room.topic}**. Capture your best angles; we move to idea dump next.` });

  res.json({ ok: true, chosen });
});

/* ------------------------- 404 LAST ------------------------------- */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

/* ------------------------- LISTEN ------------------------------- */
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
