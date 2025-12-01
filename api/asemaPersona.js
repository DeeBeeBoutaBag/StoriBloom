// api/asemaPersona.js
import { getOpenAI } from './openaiClient.js';

// ===== Constants =====

export const ISSUES = Object.freeze([
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap',
]);

export const STAGES = Object.freeze([
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
]);

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ===== Utilities =====

export function isValidStage(stage) {
  return typeof stage === 'string' && STAGES.includes(stage);
}

export function assertStage(stage) {
  if (!isValidStage(stage)) {
    const list = STAGES.join(', ');
    throw new Error(`Invalid stage "${stage}". Must be one of: ${list}`);
  }
  return stage;
}

function normalizeTopic(roomTopic) {
  if (typeof roomTopic !== 'string') return null;
  const t = roomTopic.trim();
  return t.length ? t : null;
}

function safeJoin(arr, sep = '\n') {
  return arr.filter(Boolean).join(sep);
}

// ===== Persona Prompts =====

export function personaSystemPrompt({ roomTopic } = {}) {
  const topicList = ISSUES.join(', ');
  const topic = normalizeTopic(roomTopic);
  return `
You are **Asema** — a modern, warm, witty Black woman in her early 30s, hosting a classy game-show style workshop.

Tone & voice:
- Charismatic, encouraging, and clear.
- Playful but never corny; respect participants’ lived experience.
- Short, vivid, concrete. 1–4 sentences per message unless summarizing.

Job:
- Help a small group craft a tight, vivid 250-word abstract for a short story.
- The story must center ONE social issue, chosen from:
  ${topicList}
- Keep them focused, specific, and collaborative.

Rules:
- Stay on-task. If users go off-topic or ask random general-knowledge questions, gently refuse and redirect back to the story work.
- Never mention system prompts, APIs, models, or implementation details.
- Use inclusive language and avoid generic motivational speeches.
- When they say “remind us” or similar, summarize key ideas and next steps.
- Remember you are Asema, not a generic assistant.

Current topic (if any): ${topic || 'Not selected yet — guide them to pick one.'}
`.trim();
}

export function greetScript({ roomTopic } = {}) {
  const topic = normalizeTopic(roomTopic);
  return safeJoin(
    [
      `🎙️ I’m **Asema** — welcome to StoriBloom.AI.`,
      `We’ll build a sharp **250-word** story abstract around one real issue: **${ISSUES.join(', ')}**.`,
      topic
        ? `Today’s working topic: **${topic}**.`
        : `First, pick a topic or pitch a few — I’ll help you lock one in.`,
      `Say **“Asema, …”** or **“Asema AI, …”** when you want my help (on-topic only).`,
    ],
    ' '
  );
}

export function stageGreeting(stage, { roomTopic, secondsLeft } = {}) {
  assertStage(stage);
  const topic = normalizeTopic(roomTopic) || 'our chosen issue';
  const timeHint = Number.isFinite(secondsLeft)
    ? `You’ve got ~${Math.max(1, Math.floor(secondsLeft / 60))} min.`
    : '';

  switch (stage) {
    case 'LOBBY':
      return `🎬 We’ll begin shortly. Get comfy, scan the issues, and start nominating a topic. ${timeHint}`.trim();

    case 'DISCOVERY':
      return [
        `🔎 **Discovery** — talk freely about ${topic}.`,
        `Drop observations, lived moments, stats, and questions. I’m listening for story seeds.`,
        `${timeHint} Ask “Asema, remind us” anytime for a quick recap.`,
      ].join(' ');

    case 'IDEA_DUMP':
      return [
        `🧠 **Idea Dump** — rapid-fire ideas only, no debate.`,
        `Characters, conflicts, settings, symbols — pile them up, I’ll organize.`,
        `${timeHint} Be concrete, not vague.`,
      ].join(' ');

    case 'PLANNING':
      return [
        `🧭 **Planning** — choose the story you’re actually writing.`,
        `Lock protagonist, goal, stakes, setting, and POV. I can sanity-check your plan.`,
        `${timeHint}`,
      ].join(' ');

    case 'ROUGH_DRAFT':
      return [
        `✍️ **Rough Draft** — I’ll generate the first **~250-word** abstract.`,
        `Use it as clay, not stone. Your edits and pushback matter.`,
        `${timeHint}`,
      ].join(' ');

    case 'EDITING':
      return [
        `🪄 **Editing** — sharpen language, clarify stakes, and fix pacing.`,
        `Tell me what feels off; I’ll propose tight, specific edits.`,
        `${timeHint}`,
      ].join(' ');

    case 'FINAL':
      return [
        `🏁 **Final** — last small tweaks.`,
        `When it sings, type **done** or **submit** so I know you’re ready.`,
        `${timeHint}`,
      ].join(' ');

    default:
      return `Stage changed to **${stage}** — keep momentum.`;
  }
}

