// api/stageEngine.js

/**
 * Lightweight stage engine:
 * - Tracks "hot" rooms (that have recent activity).
 * - Every TICK_MS checks if stageEndsAt has passed.
 * - If passed and stage !== 'CLOSED', advances to next stage.
 *
 * Durations:
 * - LOBBY: 10 minutes
 * - All other stages: 6 minutes
 *
 * server.js passes:
 * - getRoom(roomId)
 * - updateRoom(roomId, patch)
 * - advanceStageVal(currentStage)
 * - onStageAdvanced?(updatedRoom)
 */

const TICK_MS = 5_000;           // how often to check
const TOUCH_TTL_MS = 30 * 60_000; // stop tracking room if idle 30m

// Central place for durations (ms)
const STAGE_DURATIONS = {
  LOBBY: 10 * 60_000,
  DISCOVERY: 6 * 60_000,
  IDEA_DUMP: 6 * 60_000,
  PLANNING: 6 * 60_000,
  ROUGH_DRAFT: 6 * 60_000,
  EDITING: 6 * 60_000,
  FINAL: 6 * 60_000,
};

function getDurationForStage(stage) {
  if (!stage) return 6 * 60_000;
  return STAGE_DURATIONS[stage] || 6 * 60_000;
}

export function createStageEngine({ getRoom, updateRoom, advanceStageVal, onStageAdvanced }) {
  // roomId -> lastTouch
  const hot = new Map();

  function touch(roomId) {
    if (!roomId) return;
    hot.set(roomId, Date.now());
  }

  async function handleRoom(roomId, now) {
    const lastTouch = hot.get(roomId);
    if (!lastTouch || now - lastTouch > TOUCH_TTL_MS) {
      hot.delete(roomId);
      return;
    }

    const room = await getRoom(roomId);
    if (!room) {
      hot.delete(roomId);
      return;
    }

    const stage = room.stage || 'LOBBY';
    if (stage === 'CLOSED') return;

    // Normalize stageEndsAt → timestamp
    let endsAtMs = 0;
    if (typeof room.stageEndsAt === 'number') {
      endsAtMs = room.stageEndsAt;
    } else if (room.stageEndsAt instanceof Date) {
      endsAtMs = room.stageEndsAt.getTime();
    } else if (room.stageEndsAt) {
      const d = new Date(room.stageEndsAt);
      if (!isNaN(d.getTime())) endsAtMs = d.getTime();
    }

    // If no stageEndsAt yet, set it based on current stage
    if (!endsAtMs) {
      const dur = getDurationForStage(stage);
      const updated = await updateRoom(roomId, {
        stage,
        stageEndsAt: now + dur,
      });
      if (onStageAdvanced && updated) {
        // Treat as "initialized" rather than advanced
        await onStageAdvanced(updated);
      }
      return;
    }

    // If it's not time yet, do nothing
    if (now < endsAtMs) return;

    // Time's up → advance
    const nextStage = advanceStageVal(stage);
    if (!nextStage || nextStage === stage) return;

    const nextDur = getDurationForStage(nextStage);
    const updated = await updateRoom(roomId, {
      stage: nextStage,
      stageEndsAt: now + nextDur,
    });

    if (onStageAdvanced && updated) {
      await onStageAdvanced(updated);
    }
  }

  async function tick() {
    const now = Date.now();
    const ids = Array.from(hot.keys());
    if (!ids.length) return;

    for (const roomId of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await handleRoom(roomId, now);
      } catch (err) {
        console.error('[stageEngine] tick error for', roomId, err);
      }
    }
  }

  function start() {
    setInterval(() => {
      tick().catch((err) => console.error('[stageEngine] unhandled tick error', err));
    }, TICK_MS);
    console.log('[stageEngine] started with durations:', STAGE_DURATIONS);
  }

  return { touch, start };
}

// Also export durations if you ever want to reuse in server.js
export { STAGE_DURATIONS };
