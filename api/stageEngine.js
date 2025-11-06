// api/stageEngine.js
// Periodic stage advancement using storibloom_rooms only.

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLE_ROOMS = process.env.DDB_TABLE_ROOMS || 'storibloom_rooms';

const ddb = new DynamoDBClient({ region: REGION, ...(process.env.AWS_DYNAMO_ENDPOINT ? { endpoint: process.env.AWS_DYNAMO_ENDPOINT } : {}) });
const ddbDoc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

const ORDER = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL','CLOSED'];

function nextStageVal(cur) {
  const i = ORDER.indexOf(cur || 'LOBBY');
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : (cur || 'LOBBY');
}

export async function setStage(roomId, action) {
  const { Item: room } = await ddbDoc.send(new GetCommand({ TableName: TABLE_ROOMS, Key: { roomId } }));
  if (!room) return;

  let next = room.stage || 'LOBBY';
  if (action === 'NEXT') next = nextStageVal(next);
  if (action === 'REDO') next = 'ROUGH_DRAFT';

  const endsAt = Date.now() + 10 * 60 * 1000;
  const updated = { ...(room || {}), roomId, stage: next, stageEndsAt: endsAt, updatedAt: Date.now() };
  await ddbDoc.send(new PutCommand({ TableName: TABLE_ROOMS, Item: updated }));
  console.log(`[stageEngine] ${roomId} → ${next}`);
}

export async function extendStage(roomId, minutes) {
  const { Item: room } = await ddbDoc.send(new GetCommand({ TableName: TABLE_ROOMS, Key: { roomId } }));
  if (!room) return;
  const cur = typeof room.stageEndsAt === 'number' ? room.stageEndsAt : Date.now();
  const extended = cur + Math.max(1, minutes) * 60 * 1000;
  const updated = { ...(room || {}), roomId, stageEndsAt: extended, updatedAt: Date.now() };
  await ddbDoc.send(new PutCommand({ TableName: TABLE_ROOMS, Item: updated }));
  console.log(`[stageEngine] extended ${roomId} by ${minutes}m`);
}

export function startStageLoop() {
  // Every 10s, scan rooms and advance expired ones (cheap for small counts)
  setInterval(async () => {
    const now = Date.now();
    try {
      const scan = await ddbDoc.send(new ScanCommand({ TableName: TABLE_ROOMS, Limit: 200 }));
      for (const r of scan.Items || []) {
        if (r.stage && r.stage !== 'CLOSED' && typeof r.stageEndsAt === 'number' && r.stageEndsAt < now) {
          await setStage(r.roomId, 'NEXT');
        }
      }
    } catch (e) {
      console.warn('[stageEngine] loop error', e?.message || e);
    }
  }, 10_000);
}
