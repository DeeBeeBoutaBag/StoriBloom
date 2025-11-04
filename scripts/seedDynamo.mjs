#!/usr/bin/env node
/**
 * Seed DynamoDB with Sites, Rooms, and Codes for StoriBloom.AI
 * - 9 sites: 4 East (E1..E4), 1 Central (C1), 4 West (W1..W4)
 * - 5 rooms per site: <SITE>-1 ... <SITE>-5
 * - 1 presenter code per site: P-xxxxxxxx
 * - 50 participant codes per site: U-xxxxxxxx
 *
 * Tables (env or defaults):
 *   DDB_TABLE_SITES        = storibloom_sites      (PK: siteId)
 *   DDB_TABLE_ROOMS        = storibloom_rooms      (PK: roomId, GSI bySite (siteId,index))
 *   DDB_TABLE_CODES        = storibloom_codes      (PK: code,  GSI bySiteRole (siteId, role))
 *
 * Region (env or CLI): AWS_REGION / --region us-west-2
 *
 * Usage:
 *   node scripts/seedDynamo.mjs
 *   node scripts/seedDynamo.mjs --region us-west-2 --rooms 5 --codes 50
 *
 * Output:
 *   - Prints a clean table to console
 *   - Writes CSVs under seed-output/<timestamp>/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CLI / ENV ----------
const argv = yargs(hideBin(process.argv))
  .option("region", { type: "string", default: process.env.AWS_REGION || "us-west-2" })
  .option("rooms", { type: "number", default: 5, describe: "Rooms per site" })
  .option("codes", { type: "number", default: 50, describe: "Participant codes per site" })
  .help()
  .argv;

const REGION = argv.region;
const ROOMS_PER_SITE = argv.rooms;
const PARTICIPANT_CODES_PER_SITE = argv.codes;

// Table names (allow override via env)
const T = {
  sites: process.env.DDB_TABLE_SITES || "storibloom_sites",
  rooms: process.env.DDB_TABLE_ROOMS || "storibloom_rooms",
  codes: process.env.DDB_TABLE_CODES || "storibloom_codes",
};

// ---------- AWS Clients ----------
const ddb = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

// ---------- Data Model ----------
const waves = {
  A: ["E1", "E2", "E3", "E4"],
  B: ["C1"],
  C: ["W1", "W2", "W3", "W4"],
};
const allSites = [...waves.A, ...waves.B, ...waves.C];

function waveOf(siteId) {
  if (waves.A.includes(siteId)) return "A";
  if (waves.B.includes(siteId)) return "B";
  if (waves.C.includes(siteId)) return "C";
  return "A";
}

function code(prefix = "U") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function nowMs() {
  return Date.now();
}

// ---------- Helpers ----------
async function putSite(siteId, presenterCode) {
  const item = {
    siteId,
    wave: waveOf(siteId),
    presenterCode,
    createdAt: nowMs(),
  };
  await doc.send(
    new PutCommand({
      TableName: T.sites,
      Item: item,
    })
  );
  return item;
}

// Batch write (max 25 per batch)
async function batchWrite(tableName, items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) {
    chunks.push(items.slice(i, i + 25));
  }
  for (const chunk of chunks) {
    const params = {
      RequestItems: {
        [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })),
      },
    };
    await doc.send(new BatchWriteCommand(params));
  }
}

async function seedRooms(siteId) {
  const items = [];
  for (let i = 1; i <= ROOMS_PER_SITE; i++) {
    items.push({
      roomId: `${siteId}-${i}`,
      siteId,
      index: i,
      stage: "LOBBY",
      createdAt: nowMs(),
    });
  }
  await batchWrite(T.rooms, items);
  return items;
}

async function seedCodes(siteId, presenterCode) {
  // 1 presenter code (already generated in SITE)
  const codes = [
    {
      code: presenterCode,
      siteId,
      role: "PRESENTER",
      consumed: false,
      createdAt: nowMs(),
    },
  ];
  // N participant codes
  for (let i = 0; i < PARTICIPANT_CODES_PER_SITE; i++) {
    codes.push({
      code: code("U"),
      siteId,
      role: "PARTICIPANT",
      consumed: false,
      createdAt: nowMs(),
    });
  }
  await batchWrite(T.codes, codes);
  return codes;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toCSV(rows, headers) {
  const esc = (s) =>
    typeof s === "string"
      ? `"${s.replace(/"/g, '""')}"`
      : s === undefined || s === null
      ? ""
      : String(s);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join(
    "\n"
  );
}

async function main() {
  console.log(`Seeding ${allSites.length} sites… (region: ${REGION})`);
  const outDir = path.join(__dirname, "..", "seed-output", String(nowMs()));
  fs.mkdirSync(outDir, { recursive: true });

  const summary = [];

  for (const siteId of allSites) {
    const presenterCode = code("P");
    const site = await putSite(siteId, presenterCode);
    const rooms = await seedRooms(siteId);
    const codes = await seedCodes(siteId, presenterCode);

    summary.push({
      siteId,
      wave: site.wave,
      presenterCode,
      roomsCount: rooms.length,
      participantCodes: codes.filter((c) => c.role === "PARTICIPANT").length,
    });

    // Write CSVs per site for convenience
    fs.writeFileSync(
      path.join(outDir, `rooms_${siteId}.csv`),
      toCSV(
        rooms.map((r) => ({ roomId: r.roomId, siteId: r.siteId, index: r.index, stage: r.stage })),
        ["roomId", "siteId", "index", "stage"]
      ),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, `codes_${siteId}.csv`),
      toCSV(
        codes.map((c) => ({ code: c.code, role: c.role, siteId: c.siteId })),
        ["code", "role", "siteId"]
      ),
      "utf8"
    );
  }

  // Master CSVs
  fs.writeFileSync(
    path.join(outDir, `sites.csv`),
    toCSV(summary, ["siteId", "wave", "presenterCode", "roomsCount", "participantCodes"]),
    "utf8"
  );

  // Pretty console print
  console.log("\n=== Sites Seeded ===");
  console.table(summary);

  console.log("\nCSV output →", outDir);
  console.log("• sites.csv");
  for (const s of allSites) {
    console.log(`• rooms_${s}.csv • codes_${s}.csv`);
  }

  console.log("\nDone ✅");
}

main().catch((err) => {
  console.error("Seeder failed:", err);
  process.exit(1);
});
