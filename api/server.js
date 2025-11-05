// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
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
  ScanCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';

/* =========================
   Env & Clients
========================= */
const {
  PORT = 4000,
  OPENAI_API_KEY,
  AWS_REGION = 'us-west-2',

  // Table names (must match what you created)
  DDB_TABLE_SITES = 'storibloom_sites',
  DDB_TABLE_ROOMS = 'storibloom_rooms',
  DDB_TABLE_CODES = 'storibloom_codes',
  DDB_TABLE_MESSAGES = 'storibloom_messages',
  DDB_TABLE_DRAFTS = 'storibloom_drafts',
  DDB_TABLE_SUBMISSIONS = 'storibloom_submissions',
  DDB_TABLE_PERSONAS = 'storibloom_personas',
  DDB_TABLE_SESSIONS = 'storibloom_sessions',
  DDB_TABLE_VOTES = 'storibloom_votes',

  // CORS
  CORS_ORIGIN = 'http://localhost:5173'
} = process.env;

if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set. Asema routes will fail until you set it.');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ddb = new DynamoDBClient({ region: AWS_REGION });
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true }
});

/* =========================
   App & Middleware
========================= */
const app = express();
app.use(cors({
  origin: CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-role']
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* =========================
   Helpers & Constants
========================= */
const ORDER = ['LOBBY', 'DISCOVERY', 'IDEA_DUMP', 'PLANNING', 'ROUGH_DRAFT', 'EDITING', 'FINAL'];
const ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap'
];

function nowMs() { return Date.now(); }

function wordCount(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean).length;
}
function trimToWords(str, n) {
  const parts = (str || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, n).join(' ');
}

/** Enforce EXACT 250 words:
 *  1) Ask model to output exactly 250 words (strong instruction)
 *  2) If off, retry once with stricter instruction
 *  3) If still off, trim to 250 words (never returns > 250)
 */
async function generateExact250({ system, user }, retry = true) {
  const promptMsg = [
    { role: 'system', content: `${system}\n\nIMPORTANT: Output must be EXACTLY 250 words. No intro/outro lines. No titles.` },
    { role: 'user', content: `${user}\n\nReturn exactly 250 words. If you exceed, you will be truncated.` }
  ];
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.65,
    messages: promptMsg,
    max_tokens: 600
  });
  let text = r.choices?.[0]?.message?.content?.trim() || '';
  const wc = wordCount(text);
  if (wc === 250) return text;

  if (retry) {
    const r2 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: `${system}\n\nCRITICAL: EXACTLY 250 WORDS. If not exactly 250, your previous attempt will be truncated.` },
        { role: 'user', content: user }
      ],
      max_tokens: 600
    });
    text = r2.choices?.[0]?.message?.content?.trim() || '';
    if (wordCount(text) === 250) return text;
  }
  // Fallback: trim to 250 words
  return trimToWords(text, 250);
}

/** Persona prompt */
function personaSystemPrompt({ roomTopic }) {
  return `You are **Asema**, a modern, warm, witty African American woman in her early 30s—think: upbeat game-show host meets facilitator. You help teams write a sharp, collaborative 250-word abstract about "${roomTopic || 'one of the five community issues'}".

Rules:
- Be concise, natural, human, and encouraging.
- Stay on-topic. If off-topic, politely redirect to the session and listed issues.
- Avoid repeating greetings or instructions you've already given in this stage.
- Use short paragraphs or bullets when appropriate.
- Never include profanity or personal data.
- If the user asks for a reminder, quickly summarize current ideas captured.
- Keep momentum high; offer light guidance, not essays.`;
}

