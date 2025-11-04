#!/usr/bin/env node
/**
 * Dump a quick summary of Sites, Rooms (by site), and Codes (presenter + first few participants).
 * Uses Scan + filters — fine for small seed sets.
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const argv = yargs(hideBin(process.argv))
  .option("region", { type: "string", default: process.env.AWS_REGION || "us-west-2" })
  .help()
  .argv;

const REGION = argv.region;

const T = {
  sites: process.env.DDB_TABLE_SITES || "storibloom_sites",
  rooms: process.env.DDB_TABLE_ROOMS || "storibloom_rooms",
  codes: process.env.DDB_TABLE_CODES || "storibloom_codes",
};

const ddb = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(ddb);

async function scanAll(tableName) {
  let items = [];
  let ExclusiveStartKey = undefined;
  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey })
    );
    items = items.concat(Items || []);
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const sites = await scanAll(T.sites);
  const rooms = await scanAll(T.rooms);
  const codes = await scanAll(T.codes);

  sites.sort((a, b) => a.siteId.localeCompare(b.siteId));
  rooms.sort((a, b) => a.roomId.localeCompare(b.roomId));
  codes.sort((a, b) => a.code.localeCompare(b.code));

  console.log("\n=== Sites ===");
  console.table(
    sites.map((s) => ({
      siteId: s.siteId,
      wave: s.wave,
      presenterCode: s.presenterCode,
    }))
  );

  console.log("\n=== Rooms (first 25) ===");
  console.table(
    rooms.slice(0, 25).map((r) => ({
      roomId: r.roomId,
      siteId: r.siteId,
      index: r.index,
      stage: r.stage,
    }))
  );

  console.log("\n=== Codes (presenters) ===");
  const presenterCodes = codes.filter((c) => c.role === "PRESENTER");
  console.table(
    presenterCodes.map((c) => ({ siteId: c.siteId, presenterCode: c.code }))
  );

  console.log("\n=== Example participant codes (first 10) ===");
  const participants = codes.filter((c) => c.role === "PARTICIPANT").slice(0, 10);
  console.table(participants.map((c) => ({ code: c.code, siteId: c.siteId })));

  console.log("\nTotals:");
  console.log({
    sites: sites.length,
    rooms: rooms.length,
    presenterCodes: presenterCodes.length,
    participantCodes: codes.filter((c) => c.role === "PARTICIPANT").length,
  });
  console.log("\nDone ✅");
}

main().catch((e) => {
  console.error("Dump failed:", e);
  process.exit(1);
});
