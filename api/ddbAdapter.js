// api/ddbAdapter.js
import { ddb } from './ddbClient.js';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Table name resolution
 * - Works with either DDB_TABLE_* (preferred) OR the simpler TABLE_* names (compat with your server.js)
 * - Provides sensible defaults for local/dev
 */
const T = {
  sites:
    process.env.DDB_TABLE_SITES ||
    process.env.TABLE_SITES ||
    'storibloom_sites',
  rooms:
    process.env.DDB_TABLE_ROOMS ||
    process.env.TABLE_ROOMS ||
    'storibloom_rooms',
  codes:
    process.env.DDB_TABLE_CODES ||
    process.env.TABLE_CODES ||
    'storibloom_codes',
  messages:
    process.env.DDB_TABLE_MESSAGES ||
    process.env.TABLE_MESSAGES ||
    'storibloom_messages',
  drafts:
    process.env.DDB_TABLE_DRAFTS ||
    process.env.TABLE_DRAFTS ||
    'storibloom_drafts',
  submissions:
    process.env.DDB_TABLE_SUBMISSIONS ||
    process.env.TABLE_SUBMISSIONS ||
    'storibloom_submissions',
  personas:
    process.env.DDB_TABLE_PERSONAS ||
    process.env.TABLE_PERSONAS ||
    'storibloom_personas',
  sessions:
    process.env.DDB_TABLE_SESSIONS ||
    process.env.TABLE_SESSIONS ||
    'storibloom_sessions',
};

const nowMs = () => Date.now();

function assertTable(name, value) {
  if (!value) {
    throw new Error(
      `[ddbAdapter] Missing table name for ${name}. Set DDB_TABLE_${name.toUpperCase()} or TABLE_${name.toUpperCase()}.`,
    );
  }
}

/* =========================
   Codes
   - PK: code (string)
   - attrs we touch: consumed (bool), consumedAt (number ms), usedBy (string uid)
   ========================= */
export const Codes = {
  /**
   * consume(code, uid) → { siteId, role } | { error: "not_found" | "used" | "invalid_*" }
   * Idempotent-ish via conditional update.
   */
  async consume(code, uid) {
    assertTable('codes', T.codes);
    if (!code || typeof code !== 'string') {
      return { error: 'invalid_code' };
    }
    if (!uid || typeof uid !== 'string') {
      return { error: 'invalid_uid' };
    }

    // 1) Get item
    const { Item } = await ddb.send(
      new GetCommand({ TableName: T.codes, Key: { code } }),
    );
    if (!Item) return { error: 'not_found' };
    if (Item.consumed) return { error: 'used' };

    // 2) Mark consumed (only if not already consumed)
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: T.codes,
          Key: { code },
          UpdateExpression:
            'SET consumed = :c, consumedAt = :ca, usedBy = :u',
          ConditionExpression:
            'attribute_not_exists(consumed) OR consumed = :f',
          ExpressionAttributeValues: {
            ':c': true,
            ':f': false,
            ':ca': nowMs(),
            ':u': uid,
          },
        }),
      );
    } catch (err) {
      // If condition fails due to race, treat as used
      if (String(err?.name || '').includes('ConditionalCheckFailed')) {
        return { error: 'used' };
      }
      throw err;
    }

    return { siteId: Item.siteId, role: Item.role || 'PARTICIPANT' };
  },
};

/* =========================
   Rooms
   - PK: roomId (string)
   - Upsert replace (idempotent)
   ========================= */
export const Rooms = {
  async get(roomId) {
    assertTable('rooms', T.rooms);
    if (!roomId) return null;
    const { Item } = await ddb.send(
      new GetCommand({ TableName: T.rooms, Key: { roomId } }),
    );
    return Item || null;
  },

  /**
   * Shallow merge patch into existing room row and upsert.
   * Returns the full updated item.
   */
  async update(roomId, patch) {
    assertTable('rooms', T.rooms);
    if (!roomId || typeof patch !== 'object' || !patch) {
      throw new Error('[Rooms.update] invalid args');
    }
    const existing = await this.get(roomId);
    const next = {
      ...(existing || {}),
      ...patch,
      roomId,
      updatedAt: nowMs(),
    };
    await ddb.send(new PutCommand({ TableName: T.rooms, Item: next }));
    return next;
  },
};

/* =========================
   Messages
   - PK: roomId (string), SK: createdAt (number)    <-- recommended schema
   - add(): Put a new message
   - byPhase(): Query partition & filter by phase (cheap for small rooms; add GSI for scale)
   ========================= */
export const Messages = {
  /**
   * add({ roomId, uid, personaIndex, authorType, phase, text, emoji? }) → { createdAt }
   *
   * authorType:
   *   - 'user'   (default for participants)
   *   - 'asema'  (our AI persona)
   *   - 'system' (system notices)
   */
  async add({ roomId, uid, personaIndex, authorType, phase, text, emoji }) {
    assertTable('messages', T.messages);
    if (!roomId || !text) {
      throw new Error('[Messages.add] roomId & text required');
    }

    const createdAt = nowMs();
    await ddb.send(
      new PutCommand({
        TableName: T.messages,
        Item: {
          roomId,
          createdAt,
          uid: uid || null,
          personaIndex: typeof personaIndex === 'number' ? personaIndex : 0,
          // Normalize to the same lower-case convention used elsewhere in the app
          authorType: (authorType || 'user').toLowerCase(), // 'user' | 'asema' | 'system'
          phase: phase || null,
          text,
          emoji: emoji || null,
        },
      }),
    );
    return { createdAt };
  },

  /**
   * byPhase(roomId, phase) → messages[]
   *
   * Queries all messages for a room and filters by phase.
   * For very large rooms, consider adding a GSI on (roomId, phase).
   */
  async byPhase(roomId, phase) {
    assertTable('messages', T.messages);
    if (!roomId || !phase) return [];

    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: T.messages,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: {
          ':r': roomId,
        },
        ScanIndexForward: true,
      }),
    );

    return (Items || []).filter((m) => (m.phase || '') === phase);
  },
};

/* =========================
   Drafts
   - PK: roomId (string), SK: createdAt (number)
   - add(): create new draft version
   - latest(): Query desc, Limit 1
   ========================= */
export const Drafts = {
  async add({ roomId, content, version }) {
    assertTable('drafts', T.drafts);
    if (!roomId || !content) {
      throw new Error('[Drafts.add] roomId & content required');
    }

    await ddb.send(
      new PutCommand({
        TableName: T.drafts,
        Item: {
          roomId,
          createdAt: nowMs(),
          content,
          version: version ?? 1,
        },
      }),
    );
  },

  async latest(roomId) {
    assertTable('drafts', T.drafts);
    if (!roomId) return null;

    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: T.drafts,
        KeyConditionExpression: 'roomId = :r',
        ExpressionAttributeValues: { ':r': roomId },
        ScanIndexForward: false, // newest first
        Limit: 1,
      }),
    );
    return (Items && Items[0]) || null;
  },
};