/* Dynamo helpers */
async function getRoom(roomId) {
  const g = await doc.send(new GetCommand({
    TableName: DDB_TABLE_ROOMS, Key: { roomId }
  }));
  return g.Item || null;
}
async function putRoom(room) {
  await doc.send(new PutCommand({ TableName: DDB_TABLE_ROOMS, Item: room }));
}
async function updateRoom(roomId, updateExpr, exprAttrValues, exprAttrNames) {
  await doc.send(new UpdateCommand({
    TableName: DDB_TABLE_ROOMS,
    Key: { roomId },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: exprAttrValues,
    ExpressionAttributeNames: exprAttrNames
  }));
}
async function addMessage({ roomId, uid = null, personaIndex = -1, authorType = 'user', phase, text }) {
  await doc.send(new PutCommand({
    TableName: DDB_TABLE_MESSAGES,
    Item: {
      roomId,
      createdAt: nowMs(),
      phase,
      uid,
      personaIndex,
      authorType,
      text
    }
  }));
}
async function queryMessagesByPhase(roomId, phase) {
  // Query the base table by PK, then client-filter by phase (simplest),
  // or if you created the GSI byRoomPhase, use it here:
  // Using GSI "byRoomPhase":
  const q = await doc.send(new QueryCommand({
    TableName: DDB_TABLE_MESSAGES,
    IndexName: 'byRoomPhase',
    KeyConditionExpression: 'roomId = :rid AND #phase = :ph',
    ExpressionAttributeValues: { ':rid': roomId, ':ph': phase },
    ExpressionAttributeNames: { '#phase': 'phase' },
    ScanIndexForward: true
  }));
  return q.Items || [];
}
async function addDraft({ roomId, content, version }) {
  await doc.send(new PutCommand({
    TableName: DDB_TABLE_DRAFTS,
    Item: {
      roomId,
      createdAt: nowMs(),
      content,
      version
    }
  }));
}
async function getLatestDraft(roomId) {
  const q = await doc.send(new QueryCommand({
    TableName: DDB_TABLE_DRAFTS,
    KeyConditionExpression: 'roomId = :rid',
    ExpressionAttributeValues: { ':rid': roomId },
    ScanIndexForward: false, // newest first
    Limit: 1
  }));
  return q.Items?.[0] || null;
}
async function addSubmission({ roomId, siteId, finalText }) {
  await doc.send(new PutCommand({
    TableName: DDB_TABLE_SUBMISSIONS,
    Item: { roomId, siteId, finalText, createdAt: nowMs() }
  }));
}

/* Auth-ish helpers (simple header scheme) */
function requireUser(req, res, next) {
  const uid = req.header('x-user-id')?.trim();
  if (!uid) return res.status(401).json({ error: 'Missing x-user-id' });
  req.uid = uid;
  next();
}
function requirePresenter(req, res, next) {
  const role = (req.header('x-role') || '').toUpperCase();
  if (role !== 'PRESENTER') return res.status(403).json({ error: 'Presenter only' });
  next();
}

/* Debouncer (per room) for idea summaries */
class DebounceWorker {
  constructor({ delayMs = 10_000, maxWaitMs = 30_000, runFn }) {
    this.delayMs = delayMs; this.maxWaitMs = maxWaitMs; this.runFn = runFn;
    this.map = new Map(); // roomId -> {timer, firstAt}
  }
  trigger(roomId) {
    const entry = this.map.get(roomId) || { timer: null, firstAt: Date.now() };
    if (!entry.firstAt) entry.firstAt = Date.now();
    if (entry.timer) clearTimeout(entry.timer);

    const wait = this.delayMs;
    const elapsed = Date.now() - entry.firstAt;
    const remaining = Math.max(0, this.maxWaitMs - elapsed);
    const fireIn = Math.min(wait, remaining);

    entry.timer = setTimeout(async () => {
      try {
        await this.runFn(roomId);
      } catch (e) {
        console.error('[DebounceWorker] runFn error for', roomId, e);
      } finally {
        this.map.delete(roomId);
      }
    }, fireIn);
    this.map.set(roomId, entry);
  }
}
const ideaDebouncer = new DebounceWorker({
  delayMs: 10_000,
  maxWaitMs: 30_000,
  runFn: summarizeIdeas // defined below
});

/* =========================
   Health
========================= */
app.get('/', (_req, res) => res.send('StoriBloom API (DynamoDB) ✅'));

