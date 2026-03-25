#!/usr/bin/env node

import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';

function parseArgs(argv) {
  const out = {
    apply: false,
    region: process.env.AWS_REGION || 'us-west-2',
    endpoint: process.env.AWS_DYNAMO_ENDPOINT || undefined,
  };

  for (let i = 2; i < argv.length; i++) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--apply') {
      out.apply = true;
      continue;
    }

    if (token === '--dry-run') {
      out.apply = false;
      continue;
    }

    if (token === '--region') {
      out.region = String(argv[i + 1] || out.region);
      i += 1;
      continue;
    }

    if (token === '--endpoint') {
      out.endpoint = String(argv[i + 1] || out.endpoint || '');
      i += 1;
      continue;
    }
  }

  return out;
}

const args = parseArgs(process.argv);

const TABLES = {
  codes: process.env.DDB_TABLE_CODES || process.env.TABLE_CODES || 'storibloom_codes',
  rooms: process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  messages: process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  drafts: process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  workshops: process.env.DDB_TABLE_WORKSHOPS || 'storibloom_workshops',
  gallery: process.env.DDB_TABLE_GALLERY || 'storibloom_gallery',
  sessions: process.env.DDB_TABLE_SESSIONS || 'storibloom_sessions',
  authSessions: process.env.DDB_TABLE_AUTH_SESSIONS || 'storibloom_auth_sessions',
  audit: process.env.DDB_TABLE_AUDIT || 'storibloom_audit',
  orgs: process.env.DDB_TABLE_ORGS || 'storibloom_orgs',
  orgUsers: process.env.DDB_TABLE_ORG_USERS || 'storibloom_org_users',
  licenses: process.env.DDB_TABLE_LICENSES || 'storibloom_licenses',
  featureFlags: process.env.DDB_TABLE_FEATURE_FLAGS || 'storibloom_feature_flags',
  policies: process.env.DDB_TABLE_POLICIES || 'storibloom_policies',
  templates: process.env.DDB_TABLE_TEMPLATES || 'storibloom_templates',
  approvals: process.env.DDB_TABLE_APPROVALS || 'storibloom_approvals',
  billing: process.env.DDB_TABLE_BILLING || 'storibloom_billing',
  support: process.env.DDB_TABLE_SUPPORT || 'storibloom_support',
  status: process.env.DDB_TABLE_STATUS || 'storibloom_status',
};

