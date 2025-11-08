// api/stageEngine.js

// Simple stage engine that:
// - ticks once per second
// - advances any "hot" room whose stageEndsAt has passed
// - "hot" means it was touched recently (API traffic) or on codes/consume
//
// Usage:
// const engine = createStageEngine({...}); engine.start(); engine.touch(roomId);

export function createStageEngine({ getRoom, updateRoom, advanceStageVal, onStageAdvanced }) {
  const HOT_TTL_MS = 5 * 60_000; // keep rooms hot for 5 minutes after traffic
  const MIN_STAGE_MS = 15_000;   // if a room has no stageEndsAt, give it at least 15s
  const touched = new Map();     // roomId -> lastTouchedMs
  let timer = null;

  function touch(roomId) {
    touched.set(roomId, Date.now());
  }

  async function tick() {
    const now = Date.now();
    for (const [roomId, ts] of [...touched.entries()]) {
      if (now - ts > HOT_TTL_MS) {
        touched.delete(roomId);     // cool it down
        continue;
      }
      try {
        const r = await getRoom(roomId);
        if (!r) continue;
        let endsAt = Number(r.stageEndsAt || 0);
        if (!Number.isFinite(endsAt) || endsAt <= now) {
          // Advance stage or ensure stageEndsAt is set
          const nextStage = Number.isFinite(endsAt) && endsAt <= now
            ? advanceStageVal(r.stage || 'LOBBY')
            : (r.stage || 'LOBBY');
          const dur = 2 * 60_000; // default 2 minutes each stage for demo
          const updated = await updateRoom(roomId, {
            stage: nextStage,
            stageEndsAt: now + dur,
          });
          if (onStageAdvanced && updated.stage === nextStage) {
            await onStageAdvanced(updated);
          }
        }
      } catch (e) {
        // keep ticking even if a room throws
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 1000);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, touch };
}
