// Legacy compatibility shim.
// Stage progression is now persisted and advanced with DynamoDB conditional writes in server.js
// so behavior is multi-instance safe under horizontal scaling.

export const STAGE_DURATIONS = {
  LOBBY: 1200 * 1000,
  DISCOVERY: 600 * 1000,
  IDEA_DUMP: 600 * 1000,
  PLANNING: 600 * 1000,
  ROUGH_DRAFT: 240 * 1000,
  EDITING: 600 * 1000,
  FINAL: 360 * 1000,
};

export function createStageEngine() {
  return {
    touch() {},
    start() {},
    stop() {},
  };
}
