#!/usr/bin/env node

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'us-west-2';
const ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;

const TABLES = {
  workshops: process.env.DDB_TABLE_WORKSHOPS || 'storibloom_workshops',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  codes: process.env.DDB_TABLE_CODES || process.env.TABLE_CODES || 'storibloom_codes',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
  gallery: process.env.DDB_TABLE_GALLERY || 'storibloom_gallery',
  licenses: process.env.DDB_TABLE_LICENSES || 'storibloom_licenses',
};

const CODE_TTL_DAYS = Math.max(1, Number(process.env.CODE_TTL_DAYS || 30));
const APPLY = process.argv.includes('--apply');

const ddb = new DynamoDBClient({
  region: REGION,
  ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

function normalizedSiteId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedLicenseId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedOrgId(value, fallbackLicenseId = '') {
  const direct = String(value || '').trim().toUpperCase();
  if (direct) return direct;
  const license = normalizedLicenseId(fallbackLicenseId);
  if (!license) return '';
  return `ORG-${license}`;
}

function parseRoomId(roomId) {
  const [siteId] = String(roomId || '').split('-');
  return { siteId: normalizedSiteId(siteId || 'E1') };
}

async function scanAll(tableName, limit = 10_000) {
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
    if (Array.isArray(page.Items)) out.push(...page.Items);
    lastKey = page.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return out;
}

async function main() {
  console.log('[tenant-backfill] mode:', APPLY ? 'APPLY' : 'DRY_RUN');
  const workshops = await scanAll(TABLES.workshops, 5000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });

  const siteToLicense = new Map();
  for (const workshop of workshops) {
    const licenseId = normalizedLicenseId(workshop.licenseId || '');
    if (!licenseId) continue;
    const sites = Array.isArray(workshop.siteIds)
      ? workshop.siteIds.map(normalizedSiteId).filter(Boolean)
      : [];
    for (const site of sites) {
      if (!siteToLicense.has(site)) siteToLicense.set(site, licenseId);
    }
  }

  const ops = [];

  for (const workshop of workshops) {
    const licenseId = normalizedLicenseId(workshop.licenseId || '');
    if (!licenseId) continue;
    const orgId = normalizedOrgId(workshop.orgId || '', licenseId);
    const status = ['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(
      String(workshop.licenseStatus || '').trim().toUpperCase()
    )
      ? String(workshop.licenseStatus || '').trim().toUpperCase()
      : 'ACTIVE';
    const sites = Array.isArray(workshop.siteIds)
      ? Array.from(new Set(workshop.siteIds.map(normalizedSiteId).filter(Boolean)))
      : [];
    const expectedUsers = Math.max(1, Number(workshop.expectedUsers || 30));
    const activeUserCap = Math.max(
      1,
      Number(workshop.activeUserCap || expectedUsers)
    );
    ops.push({
      table: TABLES.workshops,
      key: { licenseId },
      names: {
        '#orgId': 'orgId',
        '#licenseStatus': 'licenseStatus',
        '#siteIds': 'siteIds',
        '#activeUserCap': 'activeUserCap',
      },
      values: {
        ':orgId': orgId,
        ':status': status,
        ':siteIds': sites,
        ':activeUserCap': activeUserCap,
      },
      update:
        'SET #orgId = :orgId, #licenseStatus = :status, #siteIds = :siteIds, #activeUserCap = :activeUserCap',
    });
  }

  const rooms = await scanAll(TABLES.rooms, 20_000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });
  for (const room of rooms) {
    const roomId = String(room.roomId || '').trim();
    if (!roomId) continue;
    const siteId = normalizedSiteId(room.siteId || parseRoomId(roomId).siteId);
    const licenseId = normalizedLicenseId(room.licenseId || siteToLicense.get(siteId) || siteId);
    const orgId = normalizedOrgId(room.orgId || '', licenseId);
    ops.push({
      table: TABLES.rooms,
      key: { roomId },
      names: { '#siteId': 'siteId', '#licenseId': 'licenseId', '#orgId': 'orgId' },
      values: { ':siteId': siteId, ':licenseId': licenseId, ':orgId': orgId },
      update: 'SET #siteId = :siteId, #licenseId = :licenseId, #orgId = :orgId',
    });
  }

  const codes = await scanAll(TABLES.codes, 20_000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });
  for (const code of codes) {
    const codeValue = String(code.code || '').trim();
    if (!codeValue) continue;
    const siteId = normalizedSiteId(code.siteId || '');
    const licenseId = normalizedLicenseId(code.licenseId || siteToLicense.get(siteId) || siteId);
    const orgId = normalizedOrgId(code.orgId || '', licenseId);
    const createdAt = Number(code.createdAt || Date.now());
    const expiresAt =
      Number(code.expiresAt || 0) > 0
        ? Number(code.expiresAt)
        : createdAt + CODE_TTL_DAYS * 24 * 60 * 60 * 1000;
    ops.push({
      table: TABLES.codes,
      key: { code: codeValue },
      names: {
        '#licenseId': 'licenseId',
        '#orgId': 'orgId',
        '#expiresAt': 'expiresAt',
        '#revoked': 'revoked',
      },
      values: {
        ':licenseId': licenseId,
        ':orgId': orgId,
        ':expiresAt': expiresAt,
        ':revoked': !!code.revoked,
      },
      update:
        'SET #licenseId = :licenseId, #orgId = :orgId, #expiresAt = :expiresAt, #revoked = :revoked',
    });
  }

  const sessions = await scanAll(TABLES.sessions, 20_000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });
  for (const session of sessions) {
    const uid = String(session.uid || '').trim();
    if (!uid) continue;
    const licenseId = normalizedLicenseId(session.licenseId || '');
    if (!licenseId) continue;
    const orgId = normalizedOrgId(session.orgId || '', licenseId);
    ops.push({
      table: TABLES.sessions,
      key: { uid },
      names: { '#orgId': 'orgId' },
      values: { ':orgId': orgId },
      update: 'SET #orgId = :orgId',
    });
  }

  const gallery = await scanAll(TABLES.gallery, 20_000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });
  for (const item of gallery) {
    const siteId = normalizedSiteId(item.siteId || '');
    const closedAtRoom = String(item.closedAtRoom || '').trim();
    if (!siteId || !closedAtRoom) continue;
    const licenseId = normalizedLicenseId(item.licenseId || siteToLicense.get(siteId) || siteId);
    const orgId = normalizedOrgId(item.orgId || '', licenseId);
    ops.push({
      table: TABLES.gallery,
      key: { siteId, closedAtRoom },
      names: { '#licenseId': 'licenseId', '#orgId': 'orgId' },
      values: { ':licenseId': licenseId, ':orgId': orgId },
      update: 'SET #licenseId = :licenseId, #orgId = :orgId',
    });
  }

  const licenses = await scanAll(TABLES.licenses, 20_000).catch((err) => {
    if (err?.name === 'ResourceNotFoundException') return [];
    throw err;
  });
  for (const license of licenses) {
    const licenseId = normalizedLicenseId(license.licenseId || '');
    if (!licenseId) continue;
    const orgId = normalizedOrgId(license.orgId || '', licenseId);
    ops.push({
      table: TABLES.licenses,
      key: { licenseId },
      names: { '#orgId': 'orgId' },
      values: { ':orgId': orgId },
      update: 'SET #orgId = :orgId',
    });
  }

  console.log(`[tenant-backfill] planned updates: ${ops.length}`);
  if (!APPLY) {
    console.log('[tenant-backfill] dry run complete. Re-run with --apply to write changes.');
    return;
  }

  let applied = 0;
  for (const op of ops) {
    // eslint-disable-next-line no-await-in-loop
    await ddbDoc.send(
      new UpdateCommand({
        TableName: op.table,
        Key: op.key,
        UpdateExpression: op.update,
        ExpressionAttributeNames: op.names,
        ExpressionAttributeValues: op.values,
      })
    );
    applied += 1;
    if (applied % 250 === 0) {
      console.log(`[tenant-backfill] applied ${applied}/${ops.length}`);
    }
  }
  console.log(`[tenant-backfill] applied ${applied} updates`);
}

main().catch((err) => {
  console.error('[tenant-backfill] failed:', err);
  process.exit(1);
});
