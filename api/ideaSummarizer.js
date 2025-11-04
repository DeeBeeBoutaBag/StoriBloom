import { personaSystemPrompt } from './asemaPersona.js';

/**
 * Summarize ideas for a room and store both `ideaSummary` and `memoryNotes`.
 * Runs OpenAI once and writes results to Firestore.
 */
export async function summarizeIdeas({ db, openai }, roomId) {
  // load room
  const roomRef = db.collection('rooms').doc(roomId);
  const roomDoc = await roomRef.get();
  if (!roomDoc.exists) return { ok: false, reason: 'room_not_found' };

  const room = roomDoc.data();
  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') {
    return { ok: false, reason: 'wrong_stage' };
  }

  // gather messages for current stage
  const msgsSnap = await roomRef.collection('messages')
    .where('phase', '==', stage)
    .orderBy('createdAt', 'asc')
    .get();

  const human = msgsSnap.docs
    .map(d => d.data())
    .filter(m => m.authorType === 'user')
    .map(m => m.text)
    .join('\n');

  // nothing to summarize
  if (!human.trim()) {
    await roomRef.update({ ideaSummary: '', lastIdeaSummaryAt: new Date() });
    return { ok: true, empty: true };
  }

  const system = personaSystemPrompt({ roomTopic: room.topic });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    max_tokens: 260,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          `Summarize key ideas so far as tight bullets (themes, characters, conflicts, settings, constraints).` +
          ` Keep it brief and specific.\n\n` + human
      }
    ]
  });

  const summary = completion.choices?.[0]?.message?.content?.trim() || '';
  const newNotes = summary
    .split('\n')
    .map(s => s.replace(/^[-•]\s?/, '').trim())
    .filter(Boolean);

  // merge into memoryNotes (dedupe)
  const memory = Array.from(new Set([...(room.memoryNotes || []), ...newNotes]));

  await roomRef.update({
    ideaSummary: summary,
    memoryNotes: memory,
    lastIdeaSummaryAt: new Date()
  });

  return { ok: true, summary };
}
