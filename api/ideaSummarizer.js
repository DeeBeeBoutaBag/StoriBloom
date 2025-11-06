// api/ideaSummarizer.js
// DynamoDB version: reads storibloom_messages by phase and writes ideaSummary/memoryNotes to storibloom_rooms.

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { personaSystemPrompt } from './asemaPersona.js';
import OpenAI from 'openai';

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLES = {
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
};

const ddb = new DynamoDBClient({ region: REGION, ...(process.env.AWS_DYNAMO_ENDPOINT ? { endpoint: process.env.AWS_DYNAMO_ENDPOINT } : {}) });
const ddbDoc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Summarize ideas for a room and store both `ideaSummary` and `memoryNotes` in storibloom_rooms.
 * It reads the room, pulls messages in the active idea phase, and writes back to the room row.
 */
export async function summarizeIdeas(roomId) {
  // Load room
  const { Item: room } = await ddbDoc.send(new GetCommand({
    TableName: TABLES.rooms,
    Key: { roomId },
  }));
  if (!room) return { ok: false, reason: 'room_not_found' };

  const stage = room.stage || 'LOBBY';
  if (stage !== 'DISCOVERY' && stage !== 'IDEA_DUMP') {
    return { ok: false, reason: 'wrong_stage' };
  }

  // Gather human messages for this phase
  // Assumes messages PK=roomId, SK=createdAt (Number), attributes {authorType, phase, text}
  const { Items } = await ddbDoc.send(new QueryCommand({
    TableName: TABLES.messages,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
    ScanIndexForward: true,
  }));
  const human = (Items || [])
    .filter(m => (m.authorType === 'user') && (m.phase === stage) && typeof m.text === 'string')
    .map(m => m.text)
    .join('\n')
    .trim();

  if (!human) {
    await ddbDoc.send(new UpdateCommand({
      TableName: TABLES.rooms,
      Key: { roomId },
      UpdateExpression: 'SET ideaSummary = :s, lastIdeaSummaryAt = :t',
      ExpressionAttributeValues: {
        ':s': '',
        ':t': Date.now(),
      },
    }));
    return { ok: true, empty: true };
  }

  const system = personaSystemPrompt({ roomTopic: room.topic });

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    max_tokens: 260,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          `Summarize key ideas so far as tight bullets (themes, characters, conflicts, settings, constraints). Keep it brief and specific.\n\n` +
          human,
      },
    ],
  });

  const summary = completion.choices?.[0]?.message?.content?.trim() || '';
  const newNotes = summary
    .split('\n')
    .map(s => s.replace(/^[-•]\s?/, '').trim())
    .filter(Boolean);

  // merge memoryNotes unique
  const memorySet = new Set([...(room.memoryNotes || []), ...newNotes]);
  const memoryNotes = Array.from(memorySet);

  await ddbDoc.send(new UpdateCommand({
    TableName: TABLES.rooms,
    Key: { roomId },
    UpdateExpression: 'SET ideaSummary = :sum, memoryNotes = :mem, lastIdeaSummaryAt = :t',
    ExpressionAttributeValues: {
      ':sum': summary,
      ':mem': memoryNotes,
      ':t': Date.now(),
    },
  }));

  return { ok: true, summary };
}
