// api/ideaSummarizer.js
// DynamoDB version: reads storibloom_messages by phase and writes
// ideaSummary / memoryNotes to storibloom_rooms.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

import { personaSystemPrompt } from './asemaPersona.js';
import { getOpenAI } from './openaiClient.js';

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLES = {
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
};

const ddb = new DynamoDBClient({
  region: REGION,
  ...(process.env.AWS_DYNAMO_ENDPOINT
    ? { endpoint: process.env.AWS_DYNAMO_ENDPOINT }
    : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Only summarize in these stages (aligned with server.js)
const IDEA_STAGES = new Set(['DISCOVERY', 'IDEA_DUMP', 'PLANNING']);

/**
 * Summarize ideas for a room and store both `ideaSummary` and `memoryNotes`
 * in storibloom_rooms.
 *
 * Reads the room, pulls human messages in the active idea phase(s),
 * and writes back to the room row.
 */
export async function summarizeIdeas(roomId) {
  try {
    if (!roomId) {
      return { ok: false, reason: 'missing_roomId' };
    }

    // Load room
    const { Item: room } = await ddbDoc.send(
      new GetCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
      })
    );
    if (!room) return { ok: false, reason: 'room_not_found' };

    const stage = room.stage || 'LOBBY';
    if (!IDEA_STAGES.has(stage)) {
      return { ok: false, reason: 'wrong_stage' };
    }

    // Gather human messages for DISCOVERY / IDEA_DUMP / PLANNING
    const { Items } = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLES.messages,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: { ':r': roomId },
        ScanIndexForward: true,
      })
    );

    const phases = ['DISCOVERY', 'IDEA_DUMP', 'PLANNING'];
    const all = (Items || []).filter(
      (m) =>
        (m.authorType || 'user') === 'user' &&
        phases.includes(m.phase || '') &&
        typeof m.text === 'string'
    );

    if (!all.length) {
      await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression:
            'SET ideaSummary = :s, lastIdeaSummaryAt = :t',
          ExpressionAttributeValues: {
            ':s': '',
            ':t': Date.now(),
          },
        })
      );
      return { ok: true, empty: true };
    }

    // Trim to last N messages to control tokens
    const MAX_MESSAGES = 120;
    const recent = all.slice(-MAX_MESSAGES);
    const human = recent
      .map((m) => m.text)
      .join('\n')
      .trim();

    if (!human) {
      await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLES.rooms,
          Key: { roomId },
          UpdateExpression:
            'SET ideaSummary = :s, lastIdeaSummaryAt = :t',
          ExpressionAttributeValues: {
            ':s': '',
            ':t': Date.now(),
          },
        })
      );
      return { ok: true, empty: true };
    }

    const system = personaSystemPrompt({ roomTopic: room.topic });

    const client = getOpenAI();
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      max_tokens: 260,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Summarize the group’s key ideas so far as tight bullets for an "Idea Board" (themes, characters, conflicts, settings, constraints). ` +
            `Be brief, concrete, and specific — 4–8 bullets max.\n\n` +
            human,
        },
      ],
    });

    const summary =
      completion.choices?.[0]?.message?.content?.trim() || '';

    const newNotes = summary
      .split('\n')
      .map((s) => s.replace(/^[-•]\s?/, '').trim())
      .filter(Boolean);

    // Merge memoryNotes unique
    const memorySet = new Set([
      ...(Array.isArray(room.memoryNotes) ? room.memoryNotes : []),
      ...newNotes,
    ]);
    const memoryNotes = Array.from(memorySet);

    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLES.rooms,
        Key: { roomId },
        UpdateExpression:
          'SET ideaSummary = :sum, memoryNotes = :mem, lastIdeaSummaryAt = :t',
        ExpressionAttributeValues: {
          ':sum': summary,
          ':mem': memoryNotes,
          ':t': Date.now(),
        },
      })
    );

    return { ok: true, summary };
  } catch (err) {
    console.error('[ideaSummarizer] summarizeIdeas error', err);
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  }
}
