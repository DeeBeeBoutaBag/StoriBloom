import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db, auth } from './firebaseAdmin.js';
import { openai } from './openaiClient.js';
import { setStage, extendStage, startStageLoop } from './stageEngine.js';
import { DebounceWorker } from './debounceWorker.js';
import { summarizeIdeas } from './ideaSummarizer.js';
import {
  personaSystemPrompt,
  greetScript,
  stageGreeting,
  ISSUES,
  votingMenuText,
  acknowledgeVoteText,
  votingAlreadyOpenText,
  votingNotOpenText,
  votingClosedText,
  invalidVoteText
} from './asemaPersona.js';

const app = express();

/* Debouncer: summarize at most once every 10s (max wait 30s) per room */
const ideaDebouncer = new DebounceWorker({
  runFn: (roomId) => summarizeIdeas({ db, openai }, roomId),
  delayMs: 10_000,
  maxWaitMs: 30_000
});

/* CORS & JSON */
const allowedOrigins = [
  process.env.WEB_ORIGIN || 'http://localhost:5173'
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));

/* Request logger */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* Auth */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    req.user = await auth.verifyIdToken(token);
    next();
  } catch (e) {
    console.error('Auth error:', e?.message || e);
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* Health */
app.get('/', (_req, res) => res.send('AsemaCollab API running ✅'));
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* Helpers */
async function getRoom(roomId) {
  const ref = db.collection('rooms').doc(roomId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  return { ref, data: doc.data() };
}

async function postAsema(roomId, stage, text) {
  await db.collection('rooms').doc(roomId).collection('messages').add({
    uid: null,
    personaIndex: -1,
    authorType: 'asema',
    phase: stage,
    text,
    createdAt: new Date(),
  });
}

async function getStageMessages(roomId, stage) {
  const snap = await db
    .collection('rooms').doc(roomId)
    .collection('messages')
    .where('phase', '==', stage)
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map(d => d.data());
}

function msLeftToSeconds(endsAtField) {
  const ends =
    endsAtField?.toDate?.() ? endsAtField.toDate() :
    endsAtField instanceof Date ? endsAtField : null;
  if (!ends) return undefined;
  return Math.max(0, Math.floor((ends.getTime() - Date.now()) / 1000));
}

async function safeOpenAI(opts) {
  try {
    const r = await openai.chat.completions.create(opts);
    return r.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('[OpenAI] error', e?.message || e);
    return '';
  }
}

async function enforceExactWordCount({ text, target = 250, system }) {
  const count = text.trim().split(/\s+/).filter(Boolean).length;
  if (count === target) return text;

  const fix = await safeOpenAI({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 500,
    messages: [
      { role: 'system', content: system || 'Make precise editorial adjustments.' },
      {
        role: 'user',
        content:
          `Rewrite the following to be **exactly ${target} words**, preserving meaning and clarity. ` +
          `Plain text only; no headings, no quotes, no numbering:\n\n${text}`
      }
    ]
  });
  const fixed = fix?.trim() || text;
  const recount = fixed.trim().split(/\s+/).filter(Boolean).length;
  if (recount === target) return fixed;

  if (recount > target) {
    const words = fixed.trim().split(/\s+/).slice(0, target);
    return words.join(' ');
  } else {
    const deficit = target - recount;
    const pad = ' ' + ('This concluding line reinforces the piece’s central tension and resolution.'
      .split(/\s+/).slice(0, Math.min(deficit, 15)).join(' '));
    const merged = (fixed + pad).trim();
    const words2 = merged.split(/\s+/).slice(0, target);
    return words2.join(' ');
  }
}

/* Codes: consume (LOGIN) */
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const snap = await db.collection('codes')
      .where('value', '==', code)
      .limit(1).get();

    if (snap.empty) return res.status(404).json({ error: 'Code not found or invalid' });
    const doc = snap.docs[0];
    const data = doc.data();
    if (data.consumed) return res.status(400).json({ error: 'Code already used' });

    await doc.ref.update({
      consumed: true,
      usedByUid: req.user.uid,
      consumedAt: new Date(),
    });

    return res.json({ siteId: data.siteId, role: data.role });
  } catch (err) {
    console.error('consume error:', err);
    return res.status(500).json({ error: 'Something went wrong redeeming that code.' });
  }
});