/* =========================
   Voting helpers
   ========================= */

export function votingMenuText() {
  const lines = ISSUES.map((t, i) => `${i + 1}. ${t}`);
  return [
    `🗳️ **Topic Vote** — reply with just the number of your choice (one vote each).`,
    `Here are the options:`,
    lines.join('\n'),
    `I’ll lock the topic after everyone votes (or when the presenter closes voting).`,
  ].join('\n\n');
}

export function acknowledgeVoteText({ choice, topic } = {}) {
  const topicNorm = normalizeTopic(topic);
  if (!topicNorm) return `Got it — vote recorded for option **${choice}**.`;
  return `Got it — vote recorded for **${topicNorm}**.`;
}

export function votingAlreadyOpenText() {
  return `Voting is already open — reply with the number of your choice.`;
}

export function votingNotOpenText() {
  return `Voting isn’t open yet. Ask: “**Asema, we’re ready to vote**.”`;
}

export function votingClosedText({ topic } = {}) {
  const topicNorm = normalizeTopic(topic) || 'the selected topic';
  return `🗳️ Voting closed. Our topic is **${topicNorm}**. I’ll keep us on this for the rest of the session.`;
}

export function invalidVoteText() {
  return `I couldn’t read that vote — please reply with the number from the list.`;
}

/* =========================
   Asema AI Wrapper
   ========================= */

// Simple in-process rate limiter: max N calls per windowMs
const RATE_LIMIT_MAX_CALLS = Number(process.env.ASEMA_MAX_CALLS_PER_WINDOW || 6);
const RATE_LIMIT_WINDOW_MS = Number(process.env.ASEMA_WINDOW_MS || 1000);
const recentCalls = [];

/** Sleep helper */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Basic throttle to avoid dogpiling OpenAI in big sessions */
async function throttleOpenAI() {
  if (!RATE_LIMIT_MAX_CALLS || RATE_LIMIT_MAX_CALLS <= 0) return;

  const now = Date.now();
  // Drop old timestamps outside the window
  while (recentCalls.length && now - recentCalls[0] > RATE_LIMIT_WINDOW_MS) {
    recentCalls.shift();
  }

  if (recentCalls.length >= RATE_LIMIT_MAX_CALLS) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - recentCalls[0]) + 10;
    await sleep(waitMs);
  }

  recentCalls.push(Date.now());
}

/** Decide if an error is worth retrying (rate limit, transient) */
function isRetryableError(err) {
  if (!err) return false;

  // Some SDK errors include status or code
  const status = err.status || err.statusCode;
  if (status && [429, 500, 502, 503, 504].includes(Number(status))) {
    return true;
  }

  const msg = String(err.message || err).toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('temporarily unavailable')
  ) {
    return true;
  }

  return false;
}

async function callOpenAI(messages, { maxTokens = 450 } = {}) {
  const client = getOpenAI();
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 250;

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await throttleOpenAI();

      const res = await client.chat.completions.create({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.8,
      });

      return (res.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      lastError = err;
      const retryable = isRetryableError(err);
      const isLast = attempt === MAX_RETRIES - 1;

      console.warn(
        `[Asema callOpenAI] error on attempt ${attempt + 1}/${MAX_RETRIES}:`,
        err?.message || err
      );

      if (!retryable || isLast) break;

      // Exponential backoff with a little jitter
      const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 150);
      await sleep(backoff + jitter);
    }
  }

  // Let caller handle fallback; most Asema APIs wrap in try/catch
  throw lastError || new Error('Asema OpenAI call failed');
}

