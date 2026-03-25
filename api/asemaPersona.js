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

function clip(text, maxChars = 6500) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[...clipped...]';
}

// ===== Stage instructions (clear + operational) =====

export const STAGE_INSTRUCTIONS = Object.freeze({
  LOBBY: [
    '✅ Pick a persona (emoji) and test the chat.',
    '✅ Skim the possible issues and start nominating 1–2 topics.',
    '✅ If you’re confused, ask: “Asema, what are we doing?”',
  ],
  DISCOVERY: [
    '✅ Share real moments, observations, and “why this matters” stories.',
    '✅ Drop specific details: who/where/what happened/what it felt like.',
    '✅ Avoid debating — we’re collecting story fuel.',
    '✅ When you’re ready, click “I’m ready to vote.”',
  ],
  IDEA_DUMP: [
    '✅ Rapid-fire: characters, conflicts, settings, symbols, plot twists.',
    '✅ Volume > perfection. No judging ideas yet.',
    '✅ Make it concrete (names, places, objects, decisions).',
  ],
  PLANNING: [
    '✅ Lock the story you’re actually writing:',
    '   • Protagonist + what they want',
    '   • Antagonist/pressure (person/system/time)',
    '   • Stakes (what they lose if they fail)',
    '   • Setting + time window',
    '✅ Use the Planning Board; then share it to the room.',
  ],
  ROUGH_DRAFT: [
    '✅ I generate the first ~250-word abstract from your Idea Board.',
    '✅ Treat it like clay: keep what’s strong, rewrite what’s weak.',
    '✅ Don’t ask for a “brand new story” — we refine the same draft.',
  ],
  EDITING: [
    '✅ You are editing ONE draft (the latest version).',
    '✅ Make surgical changes: tighten sentences, clarify stakes, fix pacing.',
    '✅ Tell me what to change using one of these:',
    '   • “Replace: ___ with ___”',
    '   • “Shorten paragraph 2”',
    '   • “Make the ending hit harder (but keep the same plot)”',
    '✅ If you ask “what do we have so far?”, I should show the latest version.',
  ],
  FINAL: [
    '✅ Last polish ONLY (no major rewrites).',
    '✅ Check: clarity, stakes, names, and the final sentence landing.',
    '✅ When you’re satisfied, type “done” or “submit.”',
    '✅ If time runs out, the room will close and the final abstract will be posted.',
  ],
});

export function stageInstructionText(stage) {
  const s = assertStage(stage);
  const bullets = STAGE_INSTRUCTIONS[s] || [];
  return bullets.map((x) => `• ${x}`).join('\n');
}

// ===== Persona Prompts =====