/* Topic set/get */
app.post('/rooms/:roomId/topic', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { topic } = req.body || {};
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const norm = String(topic || '').trim();
    const match = ISSUES.find(i => i.toLowerCase() === norm.toLowerCase());
    if (!match) return res.status(400).json({ error: 'Invalid topic', allowed: ISSUES });

    if (room.data.topic !== match) {
      await room.ref.update({ topic: match });
      const stage = room.data.stage || 'LOBBY';
      const secondsLeft = msLeftToSeconds(room.data.stageEndsAt);
      await postAsema(roomId, stage, `✅ Topic locked: **${match}** — I’ll tailor guidance to this theme.`);
      if (room.data.lastGreetStage !== stage) {
        const g = stageGreeting(stage, { roomTopic: match, secondsLeft });
        await postAsema(roomId, stage, g);
        await room.ref.update({ lastGreetStage: stage });
      }
    }
    res.json({ ok: true, topic: match });
  } catch (e) {
    console.error('topic set error', e);
    res.status(500).json({ error: 'Unable to set topic right now.' });
  }
});

app.get('/rooms/:roomId/topic', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ topic: room.data.topic || null, allowed: ISSUES });
  } catch (e) {
    console.error('topic get error', e);
    res.status(500).json({ error: 'Unable to fetch topic right now.' });
  }
});

/* Presenter controls */
app.post('/rooms/:roomId/next', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    await setStage(roomId, 'NEXT');
    const room = await getRoom(roomId);
    if (room) {
      const { stage, topic, stageEndsAt, lastGreetStage } = room.data;
      await room.ref.update({ inputLocked: stage === 'ROUGH_DRAFT' });
      if (lastGreetStage !== stage) {
        const greet = stageGreeting(stage, { roomTopic: topic, secondsLeft: msLeftToSeconds(stageEndsAt) });
        await postAsema(roomId, stage, greet);
        await room.ref.update({ lastGreetStage: stage });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('next error:', e);
    res.status(500).json({ error: 'Couldn’t advance the stage just now.' });
  }
});

app.post('/rooms/:roomId/extend', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const minutes = Number(req.body?.by || 120) / 60;
    await extendStage(roomId, minutes);
    const room = await getRoom(roomId);
    if (room) {
      const { stage } = room.data;
      await postAsema(roomId, stage, `⏱️ I’ve added **${Math.round(minutes)} min** — keep rolling!`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('extend error:', e);
    res.status(500).json({ error: 'Couldn’t extend the timer.' });
  }
});

app.post('/rooms/:roomId/redo', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    await setStage(roomId, 'REDO');
    const room = await getRoom(roomId);
    if (room) {
      const { stage, topic, stageEndsAt, lastGreetStage } = room.data;
      await room.ref.update({ inputLocked: stage === 'ROUGH_DRAFT' });
      if (lastGreetStage !== stage) {
        const greet = stageGreeting(stage, { roomTopic: topic, secondsLeft: msLeftToSeconds(stageEndsAt) });
        await postAsema(roomId, stage, greet);
        await room.ref.update({ lastGreetStage: stage });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('redo error:', e);
    res.status(500).json({ error: 'Couldn’t redo that stage.' });
  }
});

/* Welcome */
app.post('/rooms/:roomId/welcome', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const stage = room.data.stage || 'LOBBY';
    if (room.data.welcomedAt) return res.json({ ok: true, alreadyWelcomed: true });
    const intro = greetScript({ roomTopic: room.data.topic });
    await postAsema(req.params.roomId, stage, intro);
    await room.ref.update({ welcomedAt: new Date() });
    res.json({ ok: true });
  } catch (e) {
    console.error('welcome error', e);
    res.status(500).json({ error: 'Couldn’t send the welcome just now.' });
  }
});

