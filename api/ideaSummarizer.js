// api/ideaSummarizer.js

import { personaSystemPrompt } from './asemaPersona.js';
import { Rooms, Messages } from './ddbAdapter.js';

/**
 * Summarize ideas for a room and store both `ideaSummary` and `memoryNotes`.
 * Runs OpenAI once and writes results to the Rooms item in DynamoDB.
 *
 * @param {{ openai: import('openai').default, model?: string, temperature?: number }} deps
 * @param {string} roomId
 * @returns {Promise<{ok: boolean, reason?: string, summary?: string, empty?: boolean}>}
 */
export async function summarizeIdeas(deps, roomId) {
  const { openai, model = 'gpt-4o-mini', temperature = 0.4 } = deps || {};
  if (!openai) return { ok: false, reason: 'missing_openai' };
  if (!roomId) return { ok: false, reason: 'missing_roomId' };

  // 1) Load room
  const room = await Rooms.get(roomId);
  if (!room) return { ok: false, reason: 'room_not_found' };

  const stage = String(room.stage || 'LOBBY').toUpperCase();
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') {
    return { ok: false, reason: 'wrong_stage' };
  }

  // 2) Gather messages for current stage (ascending by createdAt)
  const items = await Messages.byPhase(roomId, stage);
  const texts = (items || [])
    .filter((m) => {
      const at = (m.authorType || '').toString().toUpperCase();
      return at === 'USER'; // accept USER; if you stored 'user', normalize below
    })
    .map((m) => m.text)
    .filter(Boolean);

  // Fallback: if nothing matched USER (uppercase), try 'user' (lowercase) to be tolerant
  const humanJoined =
    texts.length > 0
      ? texts.join('\n')
      : (items || [])
          .filter((m) => (m.authorType || '').toString().toLowerCase() === 'user')
          .map((m) => m.text)
          .filter(Boolean)
          .join('\n');

  // 3) Nothing to summarize → clear summary & set timestamp
  if (!humanJoined || !humanJoined.trim()) {
    await Rooms.update(roomId, {
      ideaSummary: '',
      lastIdeaSummaryAt: Date.now(),
    });
    return { ok: true, empty: true };
  }

  // 4) Build system prompt and call OpenAI
  const system = personaSystemPrompt({ roomTopic: room.topic });

  let completionText = '';
  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: 260,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Summarize key ideas so far as tight bullets (themes, characters, conflicts, settings, constraints).` +
            ` Keep it brief and specific.\n\n` +
            humanJoined,
        },
      ],
    });

    completionText =
      completion?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('[ideaSummarizer] OpenAI error:', err);
    return { ok: false, reason: 'openai_error' };
  }

  // 5) Extract bullet notes, normalize, dedupe with existing memory
  const newNotes = completionText
    .split('\n')
    .map((s) => s.replace(/^[-•]\s?/, '').trim())
    .filter(Boolean);

  const existing = Array.isArray(room.memoryNotes) ? room.memoryNotes : [];
  const memory = Array.from(new Set([...existing, ...newNotes]));

  // 6) Persist to Rooms (single write)
  await Rooms.update(roomId, {
    ideaSummary: completionText,
    memoryNotes: memory,
    lastIdeaSummaryAt: Date.now(),
  });

  return { ok: true, summary: completionText };
}