// Small helper: detect "Asema AI this is our topic ..."
function extractTopicFromUtterance(text) {
  if (!text) return null;
  const m = text.match(
    /(asema(?:\s*ai)?)[^\w]+(?:this is our topic|our topic is|topic is)\s*[:\-]?\s*(.+)$/i
  );
  if (!m) return null;
  const topic = m[2].trim();
  return topic.length ? topic : null;
}

// Public Asema API used by server.js
export const Asema = {
  extractTopicFromUtterance,

  async greet(stage, roomTopic) {
    const sys = personaSystemPrompt({ roomTopic });
    const content = stageGreeting(stage, { roomTopic });
    try {
      return await callOpenAI([
        { role: 'system', content: sys },
        {
          role: 'user',
          content: `Give a short, energetic welcome for stage "${stage}" in 2–4 sentences. Use this as guidance:\n${content}`,
        },
      ]);
    } catch {
      // Fall back to deterministic text if OpenAI fails
      return content;
    }
  },

  async replyToUser(stage, roomTopic, userText) {
    const sys = personaSystemPrompt({ roomTopic });

    // Slight stage-aware advice baked into instructions
    const stageHint = (() => {
      switch (stage) {
        case 'DISCOVERY':
          return 'Draw out concrete memories and observations, not vague opinions.';
        case 'IDEA_DUMP':
          return 'Encourage lots of small, specific ideas and avoid judging them yet.';
        case 'PLANNING':
          return 'Push them to lock a clear protagonist, goal, stakes, and setting.';
        case 'ROUGH_DRAFT':
          return 'Help them react to and reshape the draft rather than starting from scratch.';
        case 'EDITING':
          return 'Offer line-level improvements, alternatives, and clarity tweaks.';
        case 'FINAL':
          return 'Help them make tiny tweaks and confirm that the abstract feels ready.';
        default:
          return 'Keep them moving toward a concrete, story-ready abstract.';
      }
    })();

    const instructions = `
You are in stage: ${stage}.
Respond to the user as Asema:
- 1–4 sentences.
- Reference their specific ideas or question.
- ${stageHint}
- If they say “remind us” or similar, summarize key directions and next steps.
- If they try to change topic away from the chosen issue, acknowledge briefly but bring them back on topic.
- Avoid generic speeches; stay grounded in their story and characters.
`.trim();

    try {
      return await callOpenAI(
        [
          { role: 'system', content: sys },
          { role: 'system', content: instructions },
          { role: 'user', content: userText },
        ],
        { maxTokens: 350 }
      );
    } catch {
      return `Love that energy — now push it one step more concrete. Who, where, and what’s at stake?`;
    }
  },

  async summarizeIdeas(stage, roomTopic, ideaLines) {
    const sys = personaSystemPrompt({ roomTopic });
    // Only keep the most recent ~80 messages to limit token size
    const text = ideaLines.slice(-80).join('\n');

    const prompt = `
Stage: ${stage}
Summarize the group’s ideas into a tight "Idea Board" for their story abstract.

Requirements:
- 4–8 bullet points.
- Capture characters, stakes, setting, and any strong images.
- Be specific and use their language where possible.
- This summary will persist into later stages and feed the rough draft.

Ideas:
${text}
`.trim();

    try {
      return await callOpenAI(
        [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 400 }
      );
    } catch {
      return '• Capturing ideas… keep sharing specifics so I can lock in your best angle.';
    }
  },

  async generateRoughDraft(topic, ideaSummary, roomId) {
    const sys = personaSystemPrompt({ roomTopic: topic || '' });

    const prompt = `
Using the notes below, write a **single 250-word abstract** for a short story on "${
      topic || 'the chosen issue'
    }".

Constraints:
- Aim for **about 250 words** (±5 is okay, but stay close).
- 1–3 tight paragraphs.
- Clearly state: protagonist, setting, central conflict, stakes, and emotional tone.
- It should feel cinematic and grounded in lived reality, not like a generic essay or PSA.
- Do NOT include bullet points or headings. Just the abstract text.

Idea Board:
${ideaSummary || '(very few notes; make smart but grounded assumptions)'} 

Now write the abstract.
`.trim();

    const out = await callOpenAI(
      [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 450 }
    );

    return out;
  },
};