/* Mention handler (“Asema, …”) */
app.post('/rooms/:roomId/ask', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { text } = req.body || {};
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.data.stage || 'LOBBY';
    const system = personaSystemPrompt({ roomTopic: room.data.topic });
    const memory = room.data.memoryNotes || [];

    const allowedTopics = ISSUES.map(s => s.toLowerCase());
    const onTask =
      allowedTopics.some(t => (text || '').toLowerCase().includes(t)) ||
      /(draft|abstract|character|theme|plot|idea|remind|recap|what did we say|summary|final|edit|rough|vote|topic)/i.test(text || '');

    const userPrompt = onTask
      ? `Room memory (bullets):\n- ${memory.join('\n- ')}\n\nUser asks: ${text}\nAnswer briefly, warmly, and on-topic.`
      : `Say (warmly) you can’t answer that and redirect back to the activity and topics: ${ISSUES.join(', ')}.`;

    const reply = await safeOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ]
    });

    const answer = reply?.trim() || `Let’s keep it on the story task. Which part should we tackle next?`;
    await postAsema(roomId, stage, answer);
    res.json({ text: answer });
  } catch (e) {
    console.error('ask error', e);
    res.status(500).json({ error: 'I couldn’t answer that just now — try again in a moment.' });
  }
});

/* Debounced ideas trigger */
app.post('/rooms/:roomId/ideas/trigger', requireAuth, async (req, res) => {
  try {
    ideaDebouncer.trigger(req.params.roomId);
    res.json({ scheduled: true });
  } catch (e) {
    console.error('ideas/trigger error', e);
    res.status(500).json({ error: 'Couldn’t schedule a summary just now.' });
  }
});

/* Explicit summarize (manual) */
app.post('/rooms/:roomId/ideas/summarize', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.data.stage || 'LOBBY';
    if (stage !== 'IDEA_DUMP' && stage !== 'DISCOVERY') {
      return res.status(400).json({ error: 'We only summarize during Discovery or Idea Dump.' });
    }

    const msgs = await getStageMessages(roomId, stage);
    const human = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    const system = personaSystemPrompt({ roomTopic: room.data.topic });
    const summary = await safeOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 260,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Summarize key ideas as short bullets (themes, characters, conflicts, settings, constraints). Keep it tight and specific.\n\n${human}`
        }
      ]
    });

    const clean = summary?.trim() || '- (no ideas captured yet)';
    const newNotes = clean
      .split('\n')
      .map(s => s.replace(/^[-•]\s?/, '').trim())
      .filter(Boolean);

    await room.ref.update({
      ideaSummary: clean,
      memoryNotes: Array.from(new Set([...(room.data.memoryNotes || []), ...newNotes]))
    });

    await postAsema(roomId, stage, `Here’s a quick snapshot of our ideas:\n${clean}`);
    res.json({ summary: clean });
  } catch (e) {
    console.error('ideas/summarize error', e);
    res.status(500).json({ error: 'Couldn’t summarize just now.' });
  }
});

/* Rough Draft: lock input; generate exactly 250 words; auto-advance to EDITING and ask questions */
app.post('/rooms/:roomId/draft/generate', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const last = room.data.lastRoughGeneratedAt?.toDate?.() || null;
    if (last && Date.now() - last.getTime() < 10_000) {
      return res.json({ ok: true, message: 'Rough draft already generated.' });
    }

    const stage = room.data.stage || 'LOBBY';
    if (stage !== 'ROUGH_DRAFT') {
      return res.status(400).json({ error: 'We generate the rough draft only in the Rough Draft stage.' });
    }

    await room.ref.update({ inputLocked: true }); // lock for rough draft

    const planMsgs = await getStageMessages(roomId, 'PLANNING');
    const plan = planMsgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');
    const summary = room.data.ideaSummary || '';

    const system = personaSystemPrompt({ roomTopic: room.data.topic });
    const raw = await safeOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0.65,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Write a vivid short-story abstract of **exactly 250 words**.\n` +
            `Plain text only; no headings or quotes; no lists; no cutoffs.\n\n` +
            `Inspiration notes:\nIdeas:\n${summary}\n\nPlan notes:\n${plan}`
        }
      ]
    });

    const exact250 = await enforceExactWordCount({ text: raw || '', target: 250, system });
    await db.collection('rooms').doc(roomId).collection('drafts').add({
      content: exact250, version: 'rough', createdAt: new Date()
    });

    await postAsema(roomId, 'ROUGH_DRAFT', `Here’s our **250-word** rough draft:\n\n${exact250}`);
    await room.ref.update({ lastRoughGeneratedAt: new Date() });

    await setStage(roomId, 'NEXT'); // engine moves to EDITING
    const refreshed = await getRoom(roomId);
    if (refreshed) {
      const { stage: newStage, topic, stageEndsAt } = refreshed.data;
      await refreshed.ref.update({ inputLocked: false });
      if (refreshed.data.lastGreetStage !== newStage) {
        const greet = stageGreeting(newStage, { roomTopic: topic, secondsLeft: msLeftToSeconds(stageEndsAt) });
        await postAsema(roomId, newStage, greet);
        await refreshed.ref.update({ lastGreetStage: newStage });
      }
      const askedAt = refreshed.data.lastEditingQuestionsAt?.toDate?.() || null;
      if (!askedAt || (Date.now() - askedAt.getTime() > 10_000)) {
        const qs = await safeOpenAI({
          model: 'gpt-4o-mini',
          temperature: 0.6,
          max_tokens: 160,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: 'Provide 2–3 crisp, targeted questions to refine this abstract (voice, clarity, pacing). No list formatting; just short lines separated by new lines.' }
          ]
        });
        const cleaned = (qs || '')
          .split('\n')
          .map(s => s.replace(/^[-•]\s?/, '').trim())
          .filter(Boolean)
          .slice(0, 3)
          .join('\n');
        if (cleaned) {
          await postAsema(roomId, newStage, cleaned);
          await refreshed.ref.update({ lastEditingQuestionsAt: new Date() });
        }
      }
    }

    res.json({ draft: exact250 });
  } catch (e) {
    console.error('draft/generate error', e);
    res.status(500).json({ error: 'Couldn’t generate the rough draft right now.' });
  }
});

