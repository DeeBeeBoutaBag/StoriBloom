// api/asemaPersona.js

export const ISSUES = [
  'Law Enforcement Profiling',
  'Food Deserts',
  'Red Lining',
  'Homelessness',
  'Wealth Gap',
];

export const STAGES = [
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
];

export function personaSystemPrompt({ roomTopic }) {
  const topicList = ISSUES.join(', ');
  return `
You are **Asema** — a modern, warm, witty Black woman in her early 30s, hosting a classy game-show style workshop.
Voice: charismatic, encouraging, focused; playful but respectful; concise and concrete.
Role: Facilitate teams to create a tight **250-word** abstract for a short story on ONE of:
${topicList}.

Rules:
- Stay strictly on-task; if asked off-topic, say you can’t answer and redirect to the activity and listed topics.
- Keep messages short (1–4 sentences). Use bullets for summaries.
- Use inclusive language; avoid jargon; be specific.
- When asked to “remind us,” summarize from room memory.
- Never expose private data or anything outside the session.

Current topic: ${roomTopic || 'Not selected — prompt them to choose one.'}
`.trim();
}

export function greetScript({ roomTopic }) {
  return [
    `🎙️ I’m **Asema** — welcome to StoriBloom.AI.`,
    `We’ll craft a crisp **250-word** short-story abstract on one issue: **${ISSUES.join(', ')}**.`,
    roomTopic ? `Today’s topic: **${roomTopic}**.` : `Pick a topic or start exploring ideas — I’ll synthesize as you go.`,
    `Say **“Asema, …”** to ask me questions anytime (on-topic only).`,
  ].join(' ');
}

export function stageGreeting(stage, { roomTopic, secondsLeft }) {
  const timeHint = secondsLeft
    ? `You’ve got ~${Math.max(1, Math.floor(secondsLeft / 60))} min.`
    : '';
  switch (stage) {
    case 'LOBBY':
      return `🎬 We’ll begin shortly. Get comfy and decide on a topic. ${timeHint}`;

    case 'DISCOVERY':
      return [
        `🔎 **Discovery** — free chat on ${roomTopic || 'our chosen issue'}.`,
        `Share observations, sparks, lived context. I’ll track ideas.`,
        `${timeHint} Ask “Asema, remind us” for a quick recap.`,
      ].join(' ');

    case 'IDEA_DUMP':
      return [
        `🧠 **Idea Dump** — bullet points only, no debate.`,
        `Themes, characters, conflicts, settings, constraints — go wide; I’ll keep a rolling summary.`,
        `${timeHint} We’ll narrow next.`,
      ].join(' ');

    case 'PLANNING':
      return [
        `🧭 **Planning** — pick a direction.`,
        `Lock protagonist, goal, stakes, setting, tone. Ask: “Asema, checklist.”`,
        `${timeHint} Keep it focused and concrete.`,
      ].join(' ');

    case 'ROUGH_DRAFT':
      return [
        `✍️ **Rough Draft** — I’ll generate the first **exactly 250-word** draft. Chat is locked here.`,
        `${timeHint} I’ll share it, then we’ll move to Editing for feedback.`,
      ].join(' ');

    case 'EDITING':
      return [
        `🪄 **Editing** — refine clarity, voice, pacing.`,
        `Answer my 2–3 questions, propose precise edits. I’ll help polish.`,
        `${timeHint} We’ll finalize next.`,
      ].join(' ');

    case 'FINAL':
      return [
        `🏁 **Final** — last tweaks only.`,
        `When satisfied, type **done** or **submit**. I’ll send it to your presenter.`,
        `${timeHint}`,
      ].join(' ');

    default:
      return `Stage changed to **${stage}** — let’s keep momentum.`;
  }
}

/* =========================
   Voting helpers (new)
   ========================= */
export function votingMenuText() {
  const lines = ISSUES.map((t, i) => `${i + 1}. ${t}`);
  return [
    `🗳️ **Topic Vote** — reply with just the number of your choice (one vote each).`,
    `Here are the options:`,
    lines.join('\n'),
    `I’ll lock the topic after everyone votes (or when the presenter closes voting).`
  ].join('\n\n');
}

export function acknowledgeVoteText({ choice, topic }) {
  if (!topic) return `Got it — vote recorded for option **${choice}**.`;
  return `Got it — vote recorded for **${topic}**.`;
}

export function votingAlreadyOpenText() {
  return `Voting is already open — reply with the number of your choice.`;
}

export function votingNotOpenText() {
  return `Voting isn’t open yet. Ask: “**Asema, we’re ready to vote**.”`;
}

export function votingClosedText({ topic }) {
  return `🗳️ Voting closed. Our topic is **${topic}**. I’ll keep us on this for the rest of the session.`;
}

export function invalidVoteText() {
  return `I couldn’t read that vote — please reply with the number from the list.`;
}
