import { ddb } from "./ddbClient.js";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const T = {
  sites: process.env.DDB_TABLE_SITES,
  rooms: process.env.DDB_TABLE_ROOMS,
  codes: process.env.DDB_TABLE_CODES,
  messages: process.env.DDB_TABLE_MESSAGES,
  drafts: process.env.DDB_TABLE_DRAFTS,
  submissions: process.env.DDB_TABLE_SUBMISSIONS,
  personas: process.env.DDB_TABLE_PERSONAS,
  sessions: process.env.DDB_TABLE_SESSIONS,
};

// Helpers
const nowMs = () => Date.now();

export const Codes = {
  async consume(code, uid) {
    const { Item } = await ddb.send(new GetCommand({ TableName: T.codes, Key: { code } }));
    if (!Item) return { error: "not_found" };
    if (Item.consumed) return { error: "used" };
    await ddb.send(new UpdateCommand({
      TableName: T.codes,
      Key: { code },
      UpdateExpression: "set consumed = :c, consumedAt = :ca, usedByUid = :u",
      ConditionExpression: "attribute_not_exists(consumed) OR consumed = :f",
      ExpressionAttributeValues: { ":c": true, ":f": false, ":ca": nowMs(), ":u": uid },
    }));
    return { siteId: Item.siteId, role: Item.role };
  },
};

export const Rooms = {
  async get(roomId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: T.rooms, Key: { roomId } }));
    return Item || null;
  },
  async update(roomId, patch) {
    // simple replace (idempotent)
    const existing = await this.get(roomId);
    const next = { ...(existing||{}), ...patch, roomId };
    await ddb.send(new PutCommand({ TableName: T.rooms, Item: next }));
    return next;
  },
};

export const Messages = {
  async add({ roomId, uid, personaIndex, authorType, phase, text }) {
    const createdAt = nowMs();
    await ddb.send(new PutCommand({
      TableName: T.messages,
      Item: { roomId, createdAt, uid, personaIndex, authorType, phase, text },
    }));
    return { createdAt };
  },
  async byPhase(roomId, phase) {
    // Query by HASH (roomId) + sort by createdAt, then filter by phase
    const { Items } = await ddb.send(new QueryCommand({
      TableName: T.messages,
      KeyConditionExpression: "roomId = :r",
      ExpressionAttributeValues: { ":r": roomId },
      ScanIndexForward: true,
    }));
    return (Items||[]).filter(x => (x.phase||"") === phase);
  },
};

export const Drafts = {
  async add({ roomId, content, version }) {
    await ddb.send(new PutCommand({
      TableName: T.drafts,
      Item: { roomId, createdAt: nowMs(), content, version },
    }));
  },
  async latest(roomId) {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: T.drafts,
      KeyConditionExpression: "roomId = :r",
      ExpressionAttributeValues: { ":r": roomId },
      ScanIndexForward: false,
      Limit: 1,
    }));
    return (Items && Items[0]) || null;
  },
};
