// api/stageEngine.js

/**
 * Stage engine v2:
 *
 * - Tracks "hot" rooms via touch(roomId)
 * - Every TICK_MS:
 *    - Detects manual stage changes (e.g., presenter hits /next)
 *      → calls onStageAdvanced(room)
 *    - Auto-advances when stageEndsAt has passed
 *      → calls onStageAdvanced(updatedRoom)
 *
 * IMPORTANT BEHAVIOR:
 * - Does NOT auto-advance out of FINAL.
 *   FINAL → CLOSED is controlled by /rooms/:roomId/final/complete.
 */

const TICK_MS = 1_000;            // how often to check (1s feels snappy)
const TOUCH_TTL_MS = 30 * 60_000; // stop tracking room if idle 30m

// Keep durations aligned with server.js STAGE_DURATIONS (ms)
export const STAGE_DURATIONS = {
  LOBBY: 10 * 60_000,       // 10 min
  DISCOVERY: 10 * 60_000,   // 10 min
  IDEA_DUMP: 3 * 60_000,    // 3 min
  PLANNING: 10 * 60_000,    // 10 min
  ROUGH_DRAFT: 4 * 60_000,  // 4 min
  EDITING: 10 * 60_000,     // 10 min
  FINAL: 6 * 60_000,        // 6 min
};

function getDurationForStage(stage) {
  if (!stage) return 6 * 60_000;
  return STAGE_DURATIONS[stage] || 6 * 60_000;
}

function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val instanceof Date) return val.getTime();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * createStageEngine
 *
 * @param {Object} deps
 * @param {Function} deps.getRoom        async (roomId) -> room
 * @param {Function} deps.updateRoom     async (roomId, patch) -> room
 * @param {Function} deps.advanceStageVal (stage: string) -> string
 * @param {Function} [deps.onStageAdvanced] async (room) -> void
 */
export function createStageEngine({
  getRoom,
  updateRoom,
  advanceStageVal,
  onStageAdvanced,
}) {
  // roomId -> lastTouch timestamp
  const hot = new Map();

  // roomId -> lastKnownStage
  const lastStage = new Map();

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
      lastStage.delete(roomId);
      return;
    }

    const room = await getRoom(roomId);
    if (!room) {
      hot.delete(roomId);
      lastStage.delete(roomId);
      return;
    }

    const stage = room.stage || 'LOBBY';
    const prevStage = lastStage.get(roomId);

    // ── 1) Detect manual stage changes (e.g., presenter hits "Next") ────────
    if (!prevStage) {
      // First time seeing this room; just record the stage
      lastStage.set(roomId, stage);
    } else if (prevStage !== stage) {
      // Stage changed outside the engine (manual or via updateRoom)
      lastStage.set(roomId, stage);
      if (onStageAdvanced) {
        await onStageAdvanced(room);
      }
    }

    // ── 2) Closed rooms can be dropped after we reacted above ──────────────
    if (stage === 'CLOSED') {
      hot.delete(roomId);
      return;
    }

    // ── 3) Do NOT auto-advance out of FINAL ────────────────────────────────
    // FINAL → CLOSED should be triggered by /final/complete,
    // which also adds the closing + final abstract messages.
    if (stage === 'FINAL') {
      return;
    }

    // ── 4) Time-based auto-advance for non-FINAL, non-CLOSED ───────────────
    let endsAtMs = toMs(room.stageEndsAt);

    // If no stageEndsAt, initialize it but don't call onStageAdvanced:
    if (!endsAtMs) {
      const dur = getDurationForStage(stage);
      const updated = await updateRoom(roomId, {
        stage,
        stageEndsAt: now + dur,
      });
      // Sync lastStage just in case:
      lastStage.set(roomId, updated.stage || stage);
      return;
    }

    if (now < endsAtMs) {
      // Still time left in this stage
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

    const finalStage = updated.stage || nextStage;
    lastStage.set(roomId, finalStage);

    if (onStageAdvanced && updated) {
      await onStageAdvanced(updated);
    }

    if (finalStage === 'CLOSED') {
      hot.delete(roomId);
      lastStage.delete(roomId);
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
          console.error('[stageEngine] tick error for', roomId, err);
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
        console.error('[stageEngine] unhandled tick error', err)
      );
    }, TICK_MS);
    if (typeof interval.unref === 'function') {
      // Don’t keep the Node process alive solely because of the engine
      interval.unref();
    }
    console.log('[stageEngine] started with durations:', STAGE_DURATIONS);
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
      console.log('[stageEngine] stopped');
    }
  }

  return { touch, start, stop };
}