/* =========================
   Codes: consume (LOGIN)
   Body: { code: "U-xxxx" }
   Returns: { siteId, role, roomId? } — room assignment is client-side or separate.
========================= */
app.post('/codes/consume', requireUser, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    // find code
    const scan = await doc.send(new ScanCommand({
      TableName: DDB_TABLE_CODES,
      FilterExpression: '#c = :cv',
      ExpressionAttributeNames: { '#c': 'code' },
      ExpressionAttributeValues: { ':cv': code }
    }));
    const item = scan.Items?.[0];
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });
    if (item.consumed) return res.status(400).json({ error: 'Code already used' });

    await doc.send(new UpdateCommand({
      TableName: DDB_TABLE_CODES,
      Key: { code: item.code },
      UpdateExpression: 'SET consumed = :t, usedByUid = :u, consumedAt = :ts',
      ExpressionAttributeValues: { ':t': true, ':u': req.uid, ':ts': nowMs() }
    }));

    res.json({ siteId: item.siteId, role: item.role });
  } catch (e) {
    console.error('consume error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================
   Presenter controls
========================= */
app.post('/rooms/:roomId/next', requireUser, requirePresenter, async (req, res) => {
  const room = await getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const idx = ORDER.indexOf(room.stage || 'LOBBY');
  const nextStage = ORDER[Math.min(ORDER.length - 1, idx + 1)];
  await updateRoom(req.params.roomId,
    'SET #stage = :s, #stageEndsAt = :e, inputLocked = :f',
    { ':s': nextStage, ':e': nowMs() + 60_000, ':f': false },
    { '#stage': 'stage', '#stageEndsAt': 'stageEndsAt' }
  );
  res.json({ ok: true, to: nextStage });
});

app.post('/rooms/:roomId/extend', requireUser, requirePresenter, async (req, res) => {
  const extraSec = Number(req.body?.by || 120);
  const room = await getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const newEnd = (room.stageEndsAt || nowMs()) + (extraSec * 1000);
  await updateRoom(req.params.roomId,
    'SET #stageEndsAt = :e',
    { ':e': newEnd },
    { '#stageEndsAt': 'stageEndsAt' }
  );
  res.json({ ok: true, stageEndsAt: newEnd });
});

app.post('/rooms/:roomId/redo', requireUser, requirePresenter, async (req, res) => {
  const room = await getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  // redo = simply go back one stage (min LOBBY)
  const idx = Math.max(0, (ORDER.indexOf(room.stage || 'LOBBY') - 1));
  const to = ORDER[idx];
  await updateRoom(req.params.roomId,
    'SET #stage = :s, inputLocked = :f',
    { ':s': to, ':f': false },
    { '#stage': 'stage' }
  );
  res.json({ ok: true, to });
});

/* =========================
   Asema: greet, on-mention (ask), idea summarize (debounced)
========================= */
async function postAsema(roomId, stage, text) {
  await addMessage({ roomId, phase: stage, authorType: 'asema', text });
}

function greetScript(topic) {
  const base =
    `Welcome to StoriBloom.AI — I’m Asema, your host! We’ll collaborate to craft a crisp 250-word abstract.\n` +
    `Today’s focus: ${topic || 'one of the five community issues'}. We’ll move in short phases to keep energy high.\n` +
    `Tip: Mention “Asema” if you want my help or a quick recap at any time. Let’s begin!`;
  return base;
}

app.post('/rooms/:roomId/welcome', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // Avoid repeating greeting in the same stage
    const stage = room.stage || 'LOBBY';
    const greetedKey = `greeted_${stage}`;
    if (room[greetedKey]) {
      return res.json({ ok: true, skipped: true });
    }

    const intro = greetScript(room.topic);
    await postAsema(req.params.roomId, stage, intro);

    await updateRoom(req.params.roomId,
      `SET #g = :t`,
      { ':t': true },
      { '#g': greetedKey }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('welcome error', e);
    res.status(500).json({ error: 'Failed to send welcome' });
  }
});

app.post('/rooms/:roomId/ask', requireUser, async (req, res) => {
  try {
    const { text = '' } = req.body || {};
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';

    // on-topic gate
    const lower = text.toLowerCase();
    const onTask =
      ISSUES.some(i => lower.includes(i.toLowerCase())) ||
      /(draft|abstract|character|theme|plot|idea|remind|recap|summary|topic|vote)/i.test(text);

    const system = personaSystemPrompt({ roomTopic: room.topic });
    const memoryLines = Array.isArray(room.memoryNotes) ? room.memoryNotes : [];

    const userMsg = onTask
      ? `Room memory (bullets):\n- ${memoryLines.join('\n- ')}\n\nUser: ${text}\nAnswer briefly, naturally, and keep us moving.`
      : `User: ${text}\nPolitely decline and steer back to the topic and the session flow.`;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg }
      ],
      max_tokens: 220
    });
    const answer = r.choices?.[0]?.message?.content?.trim() || `Let’s stay focused on our abstract. How can I help with the ${room.topic || 'topic'}?`;

    await postAsema(req.params.roomId, stage, answer);
    res.json({ text: answer });
  } catch (e) {
    console.error('ask error', e);
    res.status(500).json({ error: 'Failed to answer' });
  }
});