/* Final: produce exactly 250 words and submit */
app.post('/rooms/:roomId/final/start', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.data.stage || 'FINAL';
    const ds = await db.collection('rooms').doc(roomId).collection('drafts')
      .orderBy('createdAt','desc').limit(1).get();
    const rough = ds.empty ? '(no rough draft)' : ds.docs[0].data().content;

    await postAsema(
      roomId,
      stage,
      `Starting from this rough draft — suggest precise line edits. When satisfied, type **done** or **submit**:\n\n${rough}`
    );
    await room.ref.update({ finalAwaiting: true, inputLocked: false, finalDoneUids: [] });
    res.json({ ok: true });
  } catch (e) {
    console.error('final/start error', e);
    res.status(500).json({ error: 'Couldn’t start final just now.' });
  }
});

app.post('/rooms/:roomId/final/ready', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const u = req.user.uid;
    const current = new Set([...(room.data.finalDoneUids || [])]);
    current.add(u);
    await room.ref.update({ finalDoneUids: Array.from(current) });
    res.json({ count: current.size });
  } catch (e) {
    console.error('final/ready error', e);
    res.status(500).json({ error: 'Couldn’t register ready yet.' });
  }
});

app.post('/rooms/:roomId/final/complete', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const stage = room.data.stage || 'FINAL';
    const msgs = await getStageMessages(roomId, stage);
    const edits = msgs.filter(m => m.authorType === 'user').map(m => m.text).join('\n');

    const ds = await db.collection('rooms').doc(roomId).collection('drafts')
      .orderBy('createdAt','desc').limit(1).get();
    const rough = ds.empty ? '' : ds.docs[0].data().content;

    const system = personaSystemPrompt({ roomTopic: room.data.topic });
    const rawFinal = await safeOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0.55,
      max_tokens: 600,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Apply these edits to produce the **final abstract of exactly 250 words**.\n\n` +
            `Rough draft:\n${rough}\n\nEdits:\n${edits}\n\n` +
            `Plain text only; no headings, no lists, no quotes.`
        }
      ]
    });

    const exact250 = await enforceExactWordCount({ text: rawFinal || rough, target: 250, system });

    await db.collection('rooms').doc(roomId).collection('drafts').add({
      content: exact250, version: 'final', createdAt: new Date()
    });

    await postAsema(roomId, stage, `✨ Final draft ready. Beautiful work — I’m submitting this to your presenter now.`);
    await room.ref.update({ submittedFinal: true, inputLocked: true });

    await db.collection('submissions').add({
      roomId, siteId: room.data.siteId, finalText: exact250, createdAt: new Date()
    });

    res.json({ final: exact250 });
  } catch (e) {
    console.error('final/complete error', e);
    res.status(500).json({ error: 'Couldn’t finalize just now.' });
  }
});

/* Voting (new) */
function normalizeVote(choice, optionsLen) {
  const n = Number(String(choice || '').trim());
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > optionsLen) return null;
  return n;
}

function tallyVotes(votesMap = {}, optionsLen) {
  const counts = Array.from({ length: optionsLen }, () => 0);
  for (const uid of Object.keys(votesMap)) {
    const idx = votesMap[uid] - 1;
    if (idx >= 0 && idx < optionsLen) counts[idx]++;
  }
  return counts;
}

function pickWinner(counts) {
  let bestIdx = 0; let best = counts[0] ?? 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > best) { best = counts[i]; bestIdx = i; }
  }
  return bestIdx;
}

app.post('/rooms/:roomId/vote/start', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const options = ISSUES.slice();
    const stage = room.data.stage || 'LOBBY';

    if (room.data.votingOpen) {
      await postAsema(roomId, stage, votingAlreadyOpenText());
      return res.json({ ok: true, alreadyOpen: true, options });
    }

    await room.ref.update({
      votingOpen: true,
      voteStartedAt: new Date(),
      votes: {},
      voteTopicOptions: options,
      // inputLocked: true   // enable if you want chat paused during voting
    });

    await postAsema(roomId, stage, votingMenuText());
    res.json({ ok: true, options });
  } catch (e) {
    console.error('vote/start error', e);
    res.status(500).json({ error: 'Couldn’t start voting right now.' });
  }
});

app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { choice } = req.body || {};
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const options = room.data.voteTopicOptions || ISSUES;
    if (!room.data.votingOpen) {
      await postAsema(roomId, room.data.stage || 'LOBBY', votingNotOpenText());
      return res.status(400).json({ error: 'Voting is not open.' });
    }

    const normalized = normalizeVote(choice, options.length);
    if (!normalized) {
      await postAsema(roomId, room.data.stage || 'LOBBY', invalidVoteText());
      return res.status(400).json({ error: 'Invalid vote.' });
    }

    const uid = req.user.uid;
    const currentVotes = room.data.votes || {};
    currentVotes[uid] = normalized;

    await room.ref.update({ votes: currentVotes });
    const chosenTopic = options[normalized - 1] || null;
    await postAsema(roomId, room.data.stage || 'LOBBY', acknowledgeVoteText({ choice: normalized, topic: chosenTopic }));

    res.json({ ok: true, choice: normalized, topic: chosenTopic });
  } catch (e) {
    console.error('vote/submit error', e);
    res.status(500).json({ error: 'Couldn’t submit your vote right now.' });
  }
});

app.post('/rooms/:roomId/vote/close', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const options = room.data.voteTopicOptions || ISSUES;
    const votesMap = room.data.votes || {};
    const counts = tallyVotes(votesMap, options.length);
    const winnerIdx = pickWinner(counts);
    const topic = options[winnerIdx];

    await room.ref.update({
      votingOpen: false,
      topic,
      inputLocked: true
    });

    const stage = room.data.stage || 'LOBBY';
    await postAsema(roomId, stage, votingClosedText({ topic }));

    const secondsLeft = msLeftToSeconds(room.data.stageEndsAt);
    if (room.data.lastGreetStage !== stage) {
      const g = stageGreeting(stage, { roomTopic: topic, secondsLeft });
      await postAsema(roomId, stage, g);
      await room.ref.update({ lastGreetStage: stage });
    }

    await room.ref.update({ inputLocked: stage === 'ROUGH_DRAFT' });

    res.json({ ok: true, topic, counts });
  } catch (e) {
    console.error('vote/close error', e);
    res.status(500).json({ error: 'Couldn’t close voting just now.' });
  }
});

app.get('/rooms/:roomId/vote', requireAuth, async (req, res) => {
  try {
    const room = await getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const options = room.data.voteTopicOptions || ISSUES;
    const votesMap = room.data.votes || {};
    const counts = tallyVotes(votesMap, options.length);

    res.json({
      votingOpen: !!room.data.votingOpen,
      options,
      votesReceived: Object.keys(votesMap).length,
      counts
    });
  } catch (e) {
    console.error('vote/status error', e);
    res.status(500).json({ error: 'Couldn’t fetch voting status.' });
  }
});

/* 404 */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

/* Listen */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  startStageLoop();
});
