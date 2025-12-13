// api/stageEngine.js

/**
 * Stage Engine v3 (Authoritative)
 *
 * Responsibilities:
 * - Track “hot” rooms (recently active)
 * - Detect stage transitions (manual or timed)
 * - Auto-advance stages EXCEPT FINAL
 * - Fire onStageAdvanced(room) EXACTLY ONCE per stage change
 *
 * IMPORTANT RULES:
 * - FINAL never auto-advances
 * - FINAL → CLOSED is handled by server logic (timeout or all-done)
 * - CLOSED rooms are dropped from tracking
 */

const TICK_MS = 1_000;            // 1s tick
const TOUCH_TTL_MS = 30 * 60_000; // 30 min inactivity window

// Must stay aligned with server.js STAGE_DURATIONS
export const STAGE_DURATIONS = {
   LOBBY: 1200 * 1000, // 10 min (adjust if desired)
  DISCOVERY: 600 * 1000, // 10 min
  IDEA_DUMP: 600 * 1000, // 10 min
  PLANNING: 600 * 1000, // 10 min
  ROUGH_DRAFT: 240 * 1000, // 4 min
  EDITING: 600 * 1000, // 10 min
  FINAL: 360 * 1000, // 6 min
};

function durationFor(stage) {
  return STAGE_DURATIONS[stage] || 6 * 60_000;
}

function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * createStageEngine
 */
export function createStageEngine({
  getRoom,
  updateRoom,
  advanceStageVal,
  onStageAdvanced,
}) {
  // roomId → last activity timestamp
  const hot = new Map();

  // roomId → last known stage (prevents duplicate greetings)
  const lastStage = new Map();

  let interval = null;
  let ticking = false;

  /**
   * Mark a room as active
   */
  function touch(roomId) {
    if (!roomId) return;
    hot.set(roomId, Date.now());
  }

  async function handleRoom(roomId, now) {
    const lastTouch = hot.get(roomId);
    if (!lastTouch || now - lastTouch > TOUCH_TTL_MS) {
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

    // ─────────────────────────────────────────────
    // 1️⃣ Detect stage transitions (manual or timed)
    // ─────────────────────────────────────────────
    if (!prevStage) {
      lastStage.set(roomId, stage);
    } else if (prevStage !== stage) {
      lastStage.set(roomId, stage);
      if (onStageAdvanced) {
        await onStageAdvanced(room);
      }
    }

    // ─────────────────────────────────────────────
    // 2️⃣ CLOSED rooms are terminal
    // ─────────────────────────────────────────────
    if (stage === 'CLOSED') {
      hot.delete(roomId);
      lastStage.delete(roomId);
      return;
    }

    // ─────────────────────────────────────────────
    // 3️⃣ FINAL NEVER auto-advances
    // (server.js handles FINAL → CLOSED)
    // ─────────────────────────────────────────────
    if (stage === 'FINAL') {
      return;
    }

    // ─────────────────────────────────────────────
    // 4️⃣ Auto-advance timed stages
    // ─────────────────────────────────────────────
    let endsAtMs = toMs(room.stageEndsAt);

    // Initialize timer if missing
    if (!endsAtMs) {
      const dur = durationFor(stage);
      const updated = await updateRoom(roomId, {
        stage,
        stageEndsAt: now + dur,
      });
      lastStage.set(roomId, updated.stage || stage);
      return;
    }

    // Still time left
    if (now < endsAtMs) return;

    // Time expired → advance
    const nextStage = advanceStageVal(stage);
    if (!nextStage || nextStage === stage) return;

    const nextDur = durationFor(nextStage);
    const updated = await updateRoom(roomId, {
      stage: nextStage,
      stageEndsAt: now + nextDur,
    });

    lastStage.set(roomId, updated.stage || nextStage);

    if (onStageAdvanced) {
      await onStageAdvanced(updated);
    }

    if (updated.stage === 'CLOSED') {
      hot.delete(roomId);
      lastStage.delete(roomId);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const roomIds = Array.from(hot.keys());
      if (!roomIds.length) return;

      // Sequential to protect DynamoDB
      for (const roomId of roomIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await handleRoom(roomId, now);
        } catch (err) {
          console.error('[stageEngine] room error:', roomId, err);
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
        console.error('[stageEngine] tick failure', err)
      );
    }, TICK_MS);

    if (typeof interval.unref === 'function') {
      interval.unref();
    }

    console.log('[stageEngine] started');
  }

  function stop() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
    console.log('[stageEngine] stopped');
  }

  return {
    touch,
    start,
    stop,
  };
}