/* Debounced summarize trigger (client calls this while typing) */
app.post('/rooms/:roomId/ideas/trigger', requireUser, async (req, res) => {
  try {
    ideaDebouncer.trigger(req.params.roomId);
    res.json({ scheduled: true });
  } catch (e) {
    console.error('ideas/trigger error', e);
    res.status(500).json({ error: 'Failed to schedule summary' });
  }
});

/* Summarizer implementation */
async function summarizeIdeas(roomId) {
  // Summarize DISCOVERY/IDEA_DUMP messages as bullets + store into room.ideaSummary and memoryNotes
  const room = await getRoom(roomId);
  if (!room) throw new Error('room not found');
  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') return;

  const msgs = await queryMessagesByPhase(roomId, stage);
  const human = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');
  if (!human.trim()) return;

  const system = personaSystemPrompt({ roomTopic: room.topic });
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Summarize key ideas so far as short bullets (themes, characters, conflicts, settings, constraints). Keep it tight.\n\n${human}` }
    ],
    max_tokens: 260
  });
  const summary = r.choices?.[0]?.message?.content?.trim() || '- (no ideas captured yet)';

  const newMemory = Array.from(new Set([
    ...(room.memoryNotes || []),
    ...summary.split('\n').map(s => s.replace(/^[-•]\s?/, '').trim()).filter(Boolean)
  ]));

  await updateRoom(roomId,
    'SET ideaSummary = :s, memoryNotes = :m',
    { ':s': summary, ':m': newMemory }
  );
  await postAsema(roomId, stage, `Here’s a quick snapshot of our ideas so far:\n${summary}`);
}

/* =========================
   Rough Draft & Final
========================= */
// NOTE: Fix requested — show rough draft first, THEN ask questions. Never leave input locked throughout RD.
app.post('/rooms/:roomId/draft/generate', requireUser, async (req, res) => {
  try {
    const { mode } = req.body || {}; // 'draft'|'ask'
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'LOBBY';
    if (stage !== 'ROUGH_DRAFT') return res.status(400).json({ error: 'Not in ROUGH_DRAFT' });

    const system = personaSystemPrompt({ roomTopic: room.topic });

    if (mode === 'draft') {
      // Build context from ideaSummary + any planning notes (messages in PLANNING)
      const planning = await queryMessagesByPhase(req.params.roomId, 'PLANNING');
      const planText = planning.filter(m => m.authorType === 'user').map(m => m.text).join('\n');
      const ideas = room.ideaSummary || '';

      const user = `Using the team's notes below, produce a vivid, tight abstract of EXACTLY 250 words.\n` +
                   `Avoid numbered lists. Keep it concise but compelling. No meta-comments.\n\n` +
                   `Ideas so far:\n${ideas}\n\nPlan notes:\n${planText}`;

      const draft = await generateExact250({ system, user }, true);
      await addDraft({ roomId: req.params.roomId, content: draft, version: 'rough' });
      await postAsema(req.params.roomId, stage, `Here’s a **rough draft** (250 words):\n\n${draft}`);

      // Make sure input is OPEN for follow-ups
      await updateRoom(req.params.roomId, 'SET inputLocked = :f', { ':f': false });

      // Ask 2–3 follow-ups only once per room in ROUGH_DRAFT
      if (!room.askedRoughQs) {
        const r = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.6,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: 'Ask 2–3 crisp, non-redundant questions to refine the rough draft (e.g., protagonist clarity, stakes, tone). Keep it short.' }
          ],
          max_tokens: 140
        });
        const qs = r.choices?.[0]?.message?.content?.trim() || 'Any final tweaks to protagonist, stakes, or tone?';
        await postAsema(req.params.roomId, stage, qs);
        await updateRoom(req.params.roomId, 'SET askedRoughQs = :t', { ':t': true });
      }

      return res.json({ draft });
    }

    // mode === 'ask' — allow on-demand nudges (but honor askedRoughQs to prevent spam)
    if (!room.askedRoughQs) {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'Ask 2–3 crisp, non-redundant questions to refine the rough draft (e.g., protagonist clarity, stakes, tone). Keep it short.' }
        ],
        max_tokens: 140
      });
      const qs = r.choices?.[0]?.message?.content?.trim() || 'Any final tweaks to protagonist, stakes, or tone?';
      await postAsema(req.params.roomId, stage, qs);
      await updateRoom(req.params.roomId, 'SET askedRoughQs = :t', { ':t': true });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('draft/generate error', e);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

