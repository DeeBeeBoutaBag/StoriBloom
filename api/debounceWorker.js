// api/debounceWorker.js

/**
 * Per-room debounce to limit summarize calls (or any bursty work).
 * - delayMs: wait time after the last trigger (default 10s)
 * - maxWaitMs: force a run even if triggers keep coming (default 30s)
 *
 * Extra controls:
 * - cancel(roomId): cancel a scheduled run (if any)
 * - flush(roomId): run immediately if scheduled (resets window)
 * - flushAll(): run all scheduled rooms now
 * - pendingIds(): array of roomIds with scheduled runs
 * - destroy(): cancel everything (no more runs)
 */
export class DebounceWorker {
  /**
   * @param {Object} opts
   * @param {(roomId: string) => (Promise<void>|void)} opts.runFn  Work to perform
   * @param {number} [opts.delayMs=10000]                           Debounce delay
   * @param {number} [opts.maxWaitMs=30000]                         Max wait window
   * @param {(msg: string, ...args:any[])=>void} [opts.logger]      Optional logger (defaults to console.debug)
   */
  constructor({ runFn, delayMs = 10_000, maxWaitMs = 30_000, logger } = {}) {
    if (typeof runFn !== 'function') {
      throw new Error('DebounceWorker requires a runFn(roomId)');
    }
    this.runFn = runFn;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.map = new Map(); // roomId -> { timer, first, last, running }
    this._destroyed = false;
    this.log = typeof logger === 'function' ? logger : () => {};
  }

  /**
   * Schedule/refresh a run for a room.
   * @param {string} roomId
   */
  trigger(roomId) {
    if (this._destroyed) return;
    const now = Date.now();
    const state = this.map.get(roomId) || {};
    if (state.timer) clearTimeout(state.timer);

    const first = state.first ?? now;
    const last = now;
    const elapsed = now - first;

    const run = async () => {
      // Clear scheduled timer before running to avoid duplicate invokes.
      const s = this.map.get(roomId);
      if (!s) return; // canceled meanwhile
      if (s.running) return; // another run started (rare)
      s.running = true;
      this.map.set(roomId, s);

      try {
        await this.runFn(roomId);
      } catch (e) {
        console.error('[DebounceWorker] runFn error for', roomId, e);
      } finally {
        // Reset state after run; new triggers start a fresh window.
        this.map.delete(roomId);
      }
    };

    if (elapsed >= this.maxWaitMs) {
      this.log('[DebounceWorker] maxWait exceeded → running now', roomId);
      // Run ASAP
      // Avoid starving event loop if many rooms burst simultaneously
      const t = setTimeout(run, 0);
      if (typeof t.unref === 'function') t.unref();
      // No need to keep record; run() will handle cleanup
      this.map.set(roomId, { timer: t, first, last, running: false });
      return;
    }

    const wait = Math.min(this.delayMs, Math.max(0, this.maxWaitMs - elapsed));
    const timer = setTimeout(run, wait);
    if (typeof timer.unref === 'function') timer.unref();

    this.map.set(roomId, { timer, first, last, running: false });
  }

  /**
   * Cancel a scheduled run (if any) for the room.
   * @param {string} roomId
   * @returns {boolean} true if something was canceled
   */
  cancel(roomId) {
    const s = this.map.get(roomId);
    if (!s) return false;
    if (s.timer) clearTimeout(s.timer);
    this.map.delete(roomId);
    this.log('[DebounceWorker] canceled', roomId);
    return true;
    }

  /**
   * Immediately run the job for a room if it is pending; otherwise no-op.
   * @param {string} roomId
   * @returns {Promise<boolean>} true if it flushed and ran (or scheduled 0-delay), false otherwise
   */
  async flush(roomId) {
    const s = this.map.get(roomId);
    if (!s) return false;
    if (s.timer) clearTimeout(s.timer);

    // Mark running and call directly to ensure immediate execution
    this.map.set(roomId, { timer: null, first: s.first, last: s.last, running: true });
    try {
      await this.runFn(roomId);
    } catch (e) {
      console.error('[DebounceWorker] flush runFn error for', roomId, e);
    } finally {
      this.map.delete(roomId);
    }
    this.log('[DebounceWorker] flushed', roomId);
    return true;
  }

  /**
   * Flush all pending rooms immediately.
   * @returns {Promise<void>}
   */
  async flushAll() {
    const ids = Array.from(this.map.keys());
    await Promise.all(ids.map((id) => this.flush(id).catch(() => {})));
  }

  /**
   * Return a list of roomIds that currently have a scheduled run.
   * @returns {string[]}
   */
  pendingIds() {
    return Array.from(this.map.keys());
  }

  /**
   * Cancel everything and prevent future triggers from scheduling work.
   */
  destroy() {
    this._destroyed = true;
    for (const [roomId, s] of this.map.entries()) {
      if (s.timer) clearTimeout(s.timer);
      this.map.delete(roomId);
    }
    this.log('[DebounceWorker] destroyed');
  }
}