export function personaSystemPrompt({
  roomTopic,
  aiBehavior = 'GUIDE',
  assistantPersona = '',
  tone = 'BALANCED',
  strictness = 'MEDIUM',
  dataUsage = 'NO_TRAINING',
  piiRedaction = true,
  citationMode = false,
  ageSafeMode = 'K12',
  moderationLevel = 'STANDARD',
  blockedTerms = [],
} = {}) {
  const topicList = ISSUES.join(', ');
  const topic = normalizeTopic(roomTopic);
  const behavior = String(aiBehavior || 'GUIDE')
    .trim()
    .toUpperCase();
  const behaviorInstruction =
    behavior === 'BACKGROUND'
      ? 'Stay mostly in the background. Answer only when directly prompted, and keep replies concise.'
      : behavior === 'HELPER'
      ? 'Act as a hands-on helper. Offer concrete options and examples, but do not take over ownership from participants.'
      : 'Act as an active guide. Keep the group focused, ask clarifying questions, and maintain momentum.';
  const toneKey = String(tone || 'BALANCED').trim().toUpperCase();
  const strictnessKey = String(strictness || 'MEDIUM').trim().toUpperCase();
  const dataUsageKey = String(dataUsage || 'NO_TRAINING').trim().toUpperCase();
  const toneInstruction =
    toneKey === 'SOFT'
      ? 'Tone: gentle and affirming, low-pressure.'
      : toneKey === 'DIRECT'
      ? 'Tone: direct, concise, and practical.'
      : toneKey === 'COACH'
      ? 'Tone: coaching style with concrete next-step prompts.'
      : 'Tone: balanced warmth with practical clarity.';
  const strictnessInstruction =
    strictnessKey === 'HIGH'
      ? 'Strictness: enforce concise, specific answers and redirect quickly when off-task.'
      : strictnessKey === 'LOW'
      ? 'Strictness: allow broader exploration before narrowing.'
      : 'Strictness: keep a medium level of structure and focus.';
  const dataUsageInstruction =
    dataUsageKey === 'ANONYMIZED'
      ? 'Data usage mode: avoid quoting personal identifiers; generalize examples.'
      : dataUsageKey === 'ANALYTICS_ONLY'
      ? 'Data usage mode: focus on aggregate patterns, avoid personal detail retention.'
      : 'Data usage mode: do not include or retain unnecessary personal data.';
  const citationInstruction = citationMode
    ? 'When factual claims are made, encourage citing concrete sources.'
    : 'Citations are optional unless participants request them.';
  const ageSafeKey = String(ageSafeMode || 'K12').trim().toUpperCase();
  const moderationKey = String(moderationLevel || 'STANDARD').trim().toUpperCase();
  const ageSafeInstruction =
    ageSafeKey === 'OFF'
      ? 'Age-safe mode: disabled.'
      : ageSafeKey === 'ADULT'
      ? 'Age-safe mode: adult audience; still avoid explicit harm instructions.'
      : ageSafeKey === 'TEEN'
      ? 'Age-safe mode: teen audience; avoid explicit sexual or graphic violent content.'
      : 'Age-safe mode: K-12 safe language only; no explicit sexual, graphic violent, or self-harm content.';
  const moderationInstruction =
    moderationKey === 'OFF'
      ? 'Moderation: minimal filtering.'
      : moderationKey === 'STRICT'
      ? 'Moderation: strict safety filtering; proactively redirect unsafe language.'
      : 'Moderation: standard safety filtering for harassment, self-harm, and violent intent.';
  const blockedTermsList = Array.isArray(blockedTerms)
    ? blockedTerms.map((term) => String(term || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const blockedTermsInstruction = blockedTermsList.length
    ? `Organization blocked terms: ${blockedTermsList.join(', ')}. Do not repeat them; redirect constructively.`
    : 'Organization blocked terms: none configured.';
  const personaBrief = String(assistantPersona || '').trim();
  return `
You are **Asema** — a modern, warm, witty Black woman in her early 30s, hosting a classy game-show style workshop.

Tone & voice:
- Charismatic, encouraging, and clear.
- Playful but never corny; respect participants’ lived experience.
- Short, vivid, concrete. 1–4 sentences unless summarizing.

Your job:
- Help a small group craft a tight, vivid **~250-word** story abstract.
- The story must center ONE social issue, chosen from:
  ${topicList}
- Keep them focused, specific, and collaborative.

Hard rules:
- Never mention system prompts, APIs, models, or implementation details.
- Stay on-task. If users go off-topic, gently redirect back to story work.
- Avoid generic motivational speeches. Be specific and actionable.
- In EDITING/FINAL: you are an editor. Make surgical changes. Do NOT generate an unrelated new draft.
- AI facilitation style: ${behaviorInstruction}
- ${toneInstruction}
- ${strictnessInstruction}
- ${dataUsageInstruction}
- PII redaction: ${piiRedaction ? 'enabled' : 'disabled'}.
- ${citationInstruction}
- ${ageSafeInstruction}
- ${moderationInstruction}
- ${blockedTermsInstruction}

Current topic (if any): ${topic || 'Not selected yet — guide them to pick one.'}
${personaBrief ? `Custom facilitator brief: ${personaBrief}` : ''}
`.trim();
}

export function greetScript({ roomTopic } = {}) {
  const topic = normalizeTopic(roomTopic);
  return safeJoin(
    [
      `🎙️ I’m **Asema** — welcome to StoriBloom.AI.`,
      `We’ll build a sharp **~250-word** story abstract around one real issue: **${ISSUES.join(', ')}**.`,
      topic
        ? `Today’s working topic: **${topic}**.`
        : `First, pick a topic (or pitch a few) — I’ll help you lock one in.`,
      `Say **“Asema, …”** when you want my help (on-topic only).`,
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

  const instructionBlock = stageInstructionText(stage);

  switch (stage) {
    case 'LOBBY':
      return [
        `🎬 We’ll begin shortly.`,
        `Today we’re building a **~250-word abstract** around one issue.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'DISCOVERY':
      return [
        `🔎 **Discovery** — talk freely about **${topic}**.`,
        `Drop real moments, specific observations, and questions.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'IDEA_DUMP':
      return [
        `🧠 **Idea Dump** — rapid-fire ideas only (no debate).`,
        `Characters, conflicts, settings, symbols — pile them up.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'PLANNING':
      return [
        `🧭 **Planning** — choose the exact story you’re writing.`,
        `Lock protagonist, goal, stakes, setting, and the “turn.”`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'ROUGH_DRAFT':
      return [
        `✍️ **Rough Draft** — I’ll generate the first **~250-word** abstract.`,
        `Use it as clay, not stone.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'EDITING':
      return [
        `🪄 **Editing** — we refine the SAME draft (latest version).`,
        `Surgical edits only: tighten, clarify, sharpen stakes.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    case 'FINAL':
      return [
        `🏁 **Final** — last tiny tweaks, then lock it.`,
        `Type **done** or **submit** when you’re ready.`,
        timeHint,
        `\n**What to do right now:**\n${instructionBlock}`,
      ].join(' ').trim();

    default:
      return `Stage changed to **${stage}** — keep momentum.`;
  }
}

/* =========================
   Intent helpers (server can use these)
   ========================= */

export function shouldRemindIntent(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('remind us') ||
    t.includes('recap') ||
    t.includes('summarize') ||
    t.includes('what are we doing') ||
    t.includes('what should we do')
  );
}

export function shouldShowProgress(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('what do we have so far') ||
    t.includes('show what we have') ||
    t.includes('show the draft') ||
    t.includes('paste the draft') ||
    t.includes('current version') ||
    t.includes('latest version')
  );
}

export function shouldEditIntent(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('edit') ||
    t.includes('revise') ||
    t.includes('rewrite this sentence') ||
    t.includes('change this sentence') ||
    t.includes('replace') ||
    t.includes('tighten') ||
    t.includes('shorten') ||
    t.includes('make it clearer') ||
    t.includes('make it stronger')
  );
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
   OpenAI wrapper
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

async function callOpenAI(
  messages,
  { maxTokens = 450, temperature = 0.7, modelChoice = MODEL } = {}
) {
  const client = getOpenAI();
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 250;

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await throttleOpenAI();

      const resolvedModel = String(modelChoice || MODEL).trim() || MODEL;
      const res = await client.chat.completions.create({
        model: resolvedModel,
        messages,
        max_tokens: maxTokens,
        temperature,
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

      const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 150);
      await sleep(backoff + jitter);
    }
  }

  throw lastError || new Error('Asema OpenAI call failed');
}

function adjustedTemperature(baseTemperature, strictness) {
  const base = Number(baseTemperature || 0.7);
  const key = String(strictness || 'MEDIUM').trim().toUpperCase();
  if (key === 'HIGH') return Math.max(0.1, base - 0.2);
  if (key === 'LOW') return Math.min(0.95, base + 0.15);
  return base;
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

/* =========================
   Draft Editing (NEW)
   ========================= */

/**
 * editDraft
 * - Makes surgical edits to the *provided* draft.
 * - Never invents a new story; preserves plot.
 * - Returns the full updated draft text (not bullets).
 */
export async function editDraft({
  roomTopic,
  draftText,
  userRequest,
} = {}) {
  const topic = normalizeTopic(roomTopic) || '';
  const sys = personaSystemPrompt({ roomTopic: topic });

  const draft = clip(draftText || '', 8000);
  const request = String(userRequest || '').trim();

  const editorRules = `
You are editing a single existing story abstract.

Hard constraints:
- Preserve the SAME story (same protagonist, setting, plot, and key beats).
- Do NOT replace it with a different story.
- Do NOT introduce new characters or a totally new ending unless the user explicitly requests a new character/ending.
- Keep length close to ~250 words.
- Output ONLY the updated abstract text. No headings, no bullets, no commentary.

Editing behavior:
- Make surgical changes to satisfy the user's request.
- If the user's request is ambiguous, make the smallest reasonable edits that improve clarity.
`.trim();

  const prompt = `
Topic: ${topic || '(not locked)'}
User request: ${request || '(general tightening / clarity)'} 

Current draft:
${draft}

Return the updated draft now.
`.trim();

  return await callOpenAI(
    [
      { role: 'system', content: sys },
      { role: 'system', content: editorRules },
      { role: 'user', content: prompt },
    ],
    { maxTokens: 650, temperature: 0.35 }
  );
}

/**
 * finalStageIntro (NEW)
 * - Use this when FINAL starts, *after* server fetches the latest edited draft.
 * - Returns a greeting + instructions, but NOT the whole draft.
 */
export async function finalStageIntro({ roomTopic } = {}) {
  const topic = normalizeTopic(roomTopic) || '';
  const sys = personaSystemPrompt({ roomTopic: topic });

  const prompt = `
Write a short FINAL-stage greeting as Asema.

Requirements:
- 2–4 sentences max.
- Include clear "what to do now" instructions:
  • tiny tweaks only
  • type "done" or "submit" when ready
- Do NOT paste the draft in this message.
- Keep it warm, confident, not corny.
`.trim();

  try {
    return await callOpenAI(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { maxTokens: 180, temperature: 0.6 }
    );
  } catch {
    return stageGreeting('FINAL', { roomTopic: topic });
  }
}

/**
 * closingPackage (NEW)
 * - Use on close: returns closing msg and "Final Abstract" wrapper text
 * - The server should paste the finalText underneath.
 */
export async function closingPackage({ roomTopic, readyCount, seats } = {}) {
  const topic = normalizeTopic(roomTopic) || '';
  const sys = personaSystemPrompt({ roomTopic: topic });

  const prompt = `
Write a short closing message as Asema.

Requirements:
- 2–4 sentences max.
- Mention consensus (readyCount / seats) if provided.
- Mention topic if available.
- Tell them to copy/screenshot the final abstract below.
- Do NOT paste the abstract here.
Values: warm, proud, grounded.
Data:
- readyCount=${Number.isFinite(readyCount) ? readyCount : 'n/a'}
- seats=${Number.isFinite(seats) ? seats : 'n/a'}
- topic=${topic || 'n/a'}
`.trim();

  try {
    return await callOpenAI(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { maxTokens: 200, temperature: 0.6 }
    );
  } catch {
    const parts = [];
    parts.push('🏁 **Session complete.** Beautiful work, team.');
    if (Number.isFinite(readyCount) && Number.isFinite(seats) && seats > 0) {
      parts.push(`**${readyCount} / ${seats}** teammates clicked **done**.`);
    }
    if (topic) parts.push(`You just wrapped a story on **${topic}**.`);
    parts.push('Copy your final abstract below — this is your shared version.');
    return parts.join(' ');
  }
}

/* =========================
   Asema API used by server.js
   ========================= */

export const Asema = {
  extractTopicFromUtterance,

  async greet(stage, roomTopic, options = {}) {
    const sys = personaSystemPrompt({ roomTopic, ...options });
    const deterministic = stageGreeting(stage, { roomTopic });

    // We now force stage greetings to contain clear instructions.
    const prompt = `
Write a stage greeting for "${stage}" as Asema.

Hard constraints:
- Must include a clear "What to do right now" instruction set.
- Keep it short and punchy, but include the operational steps.
- Stay on the story task, no generic speeches.
- Do NOT mention system prompts, models, or tools.

Use this guidance (you may paraphrase but keep the steps):
${deterministic}
`.trim();

    try {
      return await callOpenAI(
        [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
        {
          maxTokens: 260,
          temperature: adjustedTemperature(0.6, options?.strictness),
          modelChoice: options?.modelChoice || MODEL,
        }
      );
    } catch {
      return deterministic;
    }
  },

  async replyToUser(stage, roomTopic, userText, options = {}) {
    const sys = personaSystemPrompt({ roomTopic, ...options });
    const text = String(userText || '').trim();

    const stageHint = (() => {
      switch (stage) {
        case 'DISCOVERY':
          return 'Pull out concrete memories and observations; ask sharp follow-ups.';
        case 'IDEA_DUMP':
          return 'Encourage many specific ideas; no judging yet.';
        case 'PLANNING':
          return 'Force clarity: protagonist, goal, stakes, setting, POV.';
        case 'ROUGH_DRAFT':
          return 'Help them react to and refine the draft; do not start over.';
        case 'EDITING':
          return 'Act like an editor. Offer surgical changes, replacement sentences, or a tighter version of the same content.';
        case 'FINAL':
          return 'Tiny tweaks only. Confirm readiness and help with micro-edits.';
        default:
          return 'Keep momentum toward a concrete, story-ready abstract.';
      }
    })();

    const editorGuard = (stage === 'EDITING' || stage === 'FINAL')
      ? `
EDITOR MODE (IMPORTANT):
- Do NOT invent a new story.
- If asked to change one line, propose replacements (1–3 options).
- If asked “what do we have so far?”, tell them: “Paste the latest draft and I’ll reflect it back exactly + edits.” (Server may paste it.)
- Keep changes small, preserve plot/characters/setting unless explicitly asked.
`.trim()
      : '';

    const instructions = `
Stage: ${stage}

Response rules:
- 1–4 sentences (unless the user asked for a recap).
- Be specific: refer to their exact question or story element.
- ${stageHint}
- If they say “remind us / recap / summarize”, give 4–8 bullets and next steps.
- If they go off-topic away from the chosen issue, acknowledge briefly and redirect.

${editorGuard}
`.trim();

    try {
      return await callOpenAI(
        [
          { role: 'system', content: sys },
          { role: 'system', content: instructions },
          { role: 'user', content: text },
        ],
        {
          maxTokens: 350,
          temperature: adjustedTemperature(
            stage === 'EDITING' || stage === 'FINAL' ? 0.45 : 0.7,
            options?.strictness
          ),
          modelChoice: options?.modelChoice || MODEL,
        }
      );
    } catch {
      return `Okay — make it one notch more concrete. Who is the protagonist, where are they, and what do they risk losing?`;
    }
  },

  async summarizeIdeas(stage, roomTopic, ideaLines, options = {}) {
    const sys = personaSystemPrompt({ roomTopic, ...options });
    const text = (ideaLines || []).slice(-80).join('\n');

    const prompt = `
Stage: ${stage}
Create a tight "Idea Board" for a ~250-word story abstract.

Requirements:
- 4–8 bullet points.
- Capture: protagonist, setting, conflict, stakes, key images, and 1 turning point.
- Use specific language from the group where possible.
- No generic advice.

Ideas:
${text}
`.trim();

    try {
      return await callOpenAI(
        [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
        {
          maxTokens: 420,
          temperature: adjustedTemperature(0.55, options?.strictness),
          modelChoice: options?.modelChoice || MODEL,
        }
      );
    } catch {
      return '• Capturing ideas… keep sharing specifics so I can lock in your strongest angle.';
    }
  },

  async generateRoughDraft(topic, ideaSummary, roomId, options = {}) {
    const sys = personaSystemPrompt({ roomTopic: topic || '', ...options });

    const prompt = `
Using the notes below, write a **single ~250-word abstract** for a short story on "${
      topic || 'the chosen issue'
    }".

Constraints:
- Aim for **about 250 words** (±10).
- 1–3 tight paragraphs.
- Clearly state: protagonist, setting, central conflict, stakes, and emotional tone.
- Cinematic + grounded (not a generic essay or PSA).
- No bullet points, no headings — abstract only.

Idea Board:
${ideaSummary || '(very few notes; make smart but grounded assumptions)'} 

Return the abstract text now.
`.trim();

    const out = await callOpenAI(
      [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      {
        maxTokens: 650,
        temperature: adjustedTemperature(0.75, options?.strictness),
        modelChoice: options?.modelChoice || MODEL,
      }
    );

    return out;
  },
};