app.post('/rooms/:roomId/final/start', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.stage || 'FINAL';
    const latest = await getLatestDraft(req.params.roomId);
    const rough = latest?.content || '(no rough draft)';

    await postAsema(req.params.roomId, stage,
      `Starting from this rough draft — suggest line edits or bigger changes. When satisfied, everyone type **done** or **submit**:\n\n${rough}`
    );
    await updateRoom(req.params.roomId,
      'SET finalAwaiting = :t, inputLocked = :f, finalDoneUids = :arr',
      { ':t': true, ':f': false, ':arr': [] }
    );
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
    const current = new Set([...(room.finalDoneUids || [])]);
    current.add(req.uid);
    await updateRoom(req.params.roomId, 'SET finalDoneUids = :arr', { ':arr': Array.from(current) });
    res.json({ count: current.size });
  } catch (e) {
    console.error('final/ready error', e);
    res.status(500).json({ error: 'Failed to register ready' });
  }
});

app.post('/rooms/:roomId/final/complete', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.stage || 'FINAL';

    // Gather FINAL stage edits from users
    const editsMsgs = await queryMessagesByPhase(req.params.roomId, stage);
    const edits = editsMsgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    const latest = await getLatestDraft(req.params.roomId);
    const rough = latest?.content || '';

    const system = personaSystemPrompt({ roomTopic: room.topic });
    const finalText = await generateExact250({
      system,
      user: `Apply the following team edits to produce the final abstract of EXACTLY 250 words.\n\nRough draft:\n${rough}\n\nEdits:\n${edits}\n\nReturn exactly 250 words, no preface, no title.`
    }, true);

    await addDraft({ roomId: req.params.roomId, content: finalText, version: 'final' });
    await postAsema(req.params.roomId, stage, `✨ Final draft ready. Great work team! I’m submitting this to your presenter now.`);
    await updateRoom(req.params.roomId, 'SET submittedFinal = :t, inputLocked = :t', { ':t': true });
    await addSubmission({ roomId: req.params.roomId, siteId: room.siteId, finalText });

    res.json({ final: finalText });
  } catch (e) {
    console.error('final/complete error', e);
    res.status(500).json({ error: 'Failed to finalize' });
  }
});

/* =========================
   Voting (DISCOVERY)
========================= */
// Start voting — Asema announces numeric choices; clears prior votes; locks topic after close.
app.post('/rooms/:roomId/vote/start', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if ((room.stage || 'LOBBY') !== 'DISCOVERY') {
      return res.status(400).json({ error: 'Voting only in DISCOVERY stage' });
    }

    // Mark voteOpen true and options = ISSUES
    await updateRoom(req.params.roomId,
      'SET voteOpen = :t, voteOptions = :opts',
      { ':t': true, ':opts': ISSUES }
    );

    // Clear any previous votes in this room (best-effort: scan & batch delete would be needed; for simplicity we just overwrite later)
    await postAsema(req.params.roomId, 'DISCOVERY',
      `Ready to vote? Reply with a number:\n` +
      ISSUES.map((s, i) => `${i + 1}. ${s}`).join('\n') +
      `\n\nYou can vote **once**. When everyone’s in, I’ll lock the topic.`
    );
    res.json({ ok: true, options: ISSUES });
  } catch (e) {
    console.error('vote/start error', e);
    res.status(500).json({ error: 'Failed to start voting' });
  }
});

