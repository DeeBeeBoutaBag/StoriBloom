// api/stageEngine.js
// Replaces Firestore with DynamoDB.
// Persists { stage, stageEndsAt } on the Rooms item.
// stageEndsAt is stored as a Number (ms since epoch).

import { Rooms } from './ddbAdapter.js';
import { ddb } from './ddbClient.js';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

// Immutable list of valid stages
export const STAGES = Object.freeze([
  'LOBBY',
  'DISCOVERY',
  'IDEA_DUMP',
  'PLANNING',
  'ROUGH_DRAFT',
  'EDITING',
  'FINAL',
  'CLOSED',
]);

// Resolve table name (matches logic used elsewhere)
const ROOMS_TABLE =
  process.env.DDB_TABLE_ROOMS || process.env.TABLE_ROOMS || 'storibloom_rooms';

function assertRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') {
    throw new Error('[stageEngine] roomId is required');
  }
}

function clampStage(stage) {
  const s = (stage || 'LOBBY').toString().toUpperCase();
  return STAGES.includes(s) ? s : 'LOBBY';
}

function nextStageFrom(current, action) {
  const stage = clampStage(current);
  const idx = STAGES.indexOf(stage);

  if (action === 'REDO') return 'ROUGH_DRAFT';
  if (action === 'NEXT') {
    if (idx >= 0 && idx < STAGES.length - 1) return STAGES[idx + 1];
    return STAGES[STAGES.length - 1]; // already at end
  }
  // Default: no change
  return stage;
}

/**
 * Set next stage for room based on action.
 * - action: "NEXT" | "REDO"
 * - resets stageEndsAt to now + 10 minutes
 */
export async function setStage(roomId, action) {
  assertRoomId(roomId);

  const room = await Rooms.get(roomId);
  if (!room) return; // silently no-op if room not found (preserving original behavior)

  const current = clampStage(room.stage);
  const next = nextStageFrom(current, action);
  const endsAtMs = Date.now() + 10 * 60 * 1000; // +10 min

  await Rooms.update(roomId, { stage: next, stageEndsAt: endsAtMs });
  console.log(`[stageEngine] ${roomId} ${current} → ${next} (ends ~${new Date(endsAtMs).toISOString()})`);
}

/**
 * Extend the current stage by N minutes (default behavior preserved).
 */
export async function extendStage(roomId, minutes) {
  assertRoomId(roomId);

  const room = await Rooms.get(roomId);
  if (!room) return; // no-op if missing

  const base = typeof room.stageEndsAt === 'number' ? room.stageEndsAt : Date.now();
  const extended = base + (Number(minutes) || 0) * 60 * 1000;

  await Rooms.update(roomId, { stageEndsAt: extended });
  console.log(`[stageEngine] extended ${roomId} by ${minutes}m (new end ${new Date(extended).toISOString()})`);
}

/**
 * Start a loop that auto-advances any room whose stage window expired.
 * Uses a DynamoDB Scan + FilterExpression (fine for small/medium datasets).
 * Returns a stop() function.
 *
 * Options:
 *   - intervalMs: how often to check (default 10s)
 *   - onlyIfNotClosed: skip rooms where stage === 'CLOSED' (default true)
 */
export function startStageLoop({ intervalMs = 10_000, onlyIfNotClosed = true } = {}) {
  let stopping = false;

  const tick = async () => {
    if (stopping) return;
    const now = Date.now();

    // We use Scan with a FilterExpression:
    //   stageEndsAt <= :now
    //   AND (stage <> :closed)  (if onlyIfNotClosed)
    // Note: stageEndsAt is a Number; stage is a String
    const filterParts = ['stageEndsAt <= :now'];
    const exprValues = { ':now': now };
    if (onlyIfNotClosed) {
      filterParts.push('#s <> :closed');
      exprValues[':closed'] = 'CLOSED';
    }

    try {
      let ExclusiveStartKey;
      do {
        const res = await ddb.send(
          new ScanCommand({
            TableName: ROOMS_TABLE,
            FilterExpression: filterParts.join(' AND '),
            ExpressionAttributeValues: exprValues,
            ExpressionAttributeNames: onlyIfNotClosed ? { '#s': 'stage' } : undefined,
            ExclusiveStartKey,
            Limit: 50, // page size; tweak as needed
          })
        );

        const items = res.Items || [];
        for (const item of items) {
          const roomId = item.roomId;
          const currentStage = clampStage(item.stage);
          if (!roomId) continue;

          // If already CLOSED, skip (defense in depth)
          if (onlyIfNotClosed && currentStage === 'CLOSED') continue;

          // Advance to NEXT stage
          try {
            await setStage(roomId, 'NEXT');
          } catch (e) {
            console.error('[stageEngine] error advancing', roomId, e);
          }
        }

        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
    } catch (err) {
      console.error('[stageEngine] scan error', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[stageEngine] loop started (interval ${intervalMs}ms)`);
  return function stop() {
    stopping = true;
    clearInterval(timer);
    console.log('[stageEngine] loop stopped');
  };
}
