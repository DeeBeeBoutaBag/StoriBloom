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
 * - getMaxStageForRoom?(room) -> string stage name (e.g., 'FINAL') at which we should close the room
 */

const TICK_MS = 5_000;            // how often to check
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

export function createStageEngine({
  getRoom,
  updateRoom,
  advanceStageVal,
  onStageAdvanced,
  getMaxStageForRoom, // optional: (room) => 'FINAL' | 'EDITING' | ...
}) {
  // roomId -> lastTouch timestamp
  const hot = new Map();

  let interval = null;
  let ticking = false;

  function touch(roomId) {
    if (!roomId) return;
    hot.set(roomId, Date.now());
  }

  async function handleRoom(roomId, now) {
    const lastTouch = hot.get(roomId);
    if (!lastTouch || now - lastTouch > TOUCH_TTL_MS) {
      // Room has gone cold – stop tracking
      hot.delete(roomId);
      return;
    }

    const room = await getRoom(roomId);
    if (!room) {
      hot.delete(roomId);
      return;
    }

    const stage = room.stage || "LOBBY";
    if (stage === "CLOSED") {
      // Once closed, we can drop it from tracking
      hot.delete(roomId);
      return;
    }

    // Normalize stageEndsAt → timestamp
    let endsAtMs = 0;
    if (typeof room.stageEndsAt === "number") {
      endsAtMs = room.stageEndsAt;
    } else if (room.stageEndsAt instanceof Date) {
      endsAtMs = room.stageEndsAt.getTime();
    } else if (room.stageEndsAt) {
      const d = new Date(room.stageEndsAt);
      if (!Number.isNaN(d.getTime())) endsAtMs = d.getTime();
    }

    // If no stageEndsAt yet, set it based on current stage (initialization only).
    // NOTE: we intentionally DO NOT call onStageAdvanced here — this is not a real "advance",
    // just fixing missing timers.
    if (!endsAtMs) {
      const dur = getDurationForStage(stage);
      await updateRoom(roomId, {
        stage,
        stageEndsAt: now + dur,
      });
      return;
    }

    // If it's not time yet, do nothing
    if (now < endsAtMs) return;

    // ---- Per-room max stage handling ----
    let maxStage = null;
    if (typeof getMaxStageForRoom === "function") {
      try {
        maxStage = getMaxStageForRoom(room) || null;
      } catch (err) {
        console.error("[stageEngine] getMaxStageForRoom error for", roomId, err);
      }
    }

    // If this room has a maxStage and we're at it, closing logic:
    if (maxStage && stage === maxStage) {
      const updated = await updateRoom(roomId, {
        stage: "CLOSED",
        stageEndsAt: now, // mark as ended now
      });

      // Stop tracking once closed
      hot.delete(roomId);

      if (onStageAdvanced && updated) {
        // Treat moving into CLOSED as a final "advanced" event
        await onStageAdvanced(updated);
      }
      return;
    }

    // Time's up → normal advance
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

    // If we advanced into CLOSED (based on your ROOM_ORDER/advanceStageVal),
    // drop from hot after notifying.
    if (updated.stage === "CLOSED") {
      hot.delete(roomId);
    }
  }

  async function tick() {
    if (ticking) return; // prevent overlapping ticks under load
    ticking = true;
    try {
      const now = Date.now();
      const ids = Array.from(hot.keys());
      if (!ids.length) return;

      // Process rooms sequentially to avoid hammering DynamoDB
      for (const roomId of ids) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await handleRoom(roomId, now);
        } catch (err) {
          console.error("[stageEngine] tick error for", roomId, err);
        }
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      tick().catch((err) =>
        console.error("[stageEngine] unhandled tick error", err)
      );
    }, TICK_MS);
    if (typeof interval.unref === "function") {
      // Don’t keep the Node process alive solely because of the engine
      interval.unref();
    }
    console.log("[stageEngine] started with durations:", STAGE_DURATIONS);
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
      console.log("[stageEngine] stopped");
    }
  }

  return { touch, start, stop };
}

// Also export durations if you ever want to reuse in server.js
export { STAGE_DURATIONS };