// Submit a vote: body { choice: 1..5 }
app.post('/rooms/:roomId/vote/submit', requireUser, async (req, res) => {
  try {
    const { choice } = req.body || {};
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    if (!room.voteOpen) return res.status(400).json({ error: 'Voting is closed' });
    if (!Number.isInteger(choice) || choice < 1 || choice > ISSUES.length) {
      return res.status(400).json({ error: 'Invalid choice' });
    }

    // Store/overwrite vote per uid
    await doc.send(new PutCommand({
      TableName: DDB_TABLE_VOTES,
      Item: {
        roomId: req.params.roomId,
        uid: req.uid,
        choice,
        createdAt: nowMs()
      }
    }));

    res.json({ ok: true });
  } catch (e) {
    console.error('vote/submit error', e);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

app.post('/rooms/:roomId/vote/close', requireUser, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // Tally votes via GSI byRoomChoice (or scan+filter if needed)
    const tallies = [];
    for (let i = 1; i <= ISSUES.length; i++) {
      const q = await doc.send(new QueryCommand({
        TableName: DDB_TABLE_VOTES,
        IndexName: 'byRoomChoice',
        KeyConditionExpression: 'roomId = :rid AND choice = :c',
        ExpressionAttributeValues: { ':rid': roomId, ':c': i }
      }));
      tallies[i] = (q.Items || []).length;
    }
    // Find winner
    let max = -1, winnerIndex = 1;
    for (let i = 1; i <= ISSUES.length; i++) {
      if (tallies[i] > max) { max = tallies[i]; winnerIndex = i; }
    }
    const topic = ISSUES[winnerIndex - 1];

    await updateRoom(roomId,
      'SET voteOpen = :f, topic = :t',
      { ':f': false, ':t': topic }
    );

    await postAsema(roomId, 'DISCOVERY', `Locked — our topic is **${topic}**. Let’s capture key ideas, then move to planning!`);
    res.json({ ok: true, topic, tallies: tallies.slice(1) });
  } catch (e) {
    console.error('vote/close error', e);
    res.status(500).json({ error: 'Failed to close vote' });
  }
});

// HUD
app.get('/rooms/:roomId/vote', requireUser, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({
      voteOpen: !!room.voteOpen,
      options: ISSUES,
      topic: room.topic || null
    });
  } catch (e) {
    console.error('vote status error', e);
    res.status(500).json({ error: 'Failed to fetch vote status' });
  }
});

/* =========================
   Utility: write user message (for your client)
========================= */
app.post('/rooms/:roomId/message', requireUser, async (req, res) => {
  try {
    const { text = '', phase = 'LOBBY', personaIndex = 0 } = req.body || {};
    if (!text.trim()) return res.status(400).json({ error: 'Empty message' });
    // Respect inputLocked (except FINAL where we allow "done/submit")
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const locked = !!room.inputLocked && phase !== 'FINAL';
    if (locked) return res.status(423).json({ error: 'Input locked' });

    await addMessage({
      roomId: req.params.roomId,
      uid: req.uid,
      personaIndex,
      authorType: 'user',
      phase,
      text
    });

    // Triggers
    if (/(^|\s)asema[\s,!?]/i.test(text) || /^asema$/i.test(text)) {
      // fire & forget
      (async () => {
        try {
          const r = await fetch(`http://localhost:${PORT}/rooms/${req.params.roomId}/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': req.uid },
            body: JSON.stringify({ text })
          });
          await r.json().catch(()=>{});
        } catch {}
      })();
    }
    if (phase === 'DISCOVERY' || phase === 'IDEA_DUMP') {
      ideaDebouncer.trigger(req.params.roomId);
    }
    if (phase === 'FINAL' && /^(done|submit)\b/i.test(text.trim())) {
      // fire & forget
      (async () => {
        try {
          await fetch(`http://localhost:${PORT}/rooms/${req.params.roomId}/final/ready`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': req.uid }
          });
        } catch {}
      })();
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('message error', e);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

/* =========================
   Start
========================= */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
