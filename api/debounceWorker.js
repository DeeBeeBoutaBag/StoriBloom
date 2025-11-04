// api/debounceWorker.js

/**
 * Per-room debounce to limit summarize calls.
 * - delay: wait time after last trigger (default 10s)
 * - maxWait: ensure it runs even if triggers keep coming (default 30s)
 */
export class DebounceWorker {
  constructor({ runFn, delayMs = 10_000, maxWaitMs = 30_000 }) {
    this.runFn = runFn;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.map = new Map(); // roomId -> { t, first, last }
  }

  trigger(roomId) {
    const now = Date.now();
    const item = this.map.get(roomId) || {};
    clearTimeout(item.t);

    const first = item.first ?? now;
    const last = now;

    const wait = this.delayMs;
    const timeSinceFirst = now - first;
    const remaining = Math.max(0, this.maxWaitMs - timeSinceFirst);

    const run = async () => {
      // cleanup before run to avoid double triggers
      this.map.delete(roomId);
      try {
        await this.runFn(roomId);
      } catch (e) {
        // swallow errors; next trigger will schedule again
        console.error('[DebounceWorker] runFn error for', roomId, e);
      }
    };

    // If we've exceeded maxWait, run immediately
    if (timeSinceFirst >= this.maxWaitMs) {
      run();
      return;
    }

    // otherwise schedule after delay (but not longer than remaining maxWait)
    const t = setTimeout(run, Math.min(wait, remaining));
    this.map.set(roomId, { t, first, last });
  }
}