const TABLE_DEFS = [
  {
    key: 'codes',
    tableName: TABLES.codes,
    keySchema: [{ AttributeName: 'code', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'code', AttributeType: 'S' },
      { AttributeName: 'siteId', AttributeType: 'S' },
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'role', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'bySiteCreatedAt',
        KeySchema: [
          { AttributeName: 'siteId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byLicenseCreatedAt',
        KeySchema: [
          { AttributeName: 'licenseId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byRoleCreatedAt',
        KeySchema: [
          { AttributeName: 'role', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgCreatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'rooms',
    tableName: TABLES.rooms,
    keySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'siteId', AttributeType: 'S' },
      { AttributeName: 'index', AttributeType: 'N' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'bySiteIndex',
        KeySchema: [
          { AttributeName: 'siteId', KeyType: 'HASH' },
          { AttributeName: 'index', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'bySiteUpdatedAt',
        KeySchema: [
          { AttributeName: 'siteId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgUpdatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'messages',
    tableName: TABLES.messages,
    keySchema: [
      { AttributeName: 'roomId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'N' },
      { AttributeName: 'uid', AttributeType: 'S' },
    ],
    gsis: [
      {
        IndexName: 'byUidCreatedAt',
        KeySchema: [
          { AttributeName: 'uid', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
    ],
    ttlAttribute: 'expiresAt',
  },
  {
    key: 'drafts',
    tableName: TABLES.drafts,
    keySchema: [
      { AttributeName: 'roomId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'N' },
    ],
    gsis: [],
    ttlAttribute: 'expiresAt',
  },
  {
    key: 'workshops',
    tableName: TABLES.workshops,
    keySchema: [{ AttributeName: 'licenseId', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byOrgUpdatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'gallery',
    tableName: TABLES.gallery,
    keySchema: [
      { AttributeName: 'siteId', KeyType: 'HASH' },
      { AttributeName: 'closedAtRoom', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'siteId', AttributeType: 'S' },
      { AttributeName: 'closedAtRoom', AttributeType: 'S' },
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
    ],
    gsis: [
      {
        IndexName: 'byLicenseClosedAt',
        KeySchema: [
          { AttributeName: 'licenseId', KeyType: 'HASH' },
          { AttributeName: 'closedAtRoom', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgClosedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'closedAtRoom', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'sessions',
    tableName: TABLES.sessions,
    keySchema: [{ AttributeName: 'uid', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'uid', AttributeType: 'S' },
      { AttributeName: 'siteId', AttributeType: 'S' },
      { AttributeName: 'role', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'lastSeenAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'bySiteLastSeen',
        KeySchema: [
          { AttributeName: 'siteId', KeyType: 'HASH' },
          { AttributeName: 'lastSeenAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byRoleLastSeen',
        KeySchema: [
          { AttributeName: 'role', KeyType: 'HASH' },
          { AttributeName: 'lastSeenAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgLastSeen',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'lastSeenAt', KeyType: 'RANGE' },
        ],
      },
    ],
    ttlAttribute: 'expiresAt',
  },
  {
    key: 'authSessions',
    tableName: TABLES.authSessions,
    keySchema: [
      { AttributeName: 'uid', KeyType: 'HASH' },
      { AttributeName: 'sessionId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'uid', AttributeType: 'S' },
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byLicenseUpdatedAt',
        KeySchema: [
          { AttributeName: 'licenseId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgUpdatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
    ttlAttribute: 'expiresAt',
  },
  {
    key: 'audit',
    tableName: TABLES.audit,
    keySchema: [
      { AttributeName: 'scopeId', KeyType: 'HASH' },
      { AttributeName: 'createdAtAudit', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'scopeId', AttributeType: 'S' },
      { AttributeName: 'createdAtAudit', AttributeType: 'S' },
      { AttributeName: 'actorUid', AttributeType: 'S' },
      { AttributeName: 'action', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byActorCreatedAt',
        KeySchema: [
          { AttributeName: 'actorUid', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byActionCreatedAt',
        KeySchema: [
          { AttributeName: 'action', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byOrgCreatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'orgs',
    tableName: TABLES.orgs,
    keySchema: [{ AttributeName: 'orgId', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byStatusUpdatedAt',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'orgUsers',
    tableName: TABLES.orgUsers,
    keySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byEmailUpdatedAt',
        KeySchema: [
          { AttributeName: 'email', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'licenses',
    tableName: TABLES.licenses,
    keySchema: [{ AttributeName: 'licenseId', KeyType: 'HASH' }],
    attributeDefinitions: [
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byOrgUpdatedAt',
        KeySchema: [
          { AttributeName: 'orgId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byStatusUpdatedAt',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'featureFlags',
    tableName: TABLES.featureFlags,
    keySchema: [
      { AttributeName: 'scopeId', KeyType: 'HASH' },
      { AttributeName: 'flagKey', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'scopeId', AttributeType: 'S' },
      { AttributeName: 'flagKey', AttributeType: 'S' },
    ],
    gsis: [],
  },
  {
    key: 'policies',
    tableName: TABLES.policies,
    keySchema: [
      { AttributeName: 'scopeId', KeyType: 'HASH' },
      { AttributeName: 'policyType', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'scopeId', AttributeType: 'S' },
      { AttributeName: 'policyType', AttributeType: 'S' },
    ],
    gsis: [],
  },
  {
    key: 'templates',
    tableName: TABLES.templates,
    keySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'templateKey', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'templateKey', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
      { AttributeName: 'templateId', AttributeType: 'S' },
    ],
    gsis: [
      {
        IndexName: 'byStatusUpdatedAt',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byTemplateIdUpdatedAt',
        KeySchema: [
          { AttributeName: 'templateId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'approvals',
    tableName: TABLES.approvals,
    keySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'approvalId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'approvalId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'requestedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byStatusRequestedAt',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'requestedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'billing',
    tableName: TABLES.billing,
    keySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'billingEventId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'billingEventId', AttributeType: 'S' },
      { AttributeName: 'licenseId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'N' },
      { AttributeName: 'eventType', AttributeType: 'S' },
    ],
    gsis: [
      {
        IndexName: 'byLicenseCreatedAt',
        KeySchema: [
          { AttributeName: 'licenseId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
      {
        IndexName: 'byEventTypeCreatedAt',
        KeySchema: [
          { AttributeName: 'eventType', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'support',
    tableName: TABLES.support,
    keySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'ticketId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: 'S' },
      { AttributeName: 'ticketId', AttributeType: 'S' },
      { AttributeName: 'ticketStatus', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byTicketStatusUpdatedAt',
        KeySchema: [
          { AttributeName: 'ticketStatus', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
  {
    key: 'status',
    tableName: TABLES.status,
    keySchema: [
      { AttributeName: 'scopeId', KeyType: 'HASH' },
      { AttributeName: 'statusKey', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'scopeId', AttributeType: 'S' },
      { AttributeName: 'statusKey', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'N' },
    ],
    gsis: [
      {
        IndexName: 'byScopeUpdatedAt',
        KeySchema: [
          { AttributeName: 'scopeId', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
      },
    ],
  },
];

const ddb = new DynamoDBClient({
  region: args.region,
  ...(args.endpoint ? { endpoint: args.endpoint } : {}),
});

function keySchemaToString(schema = []) {
  return schema
    .map((entry) => `${entry.AttributeName}:${entry.KeyType}`)
    .join(', ');
}

function toAttrMap(defs = []) {
  const map = new Map();
  for (const def of defs) {
    map.set(def.AttributeName, def.AttributeType);
  }
  return map;
}

function buildGsiCreateSpec(gsi) {
  return {
    IndexName: gsi.IndexName,
    KeySchema: gsi.KeySchema,
    Projection: { ProjectionType: 'ALL' },
  };
}

async function describeTableSafe(tableName) {
  try {
    const out = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
    return out.Table || null;
  } catch (err) {
    if (err instanceof ResourceNotFoundException || err?.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

async function waitForTableActive(tableName, timeoutMs = 8 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const table = await describeTableSafe(tableName);
    if (!table) {
      await sleep(1200);
      continue;
    }
    const tableReady = table.TableStatus === 'ACTIVE';
    const indexes = Array.isArray(table.GlobalSecondaryIndexes)
      ? table.GlobalSecondaryIndexes
      : [];
    const indexesReady = indexes.every((idx) => idx.IndexStatus === 'ACTIVE');
    if (tableReady && indexesReady) return;
    await sleep(1400);
  }
  throw new Error(`Timed out waiting for table/indexes ACTIVE: ${tableName}`);
}

async function ensureTable(def) {
  const existing = await describeTableSafe(def.tableName);
  if (!existing) {
    if (!args.apply) {
      console.log(`[plan] create table ${def.tableName}`);
      return;
    }

    console.log(`[apply] creating table ${def.tableName}`);
    const createInput = {
      TableName: def.tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: def.keySchema,
      AttributeDefinitions: def.attributeDefinitions,
    };
    const gsiCreateSpecs = (def.gsis || []).map(buildGsiCreateSpec);
    if (gsiCreateSpecs.length) {
      createInput.GlobalSecondaryIndexes = gsiCreateSpecs;
    }
    await ddb.send(new CreateTableCommand(createInput));
    await waitForTableActive(def.tableName);

    if (def.ttlAttribute) {
      await ensureTtl(def.tableName, def.ttlAttribute);
    }
    return;
  }

  const existingKey = keySchemaToString(existing.KeySchema || []);
  const expectedKey = keySchemaToString(def.keySchema || []);
  if (existingKey !== expectedKey) {
    console.warn(
      `[warn] ${def.tableName} key schema mismatch. expected="${expectedKey}" actual="${existingKey}"`
    );
  }

  const existingIndexes = new Set(
    (existing.GlobalSecondaryIndexes || []).map((idx) => idx.IndexName)
  );
  const existingAttrs = toAttrMap(existing.AttributeDefinitions || []);

  for (const gsi of def.gsis || []) {
    if (existingIndexes.has(gsi.IndexName)) continue;

    if (!args.apply) {
      console.log(`[plan] add GSI ${def.tableName}.${gsi.IndexName}`);
      continue;
    }

    const attrsForIndex = [];
    const attrsForIndexSeen = new Set();
    for (const key of gsi.KeySchema || []) {
      const attrName = key.AttributeName;
      const desiredAttr = (def.attributeDefinitions || []).find(
        (x) => x.AttributeName === attrName
      );
      if (!desiredAttr) {
        throw new Error(`Missing attribute definition for ${def.tableName}.${attrName}`);
      }
      const existingType = existingAttrs.get(attrName);
      if (existingType && existingType !== desiredAttr.AttributeType) {
        throw new Error(
          `Attribute type mismatch for ${def.tableName}.${attrName}: expected ${desiredAttr.AttributeType}, actual ${existingType}`
        );
      }
      // DynamoDB UpdateTable for GSI creation may require all index key attrs
      // in AttributeDefinitions, including already-present attributes.
      if (!attrsForIndexSeen.has(attrName)) {
        attrsForIndex.push(desiredAttr);
        attrsForIndexSeen.add(attrName);
      }
      if (!existingType) {
        existingAttrs.set(attrName, desiredAttr.AttributeType);
      }
    }

    console.log(`[apply] adding GSI ${def.tableName}.${gsi.IndexName}`);
    const updateInput = {
      TableName: def.tableName,
      GlobalSecondaryIndexUpdates: [
        {
          Create: buildGsiCreateSpec(gsi),
        },
      ],
    };
    updateInput.AttributeDefinitions = attrsForIndex;
    await ddb.send(
      new UpdateTableCommand(updateInput)
    );
    await waitForTableActive(def.tableName);
  }

  if (def.ttlAttribute) {
    await ensureTtl(def.tableName, def.ttlAttribute);
  }
}

async function ensureTtl(tableName, ttlAttribute) {
  const ttl = await ddb.send(
    new DescribeTimeToLiveCommand({ TableName: tableName })
  );
  const desc = ttl.TimeToLiveDescription || {};
  const status = desc.TimeToLiveStatus || 'DISABLED';
  const currentAttr = desc.AttributeName || '';

  if (status === 'ENABLED' && currentAttr === ttlAttribute) {
    console.log(`[ok] TTL ${tableName}.${ttlAttribute} already enabled`);
    return;
  }

  if (status === 'ENABLED' && currentAttr && currentAttr !== ttlAttribute) {
    console.warn(
      `[warn] TTL for ${tableName} already enabled on '${currentAttr}', expected '${ttlAttribute}'`
    );
    return;
  }

  if (!args.apply) {
    console.log(`[plan] enable TTL ${tableName}.${ttlAttribute}`);
    return;
  }

  console.log(`[apply] enabling TTL ${tableName}.${ttlAttribute}`);
  await ddb.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: ttlAttribute,
      },
    })
  );
}

async function main() {
  console.log('Dynamo ensure plan');
  console.log({
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    region: args.region,
    endpoint: args.endpoint || '(aws)',
    tables: TABLES,
  });

  for (const def of TABLE_DEFS) {
    await ensureTable(def);
  }

  if (!args.apply) {
    console.log('\nDry run complete. Re-run with --apply to execute changes.');
  } else {
    console.log('\nApply complete.');
  }
}

main().catch((err) => {
  console.error('ensureDynamoTables failed:', err);
  process.exit(1);
});
