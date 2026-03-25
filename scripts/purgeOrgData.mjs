#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => {
      const [k, v] = String(arg).split('=');
      return [k.replace(/^--/, ''), v ?? true];
    })
);

const APPLY = args.apply === true || args.apply === 'true';
const ORG_ID = String(args.orgId || '').trim().toUpperCase();
const LICENSE_ID = String(args.licenseId || '').trim().toUpperCase();
const OUT_DIR = String(args.outDir || './artifacts').trim();
if (!ORG_ID && !LICENSE_ID) {
  console.error('Provide --orgId=ORG-... or --licenseId=LIC-...');
  process.exit(1);
}

const REGION = process.env.AWS_REGION || 'us-west-2';
const ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;
const TABLES = {
  workshops: process.env.DDB_TABLE_WORKSHOPS || 'storibloom_workshops',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  codes: process.env.DDB_TABLE_CODES || process.env.TABLE_CODES || 'storibloom_codes',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
  authSessions: process.env.DDB_TABLE_AUTH_SESSIONS || 'storibloom_auth_sessions',
  gallery: process.env.DDB_TABLE_GALLERY || 'storibloom_gallery',
  audit: process.env.DDB_TABLE_AUDIT || 'storibloom_audit',
};

const ddb = new DynamoDBClient({
  region: REGION,
  ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

function matchesTenant(item = {}) {
  const orgId = String(item.orgId || '').trim().toUpperCase();
  const licenseId = String(item.licenseId || '').trim().toUpperCase();
  if (ORG_ID && orgId === ORG_ID) return true;
  if (LICENSE_ID && licenseId === LICENSE_ID) return true;
  return false;
}

async function scanTable(tableName, limit = 30_000) {
  const out = [];
  let lastKey = undefined;
  while (out.length < limit) {
    const page = await ddbDoc.send(
      new ScanCommand({
        TableName: tableName,
        Limit: Math.min(200, limit - out.length),
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );
    if (Array.isArray(page.Items) && page.Items.length) out.push(...page.Items);
    lastKey = page.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return out;
}

function keyForTable(tableKey, item) {
  if (tableKey === 'workshops') return { licenseId: item.licenseId };
  if (tableKey === 'rooms') return { roomId: item.roomId };
  if (tableKey === 'messages' || tableKey === 'drafts') {
    return { roomId: item.roomId, createdAt: item.createdAt };
  }
  if (tableKey === 'codes') return { code: item.code };
  if (tableKey === 'sessions') return { uid: item.uid };
  if (tableKey === 'authSessions') return { uid: item.uid, sessionId: item.sessionId };
  if (tableKey === 'gallery') return { siteId: item.siteId, closedAtRoom: item.closedAtRoom };
  if (tableKey === 'audit') return { scopeId: item.scopeId, createdAtAudit: item.createdAtAudit };
  return null;
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    apply: APPLY,
    orgId: ORG_ID || null,
    licenseId: LICENSE_ID || null,
    results: {},
  };

  for (const [tableKey, tableName] of Object.entries(TABLES)) {
    let scanned = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      scanned = await scanTable(tableName);
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        report.results[tableKey] = { tableName, missing: true, scanned: 0, matched: 0, deleted: 0 };
        continue;
      }
      throw err;
    }

    const matched = scanned.filter((item) => matchesTenant(item));
    let deleted = 0;
    if (APPLY) {
      for (const item of matched) {
        const key = keyForTable(tableKey, item);
        if (!key) continue;
        // eslint-disable-next-line no-await-in-loop
        await ddbDoc.send(new DeleteCommand({ TableName: tableName, Key: key }));
        deleted += 1;
      }
    }

    report.results[tableKey] = {
      tableName,
      missing: false,
      scanned: scanned.length,
      matched: matched.length,
      deleted,
    };
  }

  report.completedAt = new Date().toISOString();
  report.proofId = crypto.randomUUID();
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(
    OUT_DIR,
    `tenant-purge-proof-${report.proofId}.json`
  );
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, summary: report.results }, null, 2));
}

main().catch((err) => {
  console.error('[purge-org-data] failed:', err);
  process.exit(1);
});
